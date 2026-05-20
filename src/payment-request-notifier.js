import nodeFetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

function formatValue(value, fallback = '-') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value || 0));
}

function buildUserLine(user) {
  if (!user) {
    return '-';
  }

  const parts = [
    formatValue(user.name),
    user.username ? `(${user.username})` : '',
    `id: ${formatValue(user.userId)}`,
  ].filter(Boolean);

  return parts.join(' ');
}

function buildChatLine(chat) {
  if (!chat) {
    return '-';
  }

  const title = chat.title ? `${chat.title} ` : '';
  return `${title}id: ${formatValue(chat.chatId)}${chat.type ? `, ${chat.type}` : ''}`;
}

export function buildPaymentRequestMessage({
  platform,
  user,
  chat,
  tariff,
  quota,
}) {
  return [
    'Новая заявка на тариф',
    '',
    `Платформа: ${formatValue(platform)}`,
    `Пользователь: ${buildUserLine(user)}`,
    `Чат: ${buildChatLine(chat)}`,
    '',
    `Желаемый тариф: ${formatValue(tariff?.name)} (${formatValue(tariff?.id)})`,
    `Цена: ${formatValue(tariff?.priceText)}`,
    `Лимит тарифа: ${formatNumber(tariff?.monthlyTokens)} токенов`,
    '',
    `Текущий тариф: ${formatValue(quota?.planName)}`,
    `Осталось сейчас: ${formatNumber(quota?.remainingTokens)} токенов`,
    `Потрачено в цикле: ${formatNumber(quota?.cycleSpentTokens)} токенов`,
    '',
    'Действие: откройте max-admin и назначьте тариф пользователю вручную.',
  ].join('\n');
}

export async function sendPaymentRequestNotification({
  botToken,
  proxyUrl = '',
  chatIds = [],
  message,
}) {
  const normalizedChatIds = Array.isArray(chatIds)
    ? chatIds.map((chatId) => String(chatId).trim()).filter(Boolean)
    : [];

  if (!botToken || normalizedChatIds.length === 0) {
    return {
      sent: false,
      reason: 'not_configured',
    };
  }

  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const results = await Promise.all(normalizedChatIds.map(async (chatId) => {
    const response = await nodeFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      agent,
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Telegram notify failed for ${chatId}: HTTP ${response.status} ${body}`);
    }

    return response.json();
  }));

  return {
    sent: true,
    results,
  };
}
