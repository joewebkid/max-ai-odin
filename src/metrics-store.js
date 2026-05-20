import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const QUOTA_FREE_BACKENDS = new Set(['free', 'g4f']);

function emptyBackendStats() {
  return {
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
  }

  const promptTokens = toNumber(
    usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens,
  );
  const completionTokens = toNumber(
    usage.completionTokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens,
  );
  const totalTokens = toNumber(
    usage.totalTokens ?? usage.total_tokens,
  ) || (promptTokens + completionTokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function createTariffMap(tariffs) {
  return Object.fromEntries(tariffs.map((tariff) => [tariff.id, tariff]));
}

function createEmptyState(recentLimit, tariffs, defaultTariffId) {
  return {
    schemaVersion: 2,
    updatedAt: null,
    defaultTariffId,
    tariffs,
    totals: {
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    users: {},
    chats: {},
    memberships: {},
    recentRequests: [],
    recentLimit,
  };
}

function createMembership(defaultTariffId, nowIso) {
  return {
    planId: defaultTariffId,
    manualTokenAdjustment: 0,
    isBlocked: false,
    cycleStartedAt: nowIso,
    cycleSpentTokens: 0,
    updatedAt: nowIso,
  };
}

function getCycleDurationMs(tokenCycleDays) {
  return tokenCycleDays * 24 * 60 * 60 * 1000;
}

function getCycleEndsAt(cycleStartedAt, tokenCycleDays) {
  const startMs = Date.parse(cycleStartedAt);

  if (!Number.isFinite(startMs)) {
    return new Date(Date.now() + getCycleDurationMs(tokenCycleDays)).toISOString();
  }

  return new Date(startMs + getCycleDurationMs(tokenCycleDays)).toISOString();
}

function isCycleExpired(cycleStartedAt, tokenCycleDays, nowMs = Date.now()) {
  const startMs = Date.parse(cycleStartedAt);

  if (!Number.isFinite(startMs)) {
    return true;
  }

  return nowMs >= (startMs + getCycleDurationMs(tokenCycleDays));
}

export function buildQuotaInfo(membership, tariff, tokenCycleDays, nowIso = new Date().toISOString()) {
  const monthlyTokens = toNumber(tariff?.monthlyTokens);
  const manualTokenAdjustment = toNumber(membership?.manualTokenAdjustment);
  const cycleSpentTokens = toNumber(membership?.cycleSpentTokens);
  const allowanceTokens = Math.max(0, monthlyTokens + manualTokenAdjustment);
  const remainingTokens = Math.max(0, allowanceTokens - cycleSpentTokens);

  return {
    planId: tariff?.id ?? membership?.planId ?? null,
    planName: tariff?.name ?? 'Без тарифа',
    planDescription: tariff?.description ?? '',
    planPriceText: tariff?.priceText ?? '',
    monthlyTokens,
    manualTokenAdjustment,
    allowanceTokens,
    cycleSpentTokens,
    remainingTokens,
    cycleStartedAt: membership?.cycleStartedAt ?? nowIso,
    cycleEndsAt: getCycleEndsAt(membership?.cycleStartedAt ?? nowIso, tokenCycleDays),
    isBlocked: Boolean(membership?.isBlocked),
  };
}

function ensureBackendStats(entry, backend) {
  if (!entry.backends) {
    entry.backends = {};
  }

  if (!entry.backends[backend]) {
    entry.backends[backend] = emptyBackendStats();
  }

  return entry.backends[backend];
}

function applyUsage(target, usage) {
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.totalTokens += usage.totalTokens;
}

function buildUserEntry(user, backend, nowIso) {
  return {
    userId: user.userId,
    platform: user.platform ?? 'unknown',
    name: user.name,
    username: user.username,
    isBot: user.isBot,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    lastBackend: backend,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    chatIds: [],
    backends: {
      [backend]: emptyBackendStats(),
    },
  };
}

function buildChatEntry(chat, backend, nowIso) {
  return {
    chatId: chat.chatId,
    platform: chat.platform ?? 'unknown',
    type: chat.type,
    title: chat.title,
    status: chat.status,
    isPublic: chat.isPublic,
    participantsCount: chat.participantsCount,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    lastBackend: backend,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    backends: {
      [backend]: emptyBackendStats(),
    },
  };
}

function truncateText(value, maxLength = 220) {
  const text = (value ?? '').trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MetricsStore {
  constructor(filePath, recentLimit = 200, tariffs = [], defaultTariffId = 'starter', tokenCycleDays = 30) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.recentLimit = recentLimit;
    this.tariffs = tariffs;
    this.tariffMap = createTariffMap(tariffs);
    this.defaultTariffId = defaultTariffId;
    this.tokenCycleDays = tokenCycleDays;
    this.state = createEmptyState(recentLimit, tariffs, defaultTariffId);
    this.initialized = false;
    this.queue = Promise.resolve();
  }

  async init() {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    await this.enqueue(async () => {
      await this.withWriteLock(async () => {
        this.syncState();
        await this.persistUnlocked();
        this.initialized = true;
      });
    });
  }

  async enqueue(operation) {
    const run = this.queue.then(() => operation());
    this.queue = run.catch(() => {});
    return run;
  }

  async acquireLock() {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });

    while (true) {
      try {
        const handle = await fs.open(this.lockPath, 'wx');
        return handle;
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }

        await delay(40);
      }
    }
  }

  async releaseLock(handle) {
    try {
      await handle.close();
    } finally {
      await fs.unlink(this.lockPath).catch(() => {});
    }
  }

  async readFromDiskUnlocked() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);

      this.state = {
        ...createEmptyState(this.recentLimit, this.tariffs, this.defaultTariffId),
        ...parsed,
        defaultTariffId: this.defaultTariffId,
        tariffs: this.tariffs,
        users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
        chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
        memberships: parsed.memberships && typeof parsed.memberships === 'object' ? parsed.memberships : {},
        recentRequests: Array.isArray(parsed.recentRequests) ? parsed.recentRequests.slice(0, this.recentLimit) : [],
        recentLimit: this.recentLimit,
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      this.state = createEmptyState(this.recentLimit, this.tariffs, this.defaultTariffId);
    }
  }

  syncState(nowIso = new Date().toISOString()) {
    this.state.schemaVersion = 2;
    this.state.defaultTariffId = this.defaultTariffId;
    this.state.tariffs = this.tariffs;
    this.state.users = this.state.users && typeof this.state.users === 'object' ? this.state.users : {};
    this.state.chats = this.state.chats && typeof this.state.chats === 'object' ? this.state.chats : {};
    this.state.memberships = this.state.memberships && typeof this.state.memberships === 'object' ? this.state.memberships : {};
    this.state.recentRequests = Array.isArray(this.state.recentRequests) ? this.state.recentRequests.slice(0, this.recentLimit) : [];
    this.state.recentLimit = this.recentLimit;

    for (const membershipKey of Object.keys(this.state.memberships)) {
      this.ensureMembershipUnlocked(membershipKey, nowIso);
    }
  }

  async withWriteLock(operation) {
    const handle = await this.acquireLock();

    try {
      await this.readFromDiskUnlocked();
      this.syncState();
      return await operation();
    } finally {
      await this.releaseLock(handle);
    }
  }

  async persistUnlocked() {
    this.state.updatedAt = new Date().toISOString();

    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.state, null, 2), 'utf8');
    await fs.rename(tempPath, this.filePath);
  }

  ensureMembershipUnlocked(userId, nowIso = new Date().toISOString()) {
    const key = String(userId);
    const membership = this.state.memberships[key] ?? createMembership(this.defaultTariffId, nowIso);

    if (!this.tariffMap[membership.planId]) {
      membership.planId = this.defaultTariffId;
    }

    if (isCycleExpired(membership.cycleStartedAt, this.tokenCycleDays)) {
      membership.cycleStartedAt = nowIso;
      membership.cycleSpentTokens = 0;
    }

    membership.manualTokenAdjustment = toNumber(membership.manualTokenAdjustment);
    membership.cycleSpentTokens = Math.max(0, toNumber(membership.cycleSpentTokens));
    membership.isBlocked = Boolean(membership.isBlocked);
    membership.updatedAt = membership.updatedAt ?? nowIso;

    this.state.memberships[key] = membership;
    return membership;
  }

  getUserQuotaUnlocked(userId, nowIso = new Date().toISOString()) {
    const membership = this.ensureMembershipUnlocked(userId, nowIso);
    const tariff = this.tariffMap[membership.planId] ?? this.tariffMap[this.defaultTariffId];

    return buildQuotaInfo(membership, tariff, this.tokenCycleDays, nowIso);
  }

  upsertUser(user, backend, chatId, nowIso) {
    if (!user) {
      return null;
    }

    const key = String(user.userId);
    const entry = this.state.users[key] ?? buildUserEntry(user, backend, nowIso);

    entry.name = user.name || entry.name;
    entry.platform = user.platform ?? entry.platform ?? 'unknown';
    entry.username = user.username ?? entry.username;
    entry.isBot = user.isBot;
    entry.lastSeenAt = nowIso;
    entry.lastBackend = backend;

    if (chatId != null && !entry.chatIds.includes(chatId)) {
      entry.chatIds.push(chatId);
    }

    ensureBackendStats(entry, backend);
    this.state.users[key] = entry;
    this.ensureMembershipUnlocked(key, nowIso);
    return entry;
  }

  upsertChat(chat, backend, nowIso) {
    if (!chat) {
      return null;
    }

    const key = String(chat.chatId);
    const entry = this.state.chats[key] ?? buildChatEntry(chat, backend, nowIso);

    entry.type = chat.type ?? entry.type;
    entry.platform = chat.platform ?? entry.platform ?? 'unknown';
    entry.title = chat.title ?? entry.title;
    entry.status = chat.status ?? entry.status;
    entry.isPublic = chat.isPublic ?? entry.isPublic;
    entry.participantsCount = chat.participantsCount ?? entry.participantsCount;
    entry.lastSeenAt = nowIso;
    entry.lastBackend = backend;

    ensureBackendStats(entry, backend);
    this.state.chats[key] = entry;
    return entry;
  }

  async touchInteraction({ user, chat, backend }) {
    await this.enqueue(async () => {
      await this.withWriteLock(async () => {
        const nowIso = new Date().toISOString();
        const chatId = chat?.chatId ?? null;

        this.upsertUser(user, backend, chatId, nowIso);
        this.upsertChat(chat, backend, nowIso);

        await this.persistUnlocked();
      });
    });
  }

  async getUserQuota(userId) {
    return this.enqueue(async () => {
      let quota;

      await this.withWriteLock(async () => {
        const nowIso = new Date().toISOString();
        quota = this.getUserQuotaUnlocked(userId, nowIso);
        await this.persistUnlocked();
      });

      return quota;
    });
  }

  async setUserPlan(userId, planId) {
    if (!this.tariffMap[planId]) {
      throw new Error(`Unknown tariff: ${planId}`);
    }

    return this.enqueue(async () => {
      let quota;

      await this.withWriteLock(async () => {
        const nowIso = new Date().toISOString();
        const membership = this.ensureMembershipUnlocked(userId, nowIso);
        membership.planId = planId;
        membership.updatedAt = nowIso;
        quota = this.getUserQuotaUnlocked(userId, nowIso);
        await this.persistUnlocked();
      });

      return quota;
    });
  }

  async adjustUserTokens(userId, delta) {
    const parsedDelta = toNumber(delta);

    return this.enqueue(async () => {
      let quota;

      await this.withWriteLock(async () => {
        const nowIso = new Date().toISOString();
        const membership = this.ensureMembershipUnlocked(userId, nowIso);
        membership.manualTokenAdjustment += parsedDelta;
        membership.updatedAt = nowIso;
        quota = this.getUserQuotaUnlocked(userId, nowIso);
        await this.persistUnlocked();
      });

      return quota;
    });
  }

  async setUserBlocked(userId, blocked) {
    return this.enqueue(async () => {
      let quota;

      await this.withWriteLock(async () => {
        const nowIso = new Date().toISOString();
        const membership = this.ensureMembershipUnlocked(userId, nowIso);
        membership.isBlocked = Boolean(blocked);
        membership.updatedAt = nowIso;
        quota = this.getUserQuotaUnlocked(userId, nowIso);
        await this.persistUnlocked();
      });

      return quota;
    });
  }

  async resetUserCycle(userId) {
    return this.enqueue(async () => {
      let quota;

      await this.withWriteLock(async () => {
        const nowIso = new Date().toISOString();
        const membership = this.ensureMembershipUnlocked(userId, nowIso);
        membership.cycleStartedAt = nowIso;
        membership.cycleSpentTokens = 0;
        membership.updatedAt = nowIso;
        quota = this.getUserQuotaUnlocked(userId, nowIso);
        await this.persistUnlocked();
      });

      return quota;
    });
  }

  async recordRequest({
    user,
    chat,
    backend,
    requestText,
    responseText,
    success,
    errorMessage,
    usage,
    provider,
    model,
    durationMs,
  }) {
    await this.enqueue(async () => {
      await this.withWriteLock(async () => {
        const nowIso = new Date().toISOString();
        const chatId = chat?.chatId ?? null;
        const normalizedUsage = normalizeUsage(usage);
        const userEntry = this.upsertUser(user, backend, chatId, nowIso);
        const chatEntry = this.upsertChat(chat, backend, nowIso);

        this.state.totals.requestCount += 1;
        this.state.totals.successCount += success ? 1 : 0;
        this.state.totals.errorCount += success ? 0 : 1;
        applyUsage(this.state.totals, normalizedUsage);

        if (userEntry) {
          const backendStats = ensureBackendStats(userEntry, backend);
          userEntry.requestCount += 1;
          userEntry.successCount += success ? 1 : 0;
          userEntry.errorCount += success ? 0 : 1;
          applyUsage(userEntry, normalizedUsage);
          backendStats.requestCount += 1;
          backendStats.successCount += success ? 1 : 0;
          backendStats.errorCount += success ? 0 : 1;
          applyUsage(backendStats, normalizedUsage);

          if (success && normalizedUsage.totalTokens > 0 && !QUOTA_FREE_BACKENDS.has(String(backend))) {
            const membership = this.ensureMembershipUnlocked(userEntry.userId, nowIso);
            membership.cycleSpentTokens += normalizedUsage.totalTokens;
            membership.updatedAt = nowIso;
          }
        }

        if (chatEntry) {
          const backendStats = ensureBackendStats(chatEntry, backend);
          chatEntry.requestCount += 1;
          chatEntry.successCount += success ? 1 : 0;
          chatEntry.errorCount += success ? 0 : 1;
          applyUsage(chatEntry, normalizedUsage);
          backendStats.requestCount += 1;
          backendStats.successCount += success ? 1 : 0;
          backendStats.errorCount += success ? 0 : 1;
          applyUsage(backendStats, normalizedUsage);
        }

        this.state.recentRequests.unshift({
          id: crypto.randomUUID(),
          timestamp: nowIso,
          backend,
          provider: provider || null,
          model: model || null,
          success,
          errorMessage: errorMessage || null,
          durationMs: durationMs ?? null,
          promptTokens: normalizedUsage.promptTokens,
          completionTokens: normalizedUsage.completionTokens,
          totalTokens: normalizedUsage.totalTokens,
          userId: user?.userId ?? null,
          userPlatform: user?.platform ?? null,
          userName: user?.name ?? null,
          username: user?.username ?? null,
          chatId: chat?.chatId ?? null,
          chatPlatform: chat?.platform ?? null,
          chatTitle: chat?.title ?? null,
          requestChars: requestText.length,
          responseChars: responseText.length,
          requestPreview: truncateText(requestText),
          responsePreview: truncateText(responseText),
        });

        this.state.recentRequests = this.state.recentRequests.slice(0, this.recentLimit);

        await this.persistUnlocked();
      });
    });
  }
}

export async function readMetricsSnapshot(filePath, recentLimit = 200) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      ...parsed,
      users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
      chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
      memberships: parsed.memberships && typeof parsed.memberships === 'object' ? parsed.memberships : {},
      recentRequests: Array.isArray(parsed.recentRequests) ? parsed.recentRequests.slice(0, recentLimit) : [],
      recentLimit,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return createEmptyState(recentLimit, [], 'starter');
    }

    throw error;
  }
}
