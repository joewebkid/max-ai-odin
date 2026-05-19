import { Bot, InlineKeyboard } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config, validateTelegramConfig } from './config.js';
import { G4FClient } from './g4f-client.js';
import { BackendStore } from './backend-store.js';
import { CodexSessionStore } from './codex-session-store.js';
import { ConversationStore } from './history.js';
import { DEFAULT_IMAGE_PROMPT, ImageInputError, extractTelegramImageInput } from './image-input.js';
import { normalizeTextForMax } from './max-text-normalizer.js';
import { MetricsStore } from './metrics-store.js';
import { renderTelegramHtmlChunks } from './telegram-text.js';

const TELEGRAM_MESSAGE_LENGTH = 3600;
const BACKENDS = {
  free: {
    title: 'Free',
    description: 'g4f free',
  },
  chatgpt: {
    title: 'Chat GPT',
    description: 'codex-lb',
  },
  claude: {
    title: 'Claude',
    description: 'Opus через anti-api',
  },
  gemini: {
    title: 'Gemini',
    description: 'Pro High через anti-api',
  },
};
const BACKEND_IDS = ['free', 'chatgpt', 'claude', 'gemini'];
const PUBLIC_TARIFFS = config.tariffs.filter((tariff) => tariff.isPublic);

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value || 0));
}

function buildTelegramDisplayName(from) {
  const firstName = String(from?.first_name ?? '').trim();
  const lastName = String(from?.last_name ?? '').trim();
  const joined = [firstName, lastName].filter(Boolean).join(' ').trim();

  if (joined) {
    return joined;
  }

  if (from?.username) {
    return `@${from.username}`;
  }

  return `Telegram ${from?.id ?? 'user'}`;
}

function getConversationKey(ctx) {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;

  if (typeof userId === 'number' && ctx.chat?.type === 'private') {
    return `tg:user:${userId}`;
  }

  if (typeof chatId === 'number' && typeof userId === 'number') {
    return `tg:chat:${chatId}:user:${userId}`;
  }

  if (typeof chatId === 'number') {
    return `tg:chat:${chatId}`;
  }

  if (typeof userId === 'number') {
    return `tg:user:${userId}`;
  }

  return 'tg:fallback';
}

function getBackendHistoryKey(conversationKey, backendId) {
  return `${conversationKey}|${backendId}`;
}

function getIncomingText(ctx) {
  return ctx.message?.text?.trim() ?? ctx.message?.caption?.trim() ?? '';
}

function getUserData(ctx) {
  if (!ctx.from || typeof ctx.from.id !== 'number') {
    return null;
  }

  return {
    userId: `tg:user:${ctx.from.id}`,
    platform: 'telegram',
    name: buildTelegramDisplayName(ctx.from),
    username: ctx.from.username ? `@${ctx.from.username}` : null,
    isBot: Boolean(ctx.from.is_bot),
  };
}

function getChatData(ctx) {
  if (!ctx.chat || typeof ctx.chat.id !== 'number') {
    return null;
  }

  const title = ctx.chat.title
    ?? (ctx.chat.type === 'private' ? buildTelegramDisplayName(ctx.from) : null);
  const isPublic = ['group', 'supergroup', 'channel'].includes(String(ctx.chat.type ?? ''));

  return {
    chatId: `tg:chat:${ctx.chat.id}`,
    platform: 'telegram',
    type: ctx.chat.type ?? null,
    title,
    status: null,
    isPublic,
    participantsCount: null,
  };
}

function getModeKeyboard(activeBackend) {
  const keyboard = new InlineKeyboard();

  BACKEND_IDS.forEach((backendId, index) => {
    const label = activeBackend === backendId ? `${BACKENDS[backendId].title} ✓` : BACKENDS[backendId].title;
    keyboard.text(label, `mode:${backendId}`);

    if (index % 2 === 1 && index < BACKEND_IDS.length - 1) {
      keyboard.row();
    }
  });

  return keyboard;
}

function getTariffKeyboard(activeTariffId) {
  const keyboard = new InlineKeyboard();

  PUBLIC_TARIFFS.forEach((tariff, index) => {
    const label = activeTariffId === tariff.id ? `${tariff.name} ✓` : tariff.name;
    keyboard.text(label, `tariff:${tariff.id}`);

    if (index % 2 === 1 && index < PUBLIC_TARIFFS.length - 1) {
      keyboard.row();
    }
  });

  return keyboard;
}

function getModeText(activeBackend) {
  return [
    'Выберите режим ответа.',
    `Сейчас активно: ${BACKENDS[activeBackend].title}.`,
    '1. Free: g4f.',
    '2. Chat GPT: codex-lb.',
    '3. Claude: Opus через anti-api.',
    '4. Gemini: Pro High через anti-api.',
    'Для каждого режима хранится свой контекст, поэтому можно спокойно переключаться между ними.',
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

async function replyText(ctx, text, extra = {}) {
  const [htmlText] = renderTelegramHtmlChunks(normalizeTextForMax(text), TELEGRAM_MESSAGE_LENGTH);

  return ctx.reply(htmlText, {
    disable_web_page_preview: true,
    parse_mode: 'HTML',
    ...extra,
  });
}

async function editTextMessage(ctx, text, extra = {}) {
  const [htmlText] = renderTelegramHtmlChunks(normalizeTextForMax(text), TELEGRAM_MESSAGE_LENGTH);

  return ctx.editMessageText(htmlText, {
    disable_web_page_preview: true,
    parse_mode: 'HTML',
    ...extra,
  });
}

async function replyChunked(ctx, text) {
  const normalizedText = normalizeTextForMax(text);
  const parts = renderTelegramHtmlChunks(normalizedText, TELEGRAM_MESSAGE_LENGTH);

  for (const part of parts) {
    await ctx.reply(part, {
      disable_web_page_preview: true,
      parse_mode: 'HTML',
    });
  }
}

function startTypingLoop(ctx, intervalMs = 4_000) {
  const chatId = ctx.chat?.id;

  if (typeof chatId !== 'number') {
    return () => {};
  }

  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) {
      return;
    }

    try {
      await ctx.api.sendChatAction(chatId, 'typing');
    } catch {
      // Ignore transient action errors so the main request can continue.
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          void tick();
        }, intervalMs);
        timer.unref?.();
      }
    }
  };

  void tick();

  return () => {
    stopped = true;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

async function sendModeMenu(ctx, activeBackend, introText = '') {
  const text = introText ? `${introText}\n\n${getModeText(activeBackend)}` : getModeText(activeBackend);

  await replyText(ctx, text, {
    reply_markup: getModeKeyboard(activeBackend),
  });
}

async function sendTariffMenu(ctx, quota, introText = '') {
  const text = introText ? `${introText}\n\n${getTariffText(quota)}` : getTariffText(quota);

  await replyText(ctx, text, {
    reply_markup: getTariffKeyboard(quota.planId),
  });
}

async function resetConversationHistory(history, codexSessionsStore, conversationKey) {
  for (const backendId of BACKEND_IDS) {
    const backendKey = getBackendHistoryKey(conversationKey, backendId);
    history.reset(backendKey);

    if (backendId === 'chatgpt') {
      await codexSessionsStore.reset(backendKey);
    }
  }
}

validateTelegramConfig();

const telegramClientConfig = config.telegramProxyUrl
  ? {
    baseFetchConfig: {
      agent: new HttpsProxyAgent(config.telegramProxyUrl),
    },
  }
  : undefined;
const bot = new Bot(config.telegramBotToken, {
  client: telegramClientConfig,
});
const clients = {
  free: new G4FClient(config.g4f),
  chatgpt: new G4FClient(config.codex),
  claude: new G4FClient(config.antiClaude),
  gemini: new G4FClient(config.antiGemini),
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

function buildRequestPreview(text, hasImage = false) {
  const normalizedText = String(text ?? '').trim();

  if (hasImage && normalizedText) {
    return `[image]\n${normalizedText}`;
  }

  if (hasImage) {
    return '[image]';
  }

  return normalizedText;
}

function buildHistoryEntryText(text, hasImage = false) {
  const normalizedText = String(text ?? '').trim();

  if (hasImage && normalizedText) {
    return `[Изображение]\n${normalizedText}`;
  }

  if (hasImage) {
    return '[Изображение]';
  }

  return normalizedText;
}

bot.catch(async (error) => {
  console.error('Unhandled Telegram bot error:', error);
});

await bot.api.setMyCommands([
  {
    command: 'start',
    description: 'Запустить и узнать, как работает бот',
  },
  {
    command: 'help',
    description: 'Показать подсказку по использованию',
  },
  {
    command: 'reset',
    description: 'Очистить историю диалога',
  },
  {
    command: 'mode',
    description: 'Выбрать режим: Free / Chat GPT / Claude / Gemini',
  },
  {
    command: 'tariff',
    description: 'Посмотреть и выбрать тариф',
  },
]);

await bot.api.deleteWebhook({
  drop_pending_updates: false,
});

bot.command('start', async (ctx) => {
  const conversationKey = getConversationKey(ctx);
  const activeBackend = backendStore.get(conversationKey);
  await trackInteraction(ctx, activeBackend);

  await resetConversationHistory(history, codexSessions, conversationKey);

  await sendModeMenu(
    ctx,
    activeBackend,
    'Бот готов. Отправьте текст, и я передам его через выбранный режим. Доступны Free, Chat GPT, Claude и Gemini. Команды: /help, /mode, /tariff и /reset.',
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
      '3. /mode открывает меню переключения между Free, Chat GPT, Claude и Gemini.',
      '4. /tariff открывает меню тарифов и показывает остаток токенов.',
      '5. /reset очищает историю сразу для всех четырех режимов.',
    ].join('\n'),
  );
});

bot.command('reset', async (ctx) => {
  const conversationKey = getConversationKey(ctx);
  const activeBackend = backendStore.get(conversationKey);
  await trackInteraction(ctx, activeBackend);

  await resetConversationHistory(history, codexSessions, conversationKey);

  await sendModeMenu(ctx, activeBackend, 'История диалога очищена для Free, Chat GPT, Claude и Gemini.');
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
  bot.callbackQuery(new RegExp(`^mode:${backendId}$`), async (ctx) => {
    const conversationKey = getConversationKey(ctx);
    const previousBackend = backendStore.get(conversationKey);
    const nextBackend = backendId;
    const changed = previousBackend !== nextBackend;

    backendStore.set(conversationKey, nextBackend);
    await trackInteraction(ctx, nextBackend);

    const text = getModeText(nextBackend);
    const extra = {
      reply_markup: getModeKeyboard(nextBackend),
    };
    const notification = changed
      ? `Режим переключен на ${BACKENDS[nextBackend].title}.`
      : `${BACKENDS[nextBackend].title} уже выбран.`;

    await ctx.answerCallbackQuery({ text: notification }).catch(() => {});

    if (ctx.callbackQuery.message) {
      await editTextMessage(ctx, text, extra).catch(async () => {
        await replyText(ctx, text, extra);
      });
      return;
    }

    await replyText(ctx, text, extra);
  });
}

for (const tariff of PUBLIC_TARIFFS) {
  bot.callbackQuery(new RegExp(`^tariff:${tariff.id}$`), async (ctx) => {
    const user = getUserData(ctx);

    if (!user) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя.' }).catch(() => {});
      return;
    }

    const quota = await metrics.setUserPlan(user.userId, tariff.id);
    const text = getTariffText(quota);
    const extra = {
      reply_markup: getTariffKeyboard(quota.planId),
    };

    await ctx.answerCallbackQuery({ text: `Тариф переключен на ${quota.planName}.` }).catch(() => {});

    if (ctx.callbackQuery.message) {
      await editTextMessage(ctx, text, extra).catch(async () => {
        await replyText(ctx, text, extra);
      });
      return;
    }

    await replyText(ctx, text, extra);
  });
}

bot.on('message', async (ctx) => {
  if (ctx.from?.is_bot) {
    return;
  }

  const text = getIncomingText(ctx);
  let imageInput = null;

  try {
    imageInput = await extractTelegramImageInput(ctx, {
      botToken: config.telegramBotToken,
      proxyUrl: config.telegramProxyUrl,
    });
  } catch (error) {
    if (error instanceof ImageInputError) {
      await replyText(ctx, error.message);
      return;
    }

    throw error;
  }

  if (!text && !imageInput) {
    await replyText(ctx, 'Пока я умею работать только с текстовыми сообщениями.');
    return;
  }

  if (text && text.startsWith('/') && !imageInput) {
    return;
  }

  const conversationKey = getConversationKey(ctx);
  const activeBackend = backendStore.get(conversationKey);
  const backend = BACKENDS[activeBackend];
  const client = clients[activeBackend];
  const historyKey = getBackendHistoryKey(conversationKey, activeBackend);
  const user = getUserData(ctx);
  await trackInteraction(ctx, activeBackend);
  const hasImage = Boolean(imageInput);
  const requestText = buildRequestPreview(text, hasImage);

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

  if (hasImage && activeBackend !== 'chatgpt') {
    await replyText(
      ctx,
      'Распознавание изображений сейчас доступно только в режиме Chat GPT. Переключитесь через /mode и отправьте картинку ещё раз.',
    );
    return;
  }

  pendingConversations.add(conversationKey);
  const stopTyping = startTypingLoop(ctx);

  try {
    const startedAt = Date.now();
    const effectiveUserText = text || (hasImage ? DEFAULT_IMAGE_PROMPT : '');
    const historyUserText = buildHistoryEntryText(effectiveUserText, hasImage);
    let result;

    if (activeBackend === 'chatgpt' && hasImage) {
      result = await client.ask(
        client.buildVisionMessages(config.systemPrompt, effectiveUserText, imageInput),
        config.requestTimeoutMs,
      );
    } else if (activeBackend === 'chatgpt' && config.codex.useResponses) {
      result = await client.askResponsesTurn({
        systemPrompt: config.systemPrompt,
        userText: effectiveUserText,
        previousResponseId: codexSessions.get(historyKey),
        inputImage: imageInput,
        historyMessages: history.get(historyKey),
      }, config.requestTimeoutMs);
    } else {
      result = await client.ask(
        history.buildMessages(historyKey, config.systemPrompt, effectiveUserText),
        config.requestTimeoutMs,
      );
    }
    const answer = result.text;
    const durationMs = Date.now() - startedAt;

    if (activeBackend === 'chatgpt' && hasImage) {
      await codexSessions.reset(historyKey);
    } else if (activeBackend === 'chatgpt' && config.codex.useResponses) {
      if (result.responseId) {
        await codexSessions.set(historyKey, result.responseId);
      }
    }

    history.append(historyKey, 'user', historyUserText);
    history.append(historyKey, 'assistant', answer);

    await trackRequest(ctx, activeBackend, requestText, answer, result, durationMs, true);
    stopTyping();

    await replyChunked(ctx, answer);
  } catch (error) {
    console.error(`${backend.title} request failed:`, error);
    await trackRequest(ctx, activeBackend, requestText, '', null, null, false, error.message ?? 'unknown error');
    stopTyping();
    await replyText(
      ctx,
      `Не получилось получить ответ через ${backend.title}. Проверьте настройки сервера и при необходимости переключитесь через /mode.`,
    );
  } finally {
    stopTyping();
    pendingConversations.delete(conversationKey);
  }
});

console.log(`Starting Telegram bot with default backend ${config.defaultBackend}...`);
await bot.start({
  allowed_updates: ['message', 'callback_query'],
  onStart: ({ username }) => {
    console.log(`Telegram bot started as @${username}`);
  },
});
