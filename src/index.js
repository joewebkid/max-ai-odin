import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { config, validateConfig } from './config.js';
import { G4FClient } from './g4f-client.js';
import { BackendStore } from './backend-store.js';
import { CodexSessionStore } from './codex-session-store.js';
import { ConversationStore } from './history.js';
import { DEFAULT_IMAGE_PROMPT, ImageInputError, extractMaxImageInput } from './image-input.js';
import { normalizeTextForMax } from './max-text-normalizer.js';
import { MetricsStore } from './metrics-store.js';
import {
  buildPaymentRequestMessage,
  sendPaymentRequestNotification,
} from './payment-request-notifier.js';

const MAX_MESSAGE_LENGTH = 3900;
const MAX_TEXT_FORMAT = 'markdown';
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
const PUBLIC_BACKEND_IDS = ['free', 'chatgpt'];
const PRIVATE_BACKEND_IDS = ['claude', 'gemini'];
const BACKEND_IDS = [...PUBLIC_BACKEND_IDS, ...PRIVATE_BACKEND_IDS];
const PUBLIC_TARIFFS = config.tariffs.filter((tariff) => tariff.isPublic);
const PRIVATE_BACKEND_USER_IDS = new Set(config.privateBackends.userIds);

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
  const normalizedText = normalizeTextForMax(text);
  const parts = splitLongText(normalizedText);

  for (const part of parts) {
    await replyText(ctx, part);
  }
}

function startTypingLoop(ctx, intervalMs = 4_000) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) {
      return;
    }

    try {
      await ctx.sendAction('typing_on');
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
    platform: 'max',
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
    platform: 'max',
    type: ctx.chat?.type ?? null,
    title: ctx.chat?.title ?? null,
    status: ctx.chat?.status ?? null,
    isPublic: ctx.chat?.is_public ?? null,
    participantsCount: ctx.chat?.participants_count ?? null,
  };
}

function isPrivateBackendAllowed(user) {
  if (!user) {
    return false;
  }

  const rawId = String(user.userId);
  const platform = String(user.platform ?? '').trim().toLowerCase();
  const candidates = new Set([
    rawId,
    `${platform}:${rawId}`,
    `${platform}:user:${rawId}`,
  ]);

  return [...candidates].some((candidate) => PRIVATE_BACKEND_USER_IDS.has(candidate));
}

function getAllowedBackendIds(user) {
  return isPrivateBackendAllowed(user)
    ? BACKEND_IDS
    : PUBLIC_BACKEND_IDS;
}

function resolveVisibleBackend(activeBackend, user) {
  const allowedBackendIds = getAllowedBackendIds(user);
  if (allowedBackendIds.includes(activeBackend)) {
    return activeBackend;
  }

  return allowedBackendIds.includes(config.defaultBackend)
    ? config.defaultBackend
    : PUBLIC_BACKEND_IDS[0];
}

function getBackendHistoryKey(conversationKey, backendId) {
  return `${conversationKey}|${backendId}`;
}

function getModeKeyboard(activeBackend, user = null) {
  const buttons = getAllowedBackendIds(user).map((backendId) => Keyboard.button.callback(
    activeBackend === backendId ? `${BACKENDS[backendId].title} ✓` : BACKENDS[backendId].title,
    `mode:${backendId}`,
    {
      intent: activeBackend === backendId ? 'positive' : 'default',
    },
  ));

  return [Keyboard.inlineKeyboard(buildRows(buttons, 2))];
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
    `tariff_request:${tariff.id}`,
    {
      intent: activeTariffId === tariff.id ? 'positive' : 'default',
    },
  ));

  return [Keyboard.inlineKeyboard(buildRows(buttons, 2))];
}

function getModeText(activeBackend, user = null) {
  const lines = [
    'Выберите режим ответа.',
    `Сейчас активно: ${BACKENDS[activeBackend].title}.`,
    '1. Free: g4f, без списания токенов тарифа.',
    '2. Chat GPT: codex-lb, расходует токены тарифа.',
  ];

  if (isPrivateBackendAllowed(user)) {
    lines.push('3. Claude: приватный режим владельца.');
    lines.push('4. Gemini: приватный режим владельца.');
  }

  lines.push('Для каждого режима хранится свой контекст, поэтому можно спокойно переключаться между ними.');

  return lines.join('\n');
}

function getTariffText(quota) {
  const lines = [
    'Выберите желаемый тариф для заявки.',
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

  lines.push('');
  lines.push('Нажмите на тариф, и я отправлю заявку администратору. Самостоятельная смена тарифа отключена.');

  return lines.join('\n');
}

async function sendModeMenu(ctx, activeBackend, introText = '') {
  const user = getUserData(ctx);
  const visibleBackend = resolveVisibleBackend(activeBackend, user);
  const text = introText ? `${introText}\n\n${getModeText(visibleBackend, user)}` : getModeText(visibleBackend, user);

  await replyText(ctx, text, {
    attachments: getModeKeyboard(visibleBackend, user),
  });
}

async function sendTariffMenu(ctx, quota, introText = '') {
  const text = introText ? `${introText}\n\n${getTariffText(quota)}` : getTariffText(quota);

  await replyText(ctx, text, {
    attachments: getTariffKeyboard(quota.planId),
  });
}

async function submitTariffRequest({
  platform,
  user,
  chat,
  tariff,
  quota,
}) {
  const message = buildPaymentRequestMessage({
    platform,
    user,
    chat,
    tariff,
    quota,
  });

  return sendPaymentRequestNotification({
    botToken: config.telegramBotToken,
    proxyUrl: config.telegramProxyUrl,
    chatIds: config.paymentRequests.telegramChatIds,
    message,
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

validateConfig();

const bot = new Bot(config.maxBotToken);
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
    description: 'Выбрать режим: Free или Chat GPT',
  },
  {
    name: 'tariff',
    description: 'Посмотреть тариф и оставить заявку',
  },
]);

bot.on('bot_started', async (ctx) => {
  const conversationKey = getConversationKey(ctx);
  const activeBackend = backendStore.get(conversationKey);
  await trackInteraction(ctx, activeBackend);

  await sendModeMenu(
    ctx,
    activeBackend,
    'Привет! Я умею отвечать через Free и Chat GPT. Тарифы, лимиты и заявки доступны через /tariff.',
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
      '3. /mode открывает меню переключения между Free и Chat GPT.',
      '4. /tariff показывает остаток токенов и отправляет заявку на тариф администратору.',
      '5. /reset очищает историю для обоих режимов.',
    ].join('\n'),
  );
});

bot.command('reset', async (ctx) => {
  const conversationKey = getConversationKey(ctx);
  const activeBackend = backendStore.get(conversationKey);
  await trackInteraction(ctx, activeBackend);

  await resetConversationHistory(history, codexSessions, conversationKey);

  await sendModeMenu(ctx, activeBackend, 'История диалога очищена для Free и Chat GPT.');
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
    const user = getUserData(ctx);
    const allowedBackendIds = getAllowedBackendIds(user);

    if (!allowedBackendIds.includes(backendId)) {
      await ctx.answerOnCallback({ notification: 'Этот режим доступен только владельцу.' }).catch(() => {});
      await sendModeMenu(ctx, resolveVisibleBackend(backendStore.get(conversationKey), user));
      return;
    }

    const previousBackend = backendStore.get(conversationKey);
    const nextBackend = backendId;
    const changed = previousBackend !== nextBackend;

    backendStore.set(conversationKey, nextBackend);
    await trackInteraction(ctx, nextBackend);

    const text = getModeText(nextBackend, user);
    const extra = {
      attachments: getModeKeyboard(nextBackend, user),
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
  bot.action(`tariff_request:${tariff.id}`, async (ctx) => {
    const user = getUserData(ctx);

    if (!user) {
      await ctx.answerOnCallback({ notification: 'Не удалось определить пользователя.' }).catch(() => {});
      return;
    }

    const quota = await metrics.getUserQuota(user.userId);
    const chat = getChatData(ctx);

    try {
      const notifyResult = await submitTariffRequest({
        platform: 'max',
        user,
        chat,
        tariff,
        quota,
      });

      if (!notifyResult.sent) {
        await ctx.answerOnCallback({ notification: 'Прием заявок пока не настроен.' }).catch(() => {});
        await replyText(ctx, 'Сейчас прием заявок не настроен. Напишите администратору напрямую.');
        return;
      }
    } catch (error) {
      console.error('Failed to send tariff request:', error);
      await ctx.answerOnCallback({ notification: 'Не удалось отправить заявку.' }).catch(() => {});
      await replyText(ctx, 'Не удалось отправить заявку. Попробуйте позже или напишите администратору напрямую.');
      return;
    }

    const text = [
      `Заявка на тариф ${tariff.name} отправлена администратору.`,
      '',
      getTariffText(quota),
    ].join('\n');
    const extra = {
      attachments: getTariffKeyboard(quota.planId),
    };

    await ctx.answerOnCallback({ notification: 'Заявка отправлена.' }).catch(() => {});

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
  let imageInput = null;

  try {
    imageInput = await extractMaxImageInput(ctx);
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
  const user = getUserData(ctx);
  const storedBackend = backendStore.get(conversationKey);
  const activeBackend = resolveVisibleBackend(storedBackend, user);
  if (activeBackend !== storedBackend) {
    backendStore.set(conversationKey, activeBackend);
  }
  const backend = BACKENDS[activeBackend];
  const client = clients[activeBackend];
  const historyKey = getBackendHistoryKey(conversationKey, activeBackend);
  await trackInteraction(ctx, activeBackend);
  const hasImage = Boolean(imageInput);
  const requestText = buildRequestPreview(text, hasImage);

  if (user) {
    const quota = await metrics.getUserQuota(user.userId);

    if (quota.isBlocked) {
      await replyText(ctx, 'Доступ к боту сейчас отключён администратором.');
      return;
    }

    if (activeBackend !== config.freeBackendId && quota.remainingTokens <= 0) {
      await sendTariffMenu(
        ctx,
        quota,
        'Лимит токенов на текущем тарифе исчерпан. Оставьте заявку на другой тариф или попросите администратора увеличить лимит.',
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

console.log(`Starting MAX bot with default backend ${config.defaultBackend}...`);
await bot.start({
  allowedUpdates: ['bot_started', 'message_created', 'message_callback'],
});
