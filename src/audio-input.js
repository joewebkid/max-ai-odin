import nodeFetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TELEGRAM_FILE_BASE_URL = 'https://api.telegram.org/file';
const AUDIO_EXTENSION_TO_CONTENT_TYPE = new Map([
  ['.oga', 'audio/ogg;codecs=opus'],
  ['.ogg', 'audio/ogg;codecs=opus'],
  ['.opus', 'audio/ogg;codecs=opus'],
  ['.mp3', 'audio/mpeg'],
  ['.mpeg', 'audio/mpeg'],
  ['.flac', 'audio/flac'],
  ['.wav', 'audio/x-pcm;bit=16;rate=16000'],
  ['.pcm', 'audio/x-pcm;bit=16;rate=16000'],
]);

function formatMegabytes(bytes) {
  return Math.floor(bytes / (1024 * 1024));
}

export class AudioInputError extends Error {
  constructor(message, code = 'audio_input_error') {
    super(message);
    this.name = 'AudioInputError';
    this.code = code;
  }
}

function buildTelegramFileUrl(token, filePath) {
  return `${TELEGRAM_FILE_BASE_URL}/bot${token}/${filePath.replace(/^\/+/, '')}`;
}

function getExtension(value) {
  const match = String(value ?? '').toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/);
  return match ? `.${match[1]}` : '';
}

function normalizeContentType(mimeType, fallbackValue = '') {
  const normalizedMimeType = String(mimeType ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();

  if (normalizedMimeType === 'audio/ogg' || normalizedMimeType === 'audio/opus') {
    return 'audio/ogg;codecs=opus';
  }

  if (normalizedMimeType === 'audio/mpeg' || normalizedMimeType === 'audio/mp3') {
    return 'audio/mpeg';
  }

  if (normalizedMimeType === 'audio/flac' || normalizedMimeType === 'audio/x-flac') {
    return 'audio/flac';
  }

  if (
    normalizedMimeType === 'audio/wav'
    || normalizedMimeType === 'audio/x-wav'
    || normalizedMimeType === 'audio/wave'
    || normalizedMimeType === 'audio/x-pcm'
  ) {
    return 'audio/x-pcm;bit=16;rate=16000';
  }

  if (normalizedMimeType.startsWith('audio/')) {
    return normalizedMimeType;
  }

  const extension = getExtension(fallbackValue);

  return AUDIO_EXTENSION_TO_CONTENT_TYPE.get(extension) ?? '';
}

function isSupportedAudioContentType(contentType) {
  return [
    'audio/ogg;codecs=opus',
    'audio/mpeg',
    'audio/flac',
    'audio/x-pcm;bit=16;rate=16000',
    'audio/pcma;rate=8000',
    'audio/pcmu;rate=8000',
    'audio/g729',
  ].includes(contentType);
}

function isAudioDocument(document) {
  return Boolean(normalizeContentType(document?.mime_type, document?.file_name));
}

function getMaxAttachmentPayloadValue(attachment, keys) {
  for (const key of keys) {
    const value = attachment?.payload?.[key] ?? attachment?.[key];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function getMaxAudioTranscriptionValue(attachment) {
  const candidates = [
    attachment?.payload?.transcription,
    attachment?.transcription,
    attachment?.payload?.transcript,
    attachment?.transcript,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function isMaxAudioAttachment(attachment) {
  const type = String(attachment?.type ?? '').toLowerCase();

  if (['audio', 'voice'].includes(type)) {
    return true;
  }

  if (!['file', 'attachment', 'document'].includes(type)) {
    return false;
  }

  const mimeType = getMaxAttachmentPayloadValue(attachment, ['mime_type', 'mimeType', 'content_type', 'contentType']);
  const fileName = getMaxAttachmentPayloadValue(attachment, ['file_name', 'fileName', 'name']);

  return Boolean(normalizeContentType(mimeType, fileName));
}

function findMaxAudioAttachment(attachments) {
  return attachments.find((attachment) => isMaxAudioAttachment(attachment)) ?? null;
}

async function downloadAudioBuffer(url, {
  headers = {},
  proxyUrl = '',
  maxBytes = DEFAULT_MAX_AUDIO_BYTES,
  contentTypeHint = '',
  fileNameHint = '',
} = {}) {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  const response = await nodeFetch(url, {
    headers,
    agent,
  });

  if (!response.ok) {
    throw new AudioInputError(`Не удалось скачать аудио: HTTP ${response.status}`, 'download_failed');
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AudioInputError(`Аудио слишком большое. Сейчас поддерживается до ${formatMegabytes(maxBytes)} МБ.`, 'audio_too_large');
  }

  const contentType = normalizeContentType(
    contentTypeHint || response.headers.get('content-type'),
    fileNameHint || url,
  );

  if (!contentType || !isSupportedAudioContentType(contentType)) {
    throw new AudioInputError('Этот формат аудио пока не поддерживается. Лучше отправьте голосовое OGG/Opus, MP3, FLAC или WAV.', 'unsupported_media_type');
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length === 0) {
    throw new AudioInputError('Не удалось прочитать аудио.', 'empty_audio');
  }

  if (buffer.length > maxBytes) {
    throw new AudioInputError(`Аудио слишком большое. Сейчас поддерживается до ${formatMegabytes(maxBytes)} МБ.`, 'audio_too_large');
  }

  return {
    buffer,
    contentType,
    sizeBytes: buffer.length,
  };
}

export async function extractTelegramAudioInput(ctx, {
  botToken,
  proxyUrl = '',
  maxBytes = DEFAULT_MAX_AUDIO_BYTES,
} = {}) {
  const message = ctx.message;

  if (!message) {
    return null;
  }

  const source = message.voice
    ?? message.audio
    ?? (isAudioDocument(message.document) ? message.document : null);

  if (!source?.file_id) {
    return null;
  }

  if (!botToken) {
    throw new AudioInputError('TELEGRAM_BOT_TOKEN is missing for audio download.', 'misconfigured');
  }

  if (source.file_size && source.file_size > maxBytes) {
    throw new AudioInputError(`Аудио слишком большое. Сейчас поддерживается до ${formatMegabytes(maxBytes)} МБ.`, 'audio_too_large');
  }

  const file = await ctx.api.getFile(source.file_id);

  if (!file?.file_path) {
    throw new AudioInputError('Telegram не вернул путь к аудио.', 'file_path_missing');
  }

  const audio = await downloadAudioBuffer(
    buildTelegramFileUrl(botToken, file.file_path),
    {
      proxyUrl,
      maxBytes,
      contentTypeHint: source.mime_type,
      fileNameHint: source.file_name ?? file.file_path,
    },
  );

  return {
    ...audio,
    platform: 'telegram',
    fileId: source.file_id,
    filePath: file.file_path,
    fileName: source.file_name ?? file.file_path.split('/').pop() ?? 'audio.ogg',
    durationSeconds: source.duration ?? null,
  };
}

export async function extractMaxAudioInput(ctx, {
  maxBytes = DEFAULT_MAX_AUDIO_BYTES,
} = {}) {
  const attachments = ctx.message?.body?.attachments;

  if (!Array.isArray(attachments)) {
    return null;
  }

  const audioAttachment = findMaxAudioAttachment(attachments);

  if (!audioAttachment) {
    return null;
  }

  const url = getMaxAttachmentPayloadValue(audioAttachment, ['url', 'download_url', 'downloadUrl', 'file_url', 'fileUrl']);

  if (!url) {
    return null;
  }

  const mimeType = getMaxAttachmentPayloadValue(audioAttachment, ['mime_type', 'mimeType', 'content_type', 'contentType']);
  const fileName = getMaxAttachmentPayloadValue(audioAttachment, ['file_name', 'fileName', 'name']);
  const audio = await downloadAudioBuffer(url, {
    maxBytes,
    contentTypeHint: mimeType,
    fileNameHint: fileName || url,
  });

  return {
    ...audio,
    platform: 'max',
    url,
    fileName: fileName || url.split('/').pop() || 'audio',
    token: audioAttachment.payload?.token ?? null,
  };
}

export function extractMaxAudioTranscript(ctx) {
  const attachments = ctx.message?.body?.attachments;

  if (!Array.isArray(attachments)) {
    return '';
  }

  const audioAttachment = findMaxAudioAttachment(attachments);

  if (!audioAttachment) {
    return '';
  }

  return getMaxAudioTranscriptionValue(audioAttachment);
}

export function hasMaxAudioAttachment(ctx) {
  const attachments = ctx.message?.body?.attachments;

  if (!Array.isArray(attachments)) {
    return false;
  }

  return Boolean(findMaxAudioAttachment(attachments));
}
