import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { config, validateConfig } from './config.js';
import { G4FClient } from './g4f-client.js';
import { BackendStore } from './backend-store.js';
import { CodexSessionStore } from './codex-session-store.js';
import { ConversationStore } from './history.js';
import { MetricsStore } from './metrics-store.js';

const MAX_MESSAGE_LENGTH = 3900;
const MAX_TEXT_FORMAT = 'markdown';
const BACKENDS = {
  g4f: {
    title: 'g4f',
    description: 'локальный g4f-сервер',
  },
  codex: {
    title: 'codex-lb',
    description: 'codex-lb через API ключ',
  },
};
const BACKEND_IDS = Object.keys(BACKENDS);
const PUBLIC_TARIFFS = config.tariffs.filter((tariff) => tariff.isPublic);

function getConversationKey(ctx) {
  if (typeof ctx.chatId === 'number') {
    return `chat:${ctx.chatId}`;
  }

  if (typeof ctx.user?.user_id === 'number') {
    return `user:${ctx.user.user_id}`;
  }

  return 'fallback';
}

function splitLongText(text, limit = MAX_MESSAGE_LENGTH) {
  if (text.length <= limit) {
    return [text];
  }

  const parts = [];
  let remaining = text.trim();

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const breakAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    const splitAt = breakAt > Math.floor(limit * 0.6) ? breakAt : limit;

    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

function withTextFormat(extra = {}) {
  return extra.format ? extra : {
    ...extra,
    format: MAX_TEXT_FORMAT,
  };
}

async function replyText(ctx, text, extra = {}) {
  return ctx.reply(text, withTextFormat(extra));
}

async function editTextMessage(ctx, text, extra = {}) {
  return ctx.editMessage({
    text,
    ...withTextFormat(extra),
  });
}

async function replyChunked(ctx, text) {
  const parts = splitLongText(text);

  for (const part of parts) {
    await replyText(ctx, part);
  }
}

function getIncomingText(ctx) {
  return ctx.message?.body?.text?.trim() ?? '';
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value || 0));
}

function getUserData(ctx) {
  const source = ctx.user ?? ctx.callback?.user ?? ctx.message?.sender;

  if (!source || typeof source.user_id !== 'number') {
    return null;
  }

  return {
    userId: source.user_id,
    name: source.name ?? '',
    username: source.username ?? null,
    isBot: Boolean(source.is_bot),
  };
}

function getChatData(ctx) {
  if (typeof ctx.chatId !== 'number') {
    return null;
  }

  return {
    chatId: ctx.chatId,
    type: ctx.chat?.type ?? null,
    title: ctx.chat?.title ?? null,
    status: ctx.chat?.status ?? null,
    isPublic: ctx.chat?.is_public ?? null,
    participantsCount: ctx.chat?.participants_count ?? null,
  };
}

function getBackendHistoryKey(conversationKey, backendId) {
  return `${conversationKey}|${backendId}`;
}

function getModeKeyboard(activeBackend) {
  const buttons = BACKEND_IDS.map((backendId) => Keyboard.button.callback(
    activeBackend === backendId ? `${BACKENDS[backendId].title} ✓` : BACKENDS[backendId].title,
    `mode:${backendId}`,
    {
      intent: activeBackend === backendId ? 'positive' : 'default',
    },
  ));

  return [Keyboard.inlineKeyboard([buttons])];
}

function buildRows(items, size = 2) {
  const rows = [];

  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }

  return rows;
}

function getTariffKeyboard(activeTariffId) {
  const buttons = PUBLIC_TARIFFS.map((tariff) => Keyboard.button.callback(
    activeTariffId === tariff.id ? `${tariff.name} ✓` : tariff.name,
    `tariff:${tariff.id}`,
    {
      intent: activeTariffId === tariff.id ? 'positive' : 'default',
    },
  ));

  return [Keyboard.inlineKeyboard(buildRows(buttons, 2))];
}

function getModeText(activeBackend) {
  return [
    'Выберите, через что отправлять запросы.',
    `Сейчас активно: ${BACKENDS[activeBackend].title}.`,
    `g4f: ${BACKENDS.g4f.description}.`,
    `codex-lb: ${BACKENDS.codex.description}.`,
    'Для каждого режима хранится свой контекст, поэтому можно спокойно переключаться туда-сюда.',
  ].join('\n');
}

function getTariffText(quota) {
  const lines = [
    'Выберите тариф.',
    '',
  ];

  for (const tariff of PUBLIC_TARIFFS) {
    const marker = tariff.id === quota.planId ? '•' : ' ';
    const pricePart = tariff.priceText ? ` — ${tariff.priceText}` : '';
    const descriptionPart = tariff.description ? ` — ${tariff.description}` : '';
    lines.push(`${marker} ${tariff.name}${pricePart} — ${formatNumber(tariff.monthlyTokens)} токенов / ${config.tokenCycleDays} дн.${descriptionPart}`);
  }

  lines.push('');
  lines.push(`Сейчас: ${quota.planName}.`);
  lines.push(`Доступно в цикле: ${formatNumber(quota.allowanceTokens)} токенов.`);
  lines.push(`Потрачено: ${formatNumber(quota.cycleSpentTokens)}.`);
  lines.push(`Осталось: ${formatNumber(quota.remainingTokens)}.`);

  if (quota.manualTokenAdjustment !== 0) {
    lines.push(`Ручная корректировка администратора: ${quota.manualTokenAdjustment > 0 ? '+' : ''}${formatNumber(quota.manualTokenAdjustment)}.`);
  }

  lines.push(`Сброс цикла: ${new Date(quota.cycleEndsAt).toLocaleString('ru-RU')}.`);

  if (quota.isBlocked) {
    lines.push('Доступ сейчас заблокирован администратором.');
  }

  return lines.join('\n');
}

async function sendModeMenu(ctx, activeBackend, introText = '') {
  const text = introText ? `${introText}\n\n${getModeText(activeBackend)}` : getModeText(activeBackend);

  await replyText(ctx, text, {
    attachments: getModeKeyboard(activeBackend),
  });
}

async function sendTariffMenu(ctx, quota, introText = '') {
  const text = introText ? `${introText}\n\n${getTariffText(quota)}` : getTariffText(quota);

  await replyText(ctx, text, {
    attachments: getTariffKeyboard(quota.planId),
  });
}

async function resetConversationHistory(history, codexSessionsStore, conversationKey) {
  for (const backendId of BACKEND_IDS) {
    const backendKey = getBackendHistoryKey(conversationKey, backendId);
    history.reset(backendKey);

    if (backendId === 'codex') {
      await codexSessionsStore.reset(backendKey);
    }
  }
}

validateConfig();

const bot = new Bot(config.maxBotToken);
const clients = {
  g4f: new G4FClient(config.g4f),
  codex: new G4FClient(config.codex),
};
const history = new ConversationStore(config.maxHistoryMessages);
const backendStore = new BackendStore(config.defaultBackend);
const codexSessions = new CodexSessionStore(config.codexSessionFile);
const metrics = new MetricsStore(
  config.metricsFile,
  config.recentRequestsLimit,
  config.tariffs,
  config.defaultTariffId,
  config.tokenCycleDays,
);
const pendingConversations = new Set();

await metrics.init();
await codexSessions.init();

async function trackInteraction(ctx, backend) {
  try {
    await metrics.touchInteraction({
      user: getUserData(ctx),
      chat: getChatData(ctx),
      backend,
    });
  } catch (error) {
    console.error('Failed to update metrics presence:', error);
  }
}

async function trackRequest(ctx, backend, requestText, responseText, result, durationMs, success, errorMessage = '') {
  try {
    await metrics.recordRequest({
      user: getUserData(ctx),
      chat: getChatData(ctx),
      backend,
      requestText,
      responseText,
      success,
      errorMessage,
      usage: result?.usage,
      provider: result?.provider ?? '',
      model: result?.model ?? '',
      durationMs,
    });
  } catch (error) {
    console.error('Failed to persist metrics request:', error);
  }
}

bot.catch(async (error, ctx) => {
  console.error('Unhandled bot error:', error);

  try {
    await replyText(ctx, 'Произошла ошибка при обработке сообщения. Попробуйте ещё раз.');
  } catch (replyError) {
    console.error('Failed to send error message:', replyError);
  }
});

await bot.api.setMyCommands([
  {
    name: 'start',
    description: 'Запустить и узнать, как работает бот',
  },
  {
    name: 'help',
    description: 'Показать подсказку по использованию',
  },
  {
    name: 'reset',
    description: 'Очистить историю диалога',
  },
  {
    name: 'mode',
    description: 'Выбрать режим: g4f или codex-lb',
  },
  {
    name: 'tariff',
    description: 'Посмотреть и выбрать тариф',
  },
]);

bot.on('bot_started', async (ctx) => {
  const conversationKey = getConversationKey(ctx);
  const activeBackend = backendStore.get(conversationKey);
  await trackInteraction(ctx, activeBackend);

  await sendModeMenu(
    ctx,
    activeBackend,
    'Привет! Я умею отправлять сообщения либо на ваш g4f, либо в codex-lb по API ключу. Тарифы и лимиты доступны через /tariff.',
  );
});

bot.command('start', async (ctx) => {
  const conversationKey = getConversationKey(ctx);
  const activeBackend = backendStore.get(conversationKey);
  await trackInteraction(ctx, activeBackend);

  await resetConversationHistory(history, codexSessions, conversationKey);

  await sendModeMenu(
    ctx,
    activeBackend,
    'Бот готов. Отправьте текст, и я передам его через выбранный режим. Команды: /help, /mode, /tariff и /reset.',
  );
});

bot.command('help', async (ctx) => {
  const conversationKey = getConversationKey(ctx);
  const activeBackend = backendStore.get(conversationKey);
  await trackInteraction(ctx, activeBackend);

  await sendModeMenu(
    ctx,
    activeBackend,
    [
      'Как пользоваться:',
      '1. Отправьте обычное текстовое сообщение.',
      '2. Я передам его через активный режим и верну ответ.',
      '3. /mode открывает меню переключения между g4f и codex-lb.',
      '4. /tariff открывает меню тарифов и показывает остаток токенов.',
      '5. /reset очищает историю сразу для обоих режимов.',
    ].join('\n'),
  );
});

bot.command('reset', async (ctx) => {
  const conversationKey = getConversationKey(ctx);
  const activeBackend = backendStore.get(conversationKey);
  await trackInteraction(ctx, activeBackend);

  await resetConversationHistory(history, codexSessions, conversationKey);

  await sendModeMenu(ctx, activeBackend, 'История диалога очищена для g4f и codex-lb.');
});

bot.command('mode', async (ctx) => {
  const conversationKey = getConversationKey(ctx);
  const activeBackend = backendStore.get(conversationKey);
  await trackInteraction(ctx, activeBackend);

  await sendModeMenu(ctx, activeBackend);
});

bot.command('tariff', async (ctx) => {
  const user = getUserData(ctx);

  if (!user) {
    await replyText(ctx, 'Не удалось определить пользователя для тарифа.');
    return;
  }

  const quota = await metrics.getUserQuota(user.userId);
  await trackInteraction(ctx, backendStore.get(getConversationKey(ctx)));
  await sendTariffMenu(ctx, quota);
});

for (const backendId of BACKEND_IDS) {
  bot.action(`mode:${backendId}`, async (ctx) => {
    const conversationKey = getConversationKey(ctx);
    const previousBackend = backendStore.get(conversationKey);
    const nextBackend = backendId;
    const changed = previousBackend !== nextBackend;

    backendStore.set(conversationKey, nextBackend);
    await trackInteraction(ctx, nextBackend);

    const text = getModeText(nextBackend);
    const extra = {
      attachments: getModeKeyboard(nextBackend),
    };
    const notification = changed
      ? `Режим переключен на ${BACKENDS[nextBackend].title}.`
      : `${BACKENDS[nextBackend].title} уже выбран.`;

    await ctx.answerOnCallback({ notification }).catch(() => {});

    if (ctx.messageId) {
      await editTextMessage(ctx, text, extra).catch(async () => {
        await replyText(ctx, text, extra);
      });
      return;
    }

    await replyText(ctx, text, extra);
  });
}

for (const tariff of PUBLIC_TARIFFS) {
  bot.action(`tariff:${tariff.id}`, async (ctx) => {
    const user = getUserData(ctx);

    if (!user) {
      await ctx.answerOnCallback({ notification: 'Не удалось определить пользователя.' }).catch(() => {});
      return;
    }

    const quota = await metrics.setUserPlan(user.userId, tariff.id);
    const text = getTariffText(quota);
    const extra = {
      attachments: getTariffKeyboard(quota.planId),
    };

    await ctx.answerOnCallback({ notification: `Тариф переключен на ${quota.planName}.` }).catch(() => {});

    if (ctx.messageId) {
      await editTextMessage(ctx, text, extra).catch(async () => {
        await replyText(ctx, text, extra);
      });
      return;
    }

    await replyText(ctx, text, extra);
  });
}

bot.on('message_created', async (ctx) => {
  if (ctx.message?.sender?.is_bot) {
    return;
  }

  const text = getIncomingText(ctx);

  if (!text) {
    await replyText(ctx, 'Пока я умею работать только с текстовыми сообщениями.');
    return;
  }

  if (text.startsWith('/')) {
    return;
  }

  const conversationKey = getConversationKey(ctx);
  const activeBackend = backendStore.get(conversationKey);
  const backend = BACKENDS[activeBackend];
  const client = clients[activeBackend];
  const historyKey = getBackendHistoryKey(conversationKey, activeBackend);
  const user = getUserData(ctx);
  await trackInteraction(ctx, activeBackend);

  if (user) {
    const quota = await metrics.getUserQuota(user.userId);

    if (quota.isBlocked) {
      await replyText(ctx, 'Доступ к боту сейчас отключён администратором.');
      return;
    }

    if (quota.remainingTokens <= 0) {
      await sendTariffMenu(
        ctx,
        quota,
        'Лимит токенов на текущем тарифе исчерпан. Выберите другой тариф или попросите администратора увеличить лимит.',
      );
      return;
    }
  }

  if (pendingConversations.has(conversationKey)) {
    await replyText(ctx, 'Я ещё обрабатываю предыдущий запрос. Подождите пару секунд.');
    return;
  }

  pendingConversations.add(conversationKey);

  try {
    const startedAt = Date.now();

    await ctx.sendAction('typing_on').catch(() => {});

    const result = activeBackend === 'codex' && config.codex.useResponses
      ? await client.askResponsesTurn({
        systemPrompt: config.systemPrompt,
        userText: text,
        previousResponseId: codexSessions.get(historyKey),
      }, config.requestTimeoutMs)
      : await client.ask(history.buildMessages(historyKey, config.systemPrompt, text), config.requestTimeoutMs);
    const answer = result.text;
    const durationMs = Date.now() - startedAt;

    if (activeBackend === 'codex' && config.codex.useResponses) {
      if (result.responseId) {
        await codexSessions.set(historyKey, result.responseId);
      }
    } else {
      history.append(historyKey, 'user', text);
      history.append(historyKey, 'assistant', answer);
    }

    await trackRequest(ctx, activeBackend, text, answer, result, durationMs, true);

    await replyChunked(ctx, answer);
  } catch (error) {
    console.error(`${backend.title} request failed:`, error);
    await trackRequest(ctx, activeBackend, text, '', null, null, false, error.message ?? 'unknown error');
    await replyText(
      ctx,
      `Не получилось получить ответ через ${backend.title}. Проверьте настройки сервера и при необходимости переключитесь через /mode.`,
    );
  } finally {
    pendingConversations.delete(conversationKey);
  }
});

console.log(`Starting MAX bot with default backend ${config.defaultBackend}...`);
await bot.start({
  allowedUpdates: ['bot_started', 'message_created', 'message_callback'],
});
