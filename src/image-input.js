import nodeFetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const DEFAULT_MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const TELEGRAM_FILE_BASE_URL = 'https://api.telegram.org/file';
const IMAGE_EXTENSION_TO_MIME = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
]);

export const DEFAULT_IMAGE_PROMPT = 'Опиши изображение и распознай текст, если он есть.';

export class ImageInputError extends Error {
  constructor(message, code = 'image_input_error') {
    super(message);
    this.name = 'ImageInputError';
    this.code = code;
  }
}

function buildTelegramFileUrl(token, filePath) {
  return `${TELEGRAM_FILE_BASE_URL}/bot${token}/${filePath.replace(/^\/+/, '')}`;
}

function inferMimeType(url, contentType) {
  const normalizedContentType = String(contentType ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();

  if (normalizedContentType.startsWith('image/')) {
    return normalizedContentType;
  }

  const match = String(url ?? '').toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/);
  const extension = match ? `.${match[1]}` : '';

  if (extension && IMAGE_EXTENSION_TO_MIME.has(extension)) {
    return IMAGE_EXTENSION_TO_MIME.get(extension);
  }

  return 'image/jpeg';
}

function isImageDocument(document) {
  return Boolean(document?.mime_type && String(document.mime_type).toLowerCase().startsWith('image/'));
}

async function downloadImageAsDataUrl(url, {
  headers = {},
  proxyUrl = '',
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
} = {}) {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  const response = await nodeFetch(url, {
    headers,
    agent,
  });

  if (!response.ok) {
    throw new ImageInputError(`Не удалось скачать изображение: HTTP ${response.status}`, 'download_failed');
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ImageInputError(
      `Изображение слишком большое. Лимит сейчас ${Math.floor(maxBytes / (1024 * 1024))} МБ.`,
      'image_too_large',
    );
  }

  const mimeType = inferMimeType(url, response.headers.get('content-type'));

  if (!mimeType.startsWith('image/')) {
    throw new ImageInputError('Пришёл файл, который не выглядит как изображение.', 'unsupported_media_type');
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length === 0) {
    throw new ImageInputError('Не удалось прочитать изображение.', 'empty_image');
  }

  if (buffer.length > maxBytes) {
    throw new ImageInputError(
      `Изображение слишком большое. Лимит сейчас ${Math.floor(maxBytes / (1024 * 1024))} МБ.`,
      'image_too_large',
    );
  }

  return {
    mimeType,
    sizeBytes: buffer.length,
    imageUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
  };
}

export async function extractTelegramImageInput(ctx, {
  botToken,
  proxyUrl = '',
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
} = {}) {
  const message = ctx.message;

  if (!message) {
    return null;
  }

  const photo = Array.isArray(message.photo) && message.photo.length > 0
    ? message.photo.at(-1)
    : null;
  const document = isImageDocument(message.document) ? message.document : null;
  const fileId = photo?.file_id ?? document?.file_id ?? null;

  if (!fileId) {
    return null;
  }

  if (!botToken) {
    throw new ImageInputError('TELEGRAM_BOT_TOKEN is missing for image download.', 'misconfigured');
  }

  const file = await ctx.api.getFile(fileId);

  if (!file?.file_path) {
    throw new ImageInputError('Telegram не вернул путь к изображению.', 'file_path_missing');
  }

  const image = await downloadImageAsDataUrl(
    buildTelegramFileUrl(botToken, file.file_path),
    {
      proxyUrl,
      maxBytes,
    },
  );

  return {
    ...image,
    platform: 'telegram',
    fileId,
    filePath: file.file_path,
  };
}

export async function extractMaxImageInput(ctx, {
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
} = {}) {
  const attachments = ctx.message?.body?.attachments;

  if (!Array.isArray(attachments)) {
    return null;
  }

  const imageAttachment = attachments.find((attachment) => (
    attachment?.type === 'image'
    && typeof attachment?.payload?.url === 'string'
    && attachment.payload.url.trim()
  ));

  if (!imageAttachment) {
    return null;
  }

  const image = await downloadImageAsDataUrl(imageAttachment.payload.url, {
    maxBytes,
  });

  return {
    ...image,
    platform: 'max',
    url: imageAttachment.payload.url,
    token: imageAttachment.payload.token ?? null,
  };
}
