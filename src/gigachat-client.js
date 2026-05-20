import crypto from 'node:crypto';
import https from 'node:https';
import nodeFetch from 'node-fetch';

function trimTrailingSlashes(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function resolveChatEndpoint(baseUrl) {
  const normalizedBaseUrl = trimTrailingSlashes(baseUrl);

  if (normalizedBaseUrl.endsWith('/chat/completions')) {
    return normalizedBaseUrl;
  }

  if (/\/api\/v\d+$/i.test(normalizedBaseUrl)) {
    return `${normalizedBaseUrl}/chat/completions`;
  }

  return `${normalizedBaseUrl}/api/v1/chat/completions`;
}

function parseTokenCount(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return 0;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const promptTokens = parseTokenCount(usage.prompt_tokens, usage.promptTokens);
  const completionTokens = parseTokenCount(usage.completion_tokens, usage.completionTokens);
  const totalTokens = parseTokenCount(usage.total_tokens, usage.totalTokens) || (promptTokens + completionTokens);

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function normalizeMessages(messages) {
  return messages
    .filter((message) => message && typeof message.role === 'string')
    .map((message) => ({
      role: message.role,
      content: typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? ''),
    }))
    .filter((message) => message.content.trim());
}

export class GigaChatClient {
  constructor(config) {
    this.config = config;
    this.accessToken = '';
    this.expiresAtMs = 0;
    this.agent = config.rejectUnauthorized === false
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;
  }

  async getAccessToken(timeoutMs) {
    const now = Date.now();

    if (this.accessToken && this.expiresAtMs - 60_000 > now) {
      return this.accessToken;
    }

    if (!this.config.authKey) {
      throw new Error('GIGACHAT_AUTH_KEY is missing');
    }

    const response = await nodeFetch(this.config.oauthUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        RqUID: crypto.randomUUID(),
        Authorization: `Basic ${this.config.authKey}`,
      },
      body: new URLSearchParams({
        scope: this.config.scope,
      }),
      agent: this.agent,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(`GigaChat auth failed: ${rawText.trim() || `${response.status} ${response.statusText}`}`);
    }

    const payload = JSON.parse(rawText);
    const token = String(payload.access_token ?? '').trim();

    if (!token) {
      throw new Error('GigaChat auth returned no access_token');
    }

    this.accessToken = token;
    this.expiresAtMs = Number(payload.expires_at) || (Date.now() + 25 * 60 * 1000);

    return this.accessToken;
  }

  async ask(messages, timeoutMs) {
    const accessToken = await this.getAccessToken(timeoutMs);
    const response = await nodeFetch(resolveChatEndpoint(this.config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: normalizeMessages(messages),
        stream: false,
      }),
      agent: this.agent,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(`GigaChat request failed: ${rawText.trim() || `${response.status} ${response.statusText}`}`);
    }

    const payload = JSON.parse(rawText);
    const text = String(payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text ?? '').trim();

    if (!text) {
      throw new Error('GigaChat returned an empty response');
    }

    return {
      text,
      provider: 'GigaChat',
      model: payload.model ?? this.config.model,
      usage: normalizeUsage(payload.usage),
      responseId: '',
    };
  }
}
