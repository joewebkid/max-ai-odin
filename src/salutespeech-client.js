import crypto from 'node:crypto';
import https from 'node:https';
import nodeFetch from 'node-fetch';

function parseExpiresAt(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now() + 25 * 60 * 1000;
  }

  return parsed;
}

function normalizeTranscript(payload) {
  if (Array.isArray(payload?.result)) {
    return payload.result
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  if (typeof payload?.text === 'string') {
    return payload.text.trim();
  }

  return '';
}

export class SaluteSpeechClient {
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
      throw new Error('SALUTESPEECH_AUTH_KEY is missing');
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
      throw new Error(`SaluteSpeech auth failed: ${rawText.trim() || `${response.status} ${response.statusText}`}`);
    }

    const payload = JSON.parse(rawText);
    const token = String(payload.access_token ?? '').trim();

    if (!token) {
      throw new Error('SaluteSpeech auth returned no access_token');
    }

    this.accessToken = token;
    this.expiresAtMs = parseExpiresAt(payload.expires_at);

    return this.accessToken;
  }

  async transcribeAudio(audioInput, timeoutMs) {
    const accessToken = await this.getAccessToken(timeoutMs);
    const response = await nodeFetch(this.config.recognizeUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': audioInput.contentType,
        Authorization: `Bearer ${accessToken}`,
      },
      body: audioInput.buffer,
      agent: this.agent,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(`SaluteSpeech request failed: ${rawText.trim() || `${response.status} ${response.statusText}`}`);
    }

    const payload = JSON.parse(rawText);

    return {
      text: normalizeTranscript(payload),
      provider: 'SaluteSpeech',
      model: 'speech:recognize',
      raw: payload,
    };
  }
}
