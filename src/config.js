import path from 'node:path';
import 'dotenv/config';

const SUPPORTED_API_MODES = new Set(['backend-api', 'openai', 'cryptosmi']);
const BACKEND_ALIASES = new Map([
  ['g4f', 'free'],
  ['codex', 'chatgpt'],
]);
const SUPPORTED_BACKENDS = new Set(['free', 'chatgpt', 'claude', 'gemini', 'gigachat']);
const DEFAULT_TARIFFS = [
  {
    id: 'starter',
    name: 'Старт',
    description: 'Для редких обращений и тестов.',
    priceText: '0 ₽',
    monthlyTokens: 50_000,
    isPublic: true,
  },
  {
    id: 'plus',
    name: 'Плюс',
    description: 'Для ежедневной работы с ботом.',
    priceText: '990 ₽',
    monthlyTokens: 300_000,
    isPublic: true,
  },
  {
    id: 'pro',
    name: 'Про',
    description: 'Для активного использования и длинных диалогов.',
    priceText: '3 990 ₽',
    monthlyTokens: 1_500_000,
    isPublic: true,
  },
];

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function trimTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

function parseStringList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBackendId(value, fallback = 'free') {
  const normalized = String(value ?? '').trim().toLowerCase();

  if (!normalized) {
    return fallback;
  }

  return BACKEND_ALIASES.get(normalized) ?? normalized;
}

function buildApiConfig(prefix, defaults = {}) {
  return {
    baseUrl: trimTrailingSlashes((process.env[`${prefix}_BASE_URL`] ?? '').trim()),
    mode: (process.env[`${prefix}_API_MODE`] ?? defaults.mode ?? 'backend-api').trim(),
    apiKey: (process.env[`${prefix}_API_KEY`] ?? '').trim(),
    model: (process.env[`${prefix}_MODEL`] ?? defaults.model ?? 'gpt-4o-mini').trim(),
    provider: (process.env[`${prefix}_PROVIDER`] ?? '').trim(),
    generatePath: (process.env[`${prefix}_GENERATE_PATH`] ?? defaults.generatePath ?? '/generate').trim() || '/generate',
    useResponses: parseBoolean(process.env[`${prefix}_USE_RESPONSES`], defaults.useResponses ?? false),
  };
}

function normalizeTariff(rawTariff, index) {
  const fallback = DEFAULT_TARIFFS[index] ?? DEFAULT_TARIFFS[0];
  const id = String(rawTariff?.id ?? fallback.id).trim().toLowerCase();

  if (!id) {
    throw new Error(`Invalid tariff config at index ${index}: missing id`);
  }

  return {
    id,
    name: String(rawTariff?.name ?? fallback.name).trim() || fallback.name,
    description: String(rawTariff?.description ?? fallback.description ?? '').trim(),
    priceText: String(rawTariff?.priceText ?? fallback.priceText ?? '').trim(),
    monthlyTokens: parseNonNegativeInt(rawTariff?.monthlyTokens, fallback.monthlyTokens),
    isPublic: rawTariff?.isPublic !== false,
  };
}

function parseTariffs(value) {
  if (!value?.trim()) {
    return DEFAULT_TARIFFS;
  }

  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid TARIFFS_JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('TARIFFS_JSON must be a non-empty JSON array');
  }

  const tariffs = parsed.map((tariff, index) => normalizeTariff(tariff, index));
  const ids = new Set();

  for (const tariff of tariffs) {
    if (ids.has(tariff.id)) {
      throw new Error(`Duplicate tariff id in TARIFFS_JSON: ${tariff.id}`);
    }

    ids.add(tariff.id);
  }

  return tariffs;
}

const tariffs = parseTariffs(process.env.TARIFFS_JSON ?? '');
const defaultTariffId = (process.env.DEFAULT_TARIFF_ID ?? tariffs[0]?.id ?? 'starter').trim().toLowerCase();
const antiApiBaseUrl = trimTrailingSlashes(
  (process.env.ANTI_API_BASE_URL ?? 'http://127.0.0.1:8964').trim() || 'http://127.0.0.1:8964',
);
const antiApiKey = (process.env.ANTI_API_API_KEY ?? '').trim();

export const config = {
  maxBotToken: (process.env.MAX_BOT_TOKEN ?? '').trim(),
  telegramBotToken: (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(),
  telegramProxyUrl: (process.env.TELEGRAM_PROXY_URL ?? '').trim(),
  systemPrompt: (process.env.SYSTEM_PROMPT ?? '').trim() || 'Ты полезный русскоязычный ассистент.',
  maxHistoryMessages: parsePositiveInt(process.env.MAX_HISTORY_MESSAGES, 12),
  requestTimeoutMs: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS ?? process.env.G4F_TIMEOUT_MS, 60_000),
  metricsFile: path.resolve(process.cwd(), (process.env.METRICS_FILE ?? 'data/bot-metrics.json').trim() || 'data/bot-metrics.json'),
  recentRequestsLimit: parsePositiveInt(process.env.RECENT_REQUESTS_LIMIT, 200),
  tokenCycleDays: parsePositiveInt(process.env.TOKEN_CYCLE_DAYS, 30),
  defaultBackend: normalizeBackendId(process.env.DEFAULT_BACKEND ?? 'free'),
  freeBackendId: 'free',
  tariffs,
  defaultTariffId,
  g4f: buildApiConfig('G4F', {
    mode: 'backend-api',
    model: 'gpt-4o-mini',
    generatePath: '/generate',
  }),
  codex: buildApiConfig('CODEX', {
    mode: 'openai',
    model: 'gpt-5.3-codex',
    generatePath: '/generate',
    useResponses: true,
  }),
  antiClaude: {
    baseUrl: antiApiBaseUrl,
    mode: 'openai',
    apiKey: antiApiKey,
    model: (process.env.ANTI_API_CLAUDE_MODEL ?? 'route:claude').trim(),
    provider: '',
    generatePath: '/generate',
    useResponses: false,
  },
  antiGemini: {
    baseUrl: antiApiBaseUrl,
    mode: 'openai',
    apiKey: antiApiKey,
    model: (process.env.ANTI_API_GEMINI_MODEL ?? 'gemini-3.1-pro-high').trim(),
    provider: '',
    generatePath: '/generate',
    useResponses: false,
  },
  gigachat: {
    oauthUrl: (
      process.env.GIGACHAT_OAUTH_URL
      ?? 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth'
    ).trim(),
    baseUrl: trimTrailingSlashes(
      (
        process.env.GIGACHAT_BASE_URL
        ?? 'https://gigachat.devices.sberbank.ru/api/v1'
      ).trim(),
    ),
    authKey: (process.env.GIGACHAT_AUTH_KEY ?? '').trim(),
    model: (process.env.GIGACHAT_MODEL ?? 'GigaChat-2-Pro').trim(),
    scope: (process.env.GIGACHAT_SCOPE ?? 'GIGACHAT_API_PERS').trim(),
    rejectUnauthorized: parseBoolean(process.env.GIGACHAT_REJECT_UNAUTHORIZED, true),
  },
  saluteSpeech: {
    oauthUrl: (
      process.env.SALUTESPEECH_OAUTH_URL
      ?? 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth'
    ).trim(),
    recognizeUrl: (
      process.env.SALUTESPEECH_RECOGNIZE_URL
      ?? 'https://smartspeech.sber.ru/rest/v1/speech:recognize'
    ).trim(),
    authKey: (process.env.SALUTESPEECH_AUTH_KEY ?? '').trim(),
    scope: (process.env.SALUTESPEECH_SCOPE ?? 'SALUTE_SPEECH_PERS').trim(),
    rejectUnauthorized: parseBoolean(process.env.SALUTESPEECH_REJECT_UNAUTHORIZED, true),
  },
  codexSessionFile: path.resolve(
    process.cwd(),
    (process.env.CODEX_SESSION_FILE ?? 'data/codex-sessions.json').trim() || 'data/codex-sessions.json',
  ),
  admin: {
    host: (process.env.ADMIN_HOST ?? '127.0.0.1').trim() || '127.0.0.1',
    port: parsePositiveInt(process.env.ADMIN_PORT, 3477),
    username: (process.env.ADMIN_USERNAME ?? 'admin').trim() || 'admin',
    password: (process.env.ADMIN_PASSWORD ?? '').trim(),
  },
  paymentRequests: {
    telegramChatIds: parseStringList(
      process.env.PAYMENT_REQUEST_TELEGRAM_CHAT_ID
      ?? process.env.PAYMENT_REQUEST_CHAT_ID
      ?? '',
    ),
  },
  privateBackends: {
    userIds: parseStringList(
      process.env.PRIVATE_BACKEND_USER_IDS
      ?? process.env.OWNER_USER_IDS
      ?? '',
    ),
  },
};

export function validateConfig() {
  const missing = [];

  if (!config.maxBotToken) {
    missing.push('MAX_BOT_TOKEN');
  }

  if (!config.g4f.baseUrl) {
    missing.push('G4F_BASE_URL');
  }

  if (!config.codex.baseUrl) {
    missing.push('CODEX_BASE_URL');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (!SUPPORTED_BACKENDS.has(config.defaultBackend)) {
    throw new Error(
      `Unsupported DEFAULT_BACKEND "${config.defaultBackend}". Use one of: ${Array.from(SUPPORTED_BACKENDS).join(', ')}`,
    );
  }

  if (!SUPPORTED_API_MODES.has(config.g4f.mode)) {
    throw new Error(
      `Unsupported G4F_API_MODE "${config.g4f.mode}". Use one of: ${Array.from(SUPPORTED_API_MODES).join(', ')}`,
    );
  }

  if (!SUPPORTED_API_MODES.has(config.codex.mode)) {
    throw new Error(
      `Unsupported CODEX_API_MODE "${config.codex.mode}". Use one of: ${Array.from(SUPPORTED_API_MODES).join(', ')}`,
    );
  }

  if (!config.tariffs.some((tariff) => tariff.id === config.defaultTariffId)) {
    throw new Error(
      `Unsupported DEFAULT_TARIFF_ID "${config.defaultTariffId}". Use one of: ${config.tariffs.map((tariff) => tariff.id).join(', ')}`,
    );
  }
}

export function validateTelegramConfig() {
  const missing = [];

  if (!config.telegramBotToken) {
    missing.push('TELEGRAM_BOT_TOKEN');
  }

  if (!config.g4f.baseUrl) {
    missing.push('G4F_BASE_URL');
  }

  if (!config.codex.baseUrl) {
    missing.push('CODEX_BASE_URL');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (!SUPPORTED_BACKENDS.has(config.defaultBackend)) {
    throw new Error(
      `Unsupported DEFAULT_BACKEND "${config.defaultBackend}". Use one of: ${Array.from(SUPPORTED_BACKENDS).join(', ')}`,
    );
  }

  if (!SUPPORTED_API_MODES.has(config.g4f.mode)) {
    throw new Error(
      `Unsupported G4F_API_MODE "${config.g4f.mode}". Use one of: ${Array.from(SUPPORTED_API_MODES).join(', ')}`,
    );
  }

  if (!SUPPORTED_API_MODES.has(config.codex.mode)) {
    throw new Error(
      `Unsupported CODEX_API_MODE "${config.codex.mode}". Use one of: ${Array.from(SUPPORTED_API_MODES).join(', ')}`,
    );
  }

  if (!config.tariffs.some((tariff) => tariff.id === config.defaultTariffId)) {
    throw new Error(
      `Unsupported DEFAULT_TARIFF_ID "${config.defaultTariffId}". Use one of: ${config.tariffs.map((tariff) => tariff.id).join(', ')}`,
    );
  }
}

export function validateAdminConfig() {
  const missing = [];

  if (!config.admin.username) {
    missing.push('ADMIN_USERNAME');
  }

  if (!config.admin.password) {
    missing.push('ADMIN_PASSWORD');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
