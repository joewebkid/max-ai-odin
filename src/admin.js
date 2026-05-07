import http from 'node:http';
import crypto from 'node:crypto';
import { config, validateAdminConfig } from './config.js';
import { MetricsStore, buildQuotaInfo, readMetricsSnapshot } from './metrics-store.js';

validateAdminConfig();

const metrics = new MetricsStore(
  config.metricsFile,
  config.recentRequestsLimit,
  config.tariffs,
  config.defaultTariffId,
  config.tokenCycleDays,
);

await metrics.init();

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuth(header) {
  if (!header?.startsWith('Basic ')) {
    return null;
  }

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');

    if (separatorIndex < 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function authorize(request, response) {
  const credentials = parseBasicAuth(request.headers.authorization);

  if (
    credentials &&
    safeEqual(credentials.username, config.admin.username) &&
    safeEqual(credentials.password, config.admin.password)
  ) {
    return true;
  }

  response.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="MAX Bot Admin"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end('Authentication required');
  return false;
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  let body = '';

  for await (const chunk of request) {
    body += chunk;

    if (body.length > 64 * 1024) {
      throw new Error('Payload too large');
    }
  }

  if (!body.trim()) {
    return {};
  }

  return JSON.parse(body);
}

function emptyBackendTotals() {
  return {
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function sumBackendTotals(entries, backend) {
  const totals = emptyBackendTotals();

  for (const entry of Object.values(entries ?? {})) {
    const stats = entry?.backends?.[backend];

    if (!stats) {
      continue;
    }

    totals.requestCount += Number(stats.requestCount ?? 0);
    totals.successCount += Number(stats.successCount ?? 0);
    totals.errorCount += Number(stats.errorCount ?? 0);
    totals.promptTokens += Number(stats.promptTokens ?? 0);
    totals.completionTokens += Number(stats.completionTokens ?? 0);
    totals.totalTokens += Number(stats.totalTokens ?? 0);
  }

  return totals;
}

function normalizeCodexWindow(window) {
  if (!window) {
    return null;
  }

  const usedPercent = Math.max(0, Math.min(100, Number(window.used_percent ?? 0)));
  const resetAt = Number(window.reset_at ?? 0);

  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    limitWindowSeconds: Number(window.limit_window_seconds ?? 0) || null,
    resetAfterSeconds: Number(window.reset_after_seconds ?? 0) || null,
    resetAt: resetAt > 0 ? new Date(resetAt * 1000).toISOString() : null,
  };
}

function normalizeCodexRateLimit(details) {
  if (!details) {
    return null;
  }

  return {
    allowed: Boolean(details.allowed),
    limitReached: Boolean(details.limit_reached),
    primaryWindow: normalizeCodexWindow(details.primary_window),
    secondaryWindow: normalizeCodexWindow(details.secondary_window),
  };
}

function normalizeCodexCredits(credits) {
  if (!credits) {
    return null;
  }

  return {
    hasCredits: Boolean(credits.has_credits),
    unlimited: Boolean(credits.unlimited),
    balance: credits.balance ?? null,
  };
}

function normalizeCodexAdditionalLimits(additionalRateLimits) {
  if (!Array.isArray(additionalRateLimits)) {
    return [];
  }

  return additionalRateLimits.map((item) => ({
    quotaKey: item.quota_key ?? null,
    limitName: item.limit_name ?? 'limit',
    displayLabel: item.display_label ?? null,
    meteredFeature: item.metered_feature ?? '',
    rateLimit: normalizeCodexRateLimit(item.rate_limit),
  }));
}

function getCodexUsageUrl() {
  const url = new URL(config.codex.baseUrl);
  url.pathname = '/api/codex/usage';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function fetchCodexUsage() {
  if (!config.codex.baseUrl || !config.codex.apiKey) {
    return {
      status: 'unconfigured',
      source: null,
      fetchedAt: new Date().toISOString(),
      planType: null,
      rateLimit: null,
      credits: null,
      additionalRateLimits: [],
      hasAnyLimits: false,
      errorMessage: 'CODEX_BASE_URL or CODEX_API_KEY is missing',
    };
  }

  const source = getCodexUsageUrl();

  try {
    const response = await fetch(source, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.codex.apiKey}`,
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const additionalRateLimits = normalizeCodexAdditionalLimits(payload.additional_rate_limits);
    const rateLimit = normalizeCodexRateLimit(payload.rate_limit);
    const credits = normalizeCodexCredits(payload.credits);

    return {
      status: 'ok',
      source,
      fetchedAt: new Date().toISOString(),
      planType: payload.plan_type ?? null,
      rateLimit,
      credits,
      additionalRateLimits,
      hasAnyLimits: Boolean(rateLimit || credits || additionalRateLimits.length > 0),
      errorMessage: null,
    };
  } catch (error) {
    return {
      status: 'error',
      source,
      fetchedAt: new Date().toISOString(),
      planType: null,
      rateLimit: null,
      credits: null,
      additionalRateLimits: [],
      hasAnyLimits: false,
      errorMessage: error.message,
    };
  }
}

function buildViewModel(snapshot, codexUsage) {
  const tariffMap = new Map(config.tariffs.map((tariff) => [tariff.id, tariff]));
  const users = Object.values(snapshot.users ?? {}).map((user) => {
    const membership = snapshot.memberships?.[String(user.userId)] ?? {
      planId: config.defaultTariffId,
      manualTokenAdjustment: 0,
      isBlocked: false,
      cycleStartedAt: snapshot.updatedAt ?? new Date().toISOString(),
      cycleSpentTokens: 0,
    };
    const tariff = tariffMap.get(membership.planId) ?? tariffMap.get(config.defaultTariffId) ?? config.tariffs[0];
    const quota = buildQuotaInfo(membership, tariff, config.tokenCycleDays, snapshot.updatedAt ?? new Date().toISOString());

    return {
      ...user,
      ...quota,
    };
  }).sort((left, right) => (
    (right.lastSeenAt ?? '').localeCompare(left.lastSeenAt ?? '')
  ));

  const chats = Object.values(snapshot.chats ?? {}).sort((left, right) => (
    (right.lastSeenAt ?? '').localeCompare(left.lastSeenAt ?? '')
  ));
  const recentRequests = (snapshot.recentRequests ?? []).slice(0, snapshot.recentLimit ?? 200);
  const now = Date.now();
  const connectedWindowMs = 24 * 60 * 60 * 1000;
  const connectedUsers = users.filter((user) => now - Date.parse(user.lastSeenAt ?? 0) <= connectedWindowMs).length;
  const blockedUsers = users.filter((user) => user.isBlocked).length;
  const codexTotals = sumBackendTotals(snapshot.chats ?? {}, 'codex');

  return {
    updatedAt: snapshot.updatedAt,
    summary: {
      users: users.length,
      chats: chats.length,
      connectedUsers,
      blockedUsers,
      requests: snapshot.totals?.requestCount ?? 0,
      success: snapshot.totals?.successCount ?? 0,
      errors: snapshot.totals?.errorCount ?? 0,
      promptTokens: snapshot.totals?.promptTokens ?? 0,
      completionTokens: snapshot.totals?.completionTokens ?? 0,
      totalTokens: snapshot.totals?.totalTokens ?? 0,
    },
    codex: {
      ...codexTotals,
      status: codexUsage.status,
      source: codexUsage.source,
      fetchedAt: codexUsage.fetchedAt,
      planType: codexUsage.planType,
      rateLimit: codexUsage.rateLimit,
      credits: codexUsage.credits,
      additionalRateLimits: codexUsage.additionalRateLimits,
      hasAnyLimits: codexUsage.hasAnyLimits,
      errorMessage: codexUsage.errorMessage,
    },
    tariffs: config.tariffs,
    users,
    chats,
    recentRequests,
  };
}

function renderHtml() {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MAX Bot Admin</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f6fb;
        --panel: #ffffff;
        --text: #182033;
        --muted: #6a7489;
        --line: #dfe5f0;
        --accent: #2f6fed;
        --accent-soft: #eaf1ff;
        --good: #14804a;
        --bad: #c73636;
        --warn: #b26b00;
        --shadow: 0 18px 50px rgba(30, 42, 70, 0.08);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: linear-gradient(180deg, #eef3ff 0%, var(--bg) 24%, #f8f9fc 100%);
        color: var(--text);
        font: 14px/1.45 "Segoe UI", Tahoma, sans-serif;
      }
      .wrap {
        max-width: 1520px;
        margin: 0 auto;
        padding: 24px;
      }
      .hero {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
        margin-bottom: 20px;
      }
      .hero h1 {
        margin: 0 0 8px;
        font-size: 32px;
        line-height: 1.1;
      }
      .hero p {
        margin: 0;
        color: var(--muted);
        max-width: 860px;
      }
      .stamp {
        padding: 10px 14px;
        border-radius: 14px;
        background: var(--panel);
        box-shadow: var(--shadow);
        color: var(--muted);
        white-space: nowrap;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 18px;
      }
      .card, .panel {
        background: var(--panel);
        border: 1px solid rgba(223, 229, 240, 0.9);
        border-radius: 18px;
        box-shadow: var(--shadow);
      }
      .card { padding: 18px; }
      .card .label {
        color: var(--muted);
        margin-bottom: 8px;
      }
      .card .value {
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.03em;
      }
      .grid {
        display: grid;
        grid-template-columns: 1.2fr 0.8fr;
        gap: 18px;
      }
      .panel { overflow: hidden; }
      .panel header {
        padding: 16px 18px 10px;
        border-bottom: 1px solid var(--line);
      }
      .panel header h2 {
        margin: 0;
        font-size: 18px;
      }
      .panel header p {
        margin: 6px 0 0;
        color: var(--muted);
      }
      .panel-body {
        padding: 16px 18px 18px;
      }
      .table-wrap { overflow: auto; }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 12px 16px;
        text-align: left;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }
      th {
        position: sticky;
        top: 0;
        background: #fbfcff;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      tbody tr:hover { background: #fafcff; }
      .pill {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-weight: 600;
      }
      .pill.bad {
        background: #ffe9e9;
        color: var(--bad);
      }
      .pill.warn {
        background: #fff2d9;
        color: var(--warn);
      }
      .ok { color: var(--good); font-weight: 700; }
      .bad { color: var(--bad); font-weight: 700; }
      .muted { color: var(--muted); }
      .mono { font-family: Consolas, "SFMono-Regular", monospace; }
      .preview { max-width: 360px; white-space: normal; word-break: break-word; }
      .tariffs {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
      }
      .tariff {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px;
        background: #fbfcff;
      }
      .tariff h3 {
        margin: 0 0 6px;
        font-size: 18px;
      }
      .tariff .price {
        font-weight: 700;
        margin-bottom: 8px;
      }
      .controls {
        display: grid;
        gap: 8px;
        min-width: 250px;
      }
      .controls-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      select, input, button {
        font: inherit;
      }
      select, input[type="number"] {
        min-height: 36px;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid #cfd7e6;
        background: #fff;
      }
      button {
        min-height: 36px;
        padding: 8px 12px;
        border: none;
        border-radius: 10px;
        background: var(--accent);
        color: #fff;
        cursor: pointer;
      }
      button.secondary {
        background: #eef3ff;
        color: var(--accent);
      }
      button.danger {
        background: var(--bad);
      }
      .status-line {
        margin-bottom: 12px;
        color: var(--muted);
      }
      .codex-grid {
        display: grid;
        grid-template-columns: 0.95fr 1.05fr;
        gap: 18px;
      }
      .metric-strip {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .metric-box {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px;
        background: #fbfcff;
      }
      .metric-box .label {
        color: var(--muted);
        margin-bottom: 6px;
      }
      .metric-box .value {
        font-size: 24px;
        font-weight: 700;
        letter-spacing: -0.03em;
      }
      .codex-stack {
        display: grid;
        gap: 12px;
      }
      .limit-box {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px;
        background: #fbfcff;
      }
      .limit-box h3 {
        margin: 0 0 8px;
        font-size: 16px;
      }
      .limit-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
        color: var(--muted);
      }
      .progress {
        height: 10px;
        border-radius: 999px;
        background: #e8edf7;
        overflow: hidden;
      }
      .progress > span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, #2f6fed 0%, #6b9cff 100%);
      }
      .codex-note {
        color: var(--muted);
      }
      @media (max-width: 1260px) {
        .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .grid { grid-template-columns: 1fr; }
        .tariffs { grid-template-columns: 1fr; }
        .codex-grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 720px) {
        .wrap { padding: 16px; }
        .hero { flex-direction: column; }
        .cards { grid-template-columns: 1fr; }
        .metric-strip { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <section class="hero">
        <div>
          <h1>MAX Bot Admin</h1>
          <p>Управление ботом, тарифами и лимитами. Здесь видно, кто подключен, сколько токенов уже израсходовано, какой тариф стоит у пользователя и можно вручную добавлять или снимать квоту.</p>
        </div>
        <div class="stamp" id="updated-at">Обновление…</div>
      </section>

      <section class="cards" id="summary-cards"></section>

      <section class="panel" style="margin-bottom: 18px;">
        <header>
          <h2>Codex LB</h2>
          <p>Общая статистика использования <span class="mono">codex</span> ботом и живой остаток лимитов текущего API key в стиле <span class="mono">codex-lb</span>.</p>
        </header>
        <div class="panel-body">
          <div class="codex-grid">
            <div class="metric-strip" id="codex-metrics"></div>
            <div class="codex-stack" id="codex-limits"></div>
          </div>
        </div>
      </section>

      <section class="panel" style="margin-bottom: 18px;">
        <header>
          <h2>Тарифы</h2>
          <p>Эти тарифы доступны пользователю внутри бота через команду <span class="mono">/tariff</span>.</p>
        </header>
        <div class="panel-body">
          <div class="tariffs" id="tariffs"></div>
        </div>
      </section>

      <section class="panel" style="margin-bottom: 18px;">
        <header>
          <h2>Пользователи и лимиты</h2>
          <p>Можно менять тариф, добавлять или снимать токены, блокировать доступ и сбрасывать цикл расхода.</p>
        </header>
        <div class="panel-body">
          <div class="status-line" id="action-status">Готово к работе.</div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Пользователь</th>
                  <th>Тариф</th>
                  <th>Квота</th>
                  <th>Статистика</th>
                  <th>Управление</th>
                </tr>
              </thead>
              <tbody id="users-body"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="grid">
        <div class="panel">
          <header>
            <h2>Чаты</h2>
            <p>Какие чаты используют бота и как часто они к нему обращаются.</p>
          </header>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Чат</th>
                  <th>Тип</th>
                  <th>Backend</th>
                  <th>Запросы</th>
                  <th>Токены</th>
                </tr>
              </thead>
              <tbody id="chats-body"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <header>
            <h2>Последние запросы</h2>
            <p>Живой журнал запросов, ошибок и расхода токенов.</p>
          </header>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Статус</th>
                  <th>Пользователь</th>
                  <th>Backend</th>
                  <th>Токены</th>
                  <th>Запрос</th>
                </tr>
              </thead>
              <tbody id="requests-body"></tbody>
            </table>
          </div>
        </div>
      </section>
    </div>

    <script>
      let state = null;
      const formatNumber = (value) => new Intl.NumberFormat('ru-RU').format(Number(value || 0));
      const formatDate = (value) => value ? new Date(value).toLocaleString('ru-RU') : '—';
      const escapeHtml = (value) => String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

      function setStatus(text, isError = false) {
        const node = document.getElementById('action-status');
        node.textContent = text;
        node.className = 'status-line' + (isError ? ' bad' : '');
      }

      function backendBreakdown(backends) {
        const entries = Object.entries(backends || {}).filter(([, value]) => (value.requestCount || 0) > 0);
        if (entries.length === 0) return '<span class="muted">—</span>';
        return entries.map(([name, value]) => \`<div><span class="pill">\${escapeHtml(name)}</span> \${formatNumber(value.requestCount)} / \${formatNumber(value.totalTokens)}</div>\`).join('');
      }

      function renderSummary(summary) {
        const cards = [
          ['Пользователи', formatNumber(summary.users)],
          ['Чаты', formatNumber(summary.chats)],
          ['Активны за 24ч', formatNumber(summary.connectedUsers)],
          ['Заблокированы', formatNumber(summary.blockedUsers)],
          ['Всего запросов', formatNumber(summary.requests)],
          ['Успешных', formatNumber(summary.success)],
          ['Ошибок', formatNumber(summary.errors)],
          ['Все токены', formatNumber(summary.totalTokens)],
        ];

        document.getElementById('summary-cards').innerHTML = cards.map(([label, value]) => \`
          <article class="card">
            <div class="label">\${escapeHtml(label)}</div>
            <div class="value">\${escapeHtml(value)}</div>
          </article>
        \`).join('');
      }

      function renderTariffs(tariffs) {
        document.getElementById('tariffs').innerHTML = tariffs.map((tariff) => \`
          <article class="tariff">
            <h3>\${escapeHtml(tariff.name)}</h3>
            <div class="price">\${escapeHtml(tariff.priceText || 'Без цены')}</div>
            <div>\${formatNumber(tariff.monthlyTokens)} токенов / ${config.tokenCycleDays} дн.</div>
            <div class="muted" style="margin-top: 8px;">\${escapeHtml(tariff.description || '')}</div>
          </article>
        \`).join('');
      }

      function describeWindow(window) {
        if (!window) {
          return '<div class="codex-note">Нет данных по окну.</div>';
        }

        const resetText = window.resetAt ? formatDate(window.resetAt) : '—';
        const durationMinutes = window.limitWindowSeconds ? Math.round(window.limitWindowSeconds / 60) : null;

        return \`
          <div class="limit-meta">
            <span>Использовано: \${formatNumber(window.usedPercent)}%</span>
            <span>Осталось: \${formatNumber(window.remainingPercent)}%</span>
          </div>
          <div class="progress"><span style="width: \${Math.max(2, window.usedPercent)}%"></span></div>
          <div class="codex-note" style="margin-top: 8px;">
            Окно: \${durationMinutes ? durationMinutes + ' мин.' : '—'} · сброс: \${escapeHtml(resetText)}
          </div>
        \`;
      }

      function renderCodex(codex) {
        const metrics = [
          ['Запросы через codex', formatNumber(codex.requestCount)],
          ['Токены через codex', formatNumber(codex.totalTokens)],
          ['Успешно', formatNumber(codex.successCount)],
          ['Ошибки', formatNumber(codex.errorCount)],
        ];

        document.getElementById('codex-metrics').innerHTML = metrics.map(([label, value]) => \`
          <article class="metric-box">
            <div class="label">\${escapeHtml(label)}</div>
            <div class="value">\${escapeHtml(value)}</div>
          </article>
        \`).join('');

        const sections = [];
        const statusText = codex.status === 'ok'
          ? 'Данные получены'
          : codex.status === 'unconfigured'
            ? 'Не настроено'
            : 'Ошибка запроса';

        sections.push(\`
          <article class="limit-box">
            <h3>Состояние ключа</h3>
            <div class="limit-meta">
              <span><span class="pill">\${escapeHtml(statusText)}</span></span>
              <span class="muted">plan: \${escapeHtml(codex.planType || '—')}</span>
            </div>
            <div class="codex-note">Источник: \${escapeHtml(codex.source || '—')}</div>
            \${codex.errorMessage ? \`<div class="bad" style="margin-top: 8px;">\${escapeHtml(codex.errorMessage)}</div>\` : ''}
          </article>
        \`);

        if (codex.credits) {
          sections.push(\`
            <article class="limit-box">
              <h3>Credits</h3>
              <div class="limit-meta">
                <span>\${codex.credits.unlimited ? '<span class="pill">Unlimited</span>' : '<span class="pill warn">Limited</span>'}</span>
                <span class="\${codex.credits.hasCredits ? 'ok' : 'bad'}">\${codex.credits.hasCredits ? 'Есть остаток' : 'Лимит исчерпан'}</span>
              </div>
              <div class="value" style="font-size: 20px;">\${escapeHtml(codex.credits.balance || '—')}</div>
            </article>
          \`);
        }

        if (codex.rateLimit) {
          sections.push(\`
            <article class="limit-box">
              <h3>Primary Window</h3>
              <div class="limit-meta">
                <span>\${codex.rateLimit.allowed ? '<span class="pill">Allowed</span>' : '<span class="pill bad">Blocked</span>'}</span>
                <span>\${codex.rateLimit.limitReached ? '<span class="bad">Лимит достигнут</span>' : '<span class="ok">Лимит не достигнут</span>'}</span>
              </div>
              \${describeWindow(codex.rateLimit.primaryWindow)}
            </article>
          \`);

          if (codex.rateLimit.secondaryWindow) {
            sections.push(\`
              <article class="limit-box">
                <h3>Secondary Window</h3>
                \${describeWindow(codex.rateLimit.secondaryWindow)}
              </article>
            \`);
          }
        }

        if (codex.additionalRateLimits.length > 0) {
          sections.push(...codex.additionalRateLimits.map((item) => \`
            <article class="limit-box">
              <h3>\${escapeHtml(item.displayLabel || item.limitName)}</h3>
              <div class="codex-note">Feature: \${escapeHtml(item.meteredFeature || '—')}</div>
              \${describeWindow(item.rateLimit ? item.rateLimit.primaryWindow : null)}
            </article>
          \`));
        }

        if (!codex.hasAnyLimits && codex.status === 'ok') {
          sections.push(\`
            <article class="limit-box">
              <h3>Остаток лимитов</h3>
              <div class="codex-note">На текущем API key в <span class="mono">codex-lb</span> пока не настроены отдельные лимиты или credits. Как только вы зададите их в <span class="mono">codex-lb</span>, остатки появятся здесь автоматически.</div>
            </article>
          \`);
        }

        document.getElementById('codex-limits').innerHTML = sections.join('');
      }

      function renderUsers(users, tariffs) {
        const optionsHtml = (selectedId) => tariffs.map((tariff) => \`
          <option value="\${escapeHtml(tariff.id)}" \${tariff.id === selectedId ? 'selected' : ''}>
            \${escapeHtml(tariff.name)}
          </option>
        \`).join('');

        document.getElementById('users-body').innerHTML = users.map((user) => \`
          <tr>
            <td>
              <div><strong>\${escapeHtml(user.name || 'Без имени')}</strong></div>
              <div class="muted mono">id: \${escapeHtml(user.userId)}</div>
              <div class="muted">\${escapeHtml(user.username || '')}</div>
              <div class="muted">последняя активность: \${formatDate(user.lastSeenAt)}</div>
            </td>
            <td>
              <div><span class="pill">\${escapeHtml(user.planName || '—')}</span></div>
              <div class="muted">\${escapeHtml(user.planPriceText || '')}</div>
              <div class="muted">\${formatNumber(user.monthlyTokens)} токенов / цикл</div>
              <div class="muted">\${escapeHtml(user.planDescription || '')}</div>
              \${user.isBlocked ? '<div style="margin-top:8px;"><span class="pill bad">Заблокирован</span></div>' : ''}
            </td>
            <td>
              <div><strong>Осталось: \${formatNumber(user.remainingTokens)}</strong></div>
              <div class="muted">лимит: \${formatNumber(user.allowanceTokens)} / потрачено: \${formatNumber(user.cycleSpentTokens)}</div>
              <div class="muted">ручная корректировка: \${user.manualTokenAdjustment > 0 ? '+' : ''}\${formatNumber(user.manualTokenAdjustment)}</div>
              <div class="muted">сброс: \${formatDate(user.cycleEndsAt)}</div>
            </td>
            <td>
              <div>\${formatNumber(user.requestCount)} запросов</div>
              <div class="muted">ok: \${formatNumber(user.successCount)} / err: \${formatNumber(user.errorCount)}</div>
              <div class="muted">токены: \${formatNumber(user.totalTokens)}</div>
              <div class="muted">чатов: \${formatNumber((user.chatIds || []).length)}</div>
            </td>
            <td>
              <div class="controls">
                <div class="controls-row">
                  <select id="plan-\${escapeHtml(user.userId)}">\${optionsHtml(user.planId)}</select>
                  <button class="secondary" onclick="window.setPlan('\${escapeHtml(user.userId)}')">Сменить тариф</button>
                </div>
                <div class="controls-row">
                  <input id="delta-\${escapeHtml(user.userId)}" type="number" value="10000" step="1000" min="0">
                  <button class="secondary" onclick="window.adjustTokens('\${escapeHtml(user.userId)}', 1)">Добавить</button>
                  <button class="secondary" onclick="window.adjustTokens('\${escapeHtml(user.userId)}', -1)">Убрать</button>
                </div>
                <div class="controls-row">
                  <button class="\${user.isBlocked ? 'secondary' : 'danger'}" onclick="window.toggleBlock('\${escapeHtml(user.userId)}', \${user.isBlocked ? 'false' : 'true'})">
                    \${user.isBlocked ? 'Разблокировать' : 'Блокировать'}
                  </button>
                  <button class="secondary" onclick="window.resetCycle('\${escapeHtml(user.userId)}')">Сбросить цикл</button>
                </div>
              </div>
            </td>
          </tr>
        \`).join('');
      }

      function renderChats(chats) {
        document.getElementById('chats-body').innerHTML = chats.map((chat) => \`
          <tr>
            <td>
              <div><strong>\${escapeHtml(chat.title || 'Без названия')}</strong></div>
              <div class="muted mono">id: \${escapeHtml(chat.chatId)}</div>
            </td>
            <td>
              <div>\${escapeHtml(chat.type || '—')}</div>
              <div class="muted">\${escapeHtml(chat.status || '')}</div>
            </td>
            <td>\${backendBreakdown(chat.backends)}</td>
            <td>\${formatNumber(chat.requestCount)}</td>
            <td>\${formatNumber(chat.totalTokens)}</td>
          </tr>
        \`).join('');
      }

      function renderRequests(requests) {
        document.getElementById('requests-body').innerHTML = requests.map((item) => \`
          <tr>
            <td>\${formatDate(item.timestamp)}</td>
            <td class="\${item.success ? 'ok' : 'bad'}">\${item.success ? 'OK' : 'ERR'}</td>
            <td>
              <div><strong>\${escapeHtml(item.userName || '—')}</strong></div>
              <div class="muted mono">u:\${escapeHtml(item.userId || '—')}</div>
            </td>
            <td>
              <div><span class="pill">\${escapeHtml(item.backend || '—')}</span></div>
              <div class="muted">\${escapeHtml(item.model || '')}</div>
            </td>
            <td>\${formatNumber(item.totalTokens)}</td>
            <td class="preview">\${escapeHtml(item.success ? (item.requestPreview || '') : (item.errorMessage || ''))}</td>
          </tr>
        \`).join('');
      }

      async function refresh() {
        const response = await fetch('/api/stats', { cache: 'no-store' });
        const payload = await response.json();
        state = payload;
        renderSummary(payload.summary);
        renderCodex(payload.codex);
        renderTariffs(payload.tariffs);
        renderUsers(payload.users, payload.tariffs);
        renderChats(payload.chats);
        renderRequests(payload.recentRequests);
        document.getElementById('updated-at').textContent = 'Обновлено: ' + formatDate(payload.updatedAt);
      }

      async function postJson(url, body) {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body || {}),
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(payload.message || 'Request failed');
        }

        return payload;
      }

      window.setPlan = async (userId) => {
        try {
          const select = document.getElementById('plan-' + userId);
          await postJson('/api/users/' + userId + '/plan', { planId: select.value });
          setStatus('Тариф пользователя обновлен.');
          await refresh();
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.adjustTokens = async (userId, direction) => {
        try {
          const input = document.getElementById('delta-' + userId);
          const value = Number(input.value || 0);

          if (!Number.isFinite(value) || value <= 0) {
            throw new Error('Введите положительное число токенов.');
          }

          await postJson('/api/users/' + userId + '/tokens', { delta: value * direction });
          setStatus(direction > 0 ? 'Токены добавлены.' : 'Токены сняты.');
          await refresh();
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.toggleBlock = async (userId, blocked) => {
        try {
          await postJson('/api/users/' + userId + '/block', { blocked });
          setStatus(blocked ? 'Пользователь заблокирован.' : 'Пользователь разблокирован.');
          await refresh();
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.resetCycle = async (userId) => {
        try {
          await postJson('/api/users/' + userId + '/reset-cycle', {});
          setStatus('Цикл пользователя сброшен.');
          await refresh();
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      refresh().catch((error) => {
        setStatus('Ошибка загрузки: ' + error.message, true);
      });
      setInterval(() => refresh().catch(() => {}), 30000);
    </script>
  </body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  if (!authorize(request, response)) {
    return;
  }

  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end('ok');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/stats') {
      const snapshot = await readMetricsSnapshot(config.metricsFile, config.recentRequestsLimit);
      const codexUsage = await fetchCodexUsage();
      json(response, 200, buildViewModel(snapshot, codexUsage));
      return;
    }

    const match = url.pathname.match(/^\/api\/users\/(\d+)\/(plan|tokens|block|reset-cycle)$/);

    if (request.method === 'POST' && match) {
      const [, userId, action] = match;
      const body = await readJsonBody(request);

      if (action === 'plan') {
        const planId = String(body.planId ?? '').trim().toLowerCase();

        if (!config.tariffs.some((tariff) => tariff.id === planId)) {
          json(response, 400, {
            error: 'invalid_plan',
            message: `Unknown tariff: ${planId}`,
          });
          return;
        }

        const quota = await metrics.setUserPlan(userId, planId);
        json(response, 200, { ok: true, quota });
        return;
      }

      if (action === 'tokens') {
        const delta = Number(body.delta ?? 0);

        if (!Number.isFinite(delta) || delta === 0) {
          json(response, 400, {
            error: 'invalid_delta',
            message: 'Delta must be a non-zero number',
          });
          return;
        }

        const quota = await metrics.adjustUserTokens(userId, delta);
        json(response, 200, { ok: true, quota });
        return;
      }

      if (action === 'block') {
        const quota = await metrics.setUserBlocked(userId, Boolean(body.blocked));
        json(response, 200, { ok: true, quota });
        return;
      }

      const quota = await metrics.resetUserCycle(userId);
      json(response, 200, { ok: true, quota });
      return;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(renderHtml());
      return;
    }

    response.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end('Not found');
  } catch (error) {
    console.error('Admin request failed:', error);
    json(response, 500, {
      error: 'internal_error',
      message: error.message,
    });
  }
});

server.listen(config.admin.port, config.admin.host, () => {
  console.log(`Admin panel listening on http://${config.admin.host}:${config.admin.port}`);
});
