function trimTrailingSlashes(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function resolveTranscriptionsEndpoint(baseUrl) {
  const normalizedBaseUrl = trimTrailingSlashes(baseUrl);

  if (normalizedBaseUrl.endsWith('/audio/transcriptions')) {
    return normalizedBaseUrl;
  }

  if (/\/v\d+$/i.test(normalizedBaseUrl)) {
    return `${normalizedBaseUrl}/audio/transcriptions`;
  }

  return `${normalizedBaseUrl}/v1/audio/transcriptions`;
}

function buildHeaders(apiKey) {
  const headers = {
    accept: 'application/json',
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function getFileName(audioInput) {
  const fileName = String(audioInput?.fileName ?? '').trim();

  if (fileName) {
    return fileName;
  }

  if (audioInput?.contentType === 'audio/ogg;codecs=opus') {
    return 'audio.ogg';
  }

  if (audioInput?.contentType === 'audio/mpeg') {
    return 'audio.mp3';
  }

  if (audioInput?.contentType === 'audio/flac') {
    return 'audio.flac';
  }

  return 'audio.wav';
}

function getMultipartMimeType(audioInput) {
  const contentType = String(audioInput?.contentType ?? '').toLowerCase();

  if (contentType.includes('audio/ogg')) {
    return 'audio/ogg';
  }

  if (contentType.includes('audio/mpeg') || contentType.includes('audio/mp3')) {
    return 'audio/mpeg';
  }

  if (contentType.includes('audio/flac')) {
    return 'audio/flac';
  }

  if (contentType.includes('audio/x-pcm') || contentType.includes('audio/wav')) {
    return 'audio/wav';
  }

  return contentType || 'application/octet-stream';
}

function normalizeTranscript(payload) {
  if (typeof payload?.text === 'string') {
    return payload.text.trim();
  }

  if (typeof payload?.transcript === 'string') {
    return payload.transcript.trim();
  }

  if (Array.isArray(payload?.segments)) {
    return payload.segments
      .map((segment) => String(segment?.text ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  return '';
}

function normalizeErrorDetails(rawText, response) {
  const trimmed = rawText.trim();

  if (!trimmed) {
    return `${response.status} ${response.statusText}`;
  }

  try {
    const payload = JSON.parse(trimmed);
    const message = String(payload?.error?.message ?? payload?.message ?? '').trim();

    if (message.includes('<html') || message.includes('challenge-platform')) {
      return 'upstream returned an HTML/Cloudflare challenge page';
    }

    if (message) {
      return message.slice(0, 500);
    }
  } catch {
    // Fall through to plain-text handling.
  }

  if (trimmed.includes('<html') || trimmed.includes('challenge-platform')) {
    return 'upstream returned an HTML/Cloudflare challenge page';
  }

  return trimmed.slice(0, 500);
}

export class CodexTranscriptionClient {
  constructor(config) {
    this.config = config;
  }

  async transcribeAudio(audioInput, timeoutMs) {
    if (!this.config.baseUrl) {
      throw new Error('CODEX_BASE_URL is missing');
    }

    const formData = new FormData();
    const file = new Blob([audioInput.buffer], {
      type: getMultipartMimeType(audioInput),
    });

    formData.append('file', file, getFileName(audioInput));
    formData.append('model', this.config.transcriptionModel);
    formData.append('response_format', 'json');

    const response = await fetch(resolveTranscriptionsEndpoint(this.config.baseUrl), {
      method: 'POST',
      headers: buildHeaders(this.config.apiKey),
      body: formData,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(`Codex transcription failed: ${normalizeErrorDetails(rawText, response)}`);
    }

    const payload = JSON.parse(rawText);

    return {
      text: normalizeTranscript(payload),
      provider: 'codex-lb',
      model: this.config.transcriptionModel,
      raw: payload,
    };
  }
}
