function buildHeaders(apiKey) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream, text/plain',
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['g4f-api-key'] = apiKey;
    headers['x-api-key'] = apiKey;
  }

  return headers;
}

function resolveCryptosmiEndpoint(baseUrl, generatePath) {
  if (/^https?:\/\//i.test(generatePath)) {
    return generatePath;
  }

  const normalizedPath = generatePath.startsWith('/') ? generatePath : `/${generatePath}`;
  return `${baseUrl}${normalizedPath}`;
}

function resolveOpenAIEndpoint(baseUrl) {
  if (baseUrl.endsWith('/chat/completions')) {
    return baseUrl;
  }

  if (/\/v\d+$/.test(baseUrl)) {
    return `${baseUrl}/chat/completions`;
  }

  return `${baseUrl}/v1/chat/completions`;
}

function resolveResponsesEndpoint(baseUrl) {
  if (baseUrl.endsWith('/responses')) {
    return baseUrl;
  }

  if (/\/v\d+$/.test(baseUrl)) {
    return `${baseUrl}/responses`;
  }

  return `${baseUrl}/v1/responses`;
}

function resolveBackendApiEndpoint(baseUrl) {
  if (baseUrl.endsWith('/conversation')) {
    return baseUrl;
  }

  if (baseUrl.endsWith('/backend-api/v2')) {
    return `${baseUrl}/conversation`;
  }

  return `${baseUrl}/backend-api/v2/conversation`;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeKnownProviderArtifacts(text, provider) {
  if (!text) {
    return text;
  }

  let sanitized = text.trim();

  if (provider === 'ApiAirforce') {
    sanitized = sanitized
      .replace(/\n+\s*Need proxies cheaper than the market\?\s*\n+\s*https?:\/\/\S+\s*$/i, '')
      .replace(/\n+\s*https?:\/\/op\.wtf\S*\s*$/i, '')
      .trim();
  }

  return sanitized;
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

  const promptTokens = parseTokenCount(
    usage.promptTokens,
    usage.prompt_tokens,
    usage.inputTokens,
    usage.input_tokens,
  );
  const completionTokens = parseTokenCount(
    usage.completionTokens,
    usage.completion_tokens,
    usage.outputTokens,
    usage.output_tokens,
  );
  const totalTokens = parseTokenCount(
    usage.totalTokens,
    usage.total_tokens,
  ) || (promptTokens + completionTokens);

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function extractFromChoice(choice) {
  if (!choice || typeof choice !== 'object') {
    return '';
  }

  if (typeof choice.text === 'string') {
    return choice.text;
  }

  if (typeof choice.message?.content === 'string') {
    return choice.message.content;
  }

  if (typeof choice.delta?.content === 'string') {
    return choice.delta.content;
  }

  return '';
}

function collectText(node, chunks, errors) {
  if (node == null) {
    return;
  }

  if (typeof node === 'string') {
    chunks.push(node);
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectText(item, chunks, errors);
    }

    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  if (node.type === 'error') {
    const errorMessage = node.message || node.content || node.error;

    if (typeof errorMessage === 'string' && errorMessage.trim()) {
      errors.push(errorMessage.trim());
    }
  }

  if (typeof node.error === 'string' && node.error.trim()) {
    errors.push(node.error.trim());
  }

  if (typeof node.detail === 'string' && node.detail.trim()) {
    errors.push(node.detail.trim());
  }

  if (typeof node.content === 'string' && (node.type === 'content' || node.type == null)) {
    chunks.push(node.content);
  }

  if (typeof node.answer === 'string') {
    chunks.push(node.answer);
  }

  if (typeof node.text === 'string') {
    chunks.push(node.text);
  }

  if (typeof node.message?.content === 'string') {
    chunks.push(node.message.content);
  }

  if (Array.isArray(node.content)) {
    collectText(node.content, chunks, errors);
  }

  if (Array.isArray(node.output)) {
    collectText(node.output, chunks, errors);
  }

  if (Array.isArray(node.choices)) {
    for (const choice of node.choices) {
      const value = extractFromChoice(choice);

      if (value) {
        chunks.push(value);
      }
    }
  }
}

function collectMetadata(node, metadata) {
  if (node == null) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectMetadata(item, metadata);
    }

    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  const usage = normalizeUsage(node.usage);

  if (usage) {
    metadata.usage = usage;
  }

  if (typeof node.model === 'string' && node.model.trim()) {
    metadata.model = node.model;
  }

  if (node.object === 'response' && typeof node.id === 'string' && node.id.trim()) {
    metadata.responseId = node.id;
  }

  if (typeof node.provider === 'string' && node.provider.trim()) {
    metadata.provider = node.provider;
  } else if (node.provider && typeof node.provider === 'object') {
    if (typeof node.provider.name === 'string' && node.provider.name.trim()) {
      metadata.provider = node.provider.name;
    }

    if (typeof node.provider.model === 'string' && node.provider.model.trim()) {
      metadata.model = node.provider.model;
    }
  }

  if (node.response && typeof node.response === 'object') {
    collectMetadata(node.response, metadata);
  }

  if (node.message && typeof node.message === 'object') {
    collectMetadata(node.message, metadata);
  }

  if (node.delta && typeof node.delta === 'object') {
    collectMetadata(node.delta, metadata);
  }

  if (Array.isArray(node.output)) {
    collectMetadata(node.output, metadata);
  }

  if (Array.isArray(node.content)) {
    collectMetadata(node.content, metadata);
  }

  if (Array.isArray(node.choices)) {
    for (const choice of node.choices) {
      collectMetadata(choice, metadata);
    }
  }
}

function extractResultFromRawPayload(rawText) {
  const directJson = tryParseJson(rawText);

  if (directJson !== null) {
    const chunks = [];
    const errors = [];
    const metadata = {
      provider: '',
      model: '',
      usage: null,
      responseId: '',
    };

    collectText(directJson, chunks, errors);
    collectMetadata(directJson, metadata);
    const text = sanitizeKnownProviderArtifacts(
      chunks.join('').trim(),
      metadata.provider,
    );

    if (text) {
      return {
        text,
        provider: metadata.provider,
        model: metadata.model,
        usage: metadata.usage,
        responseId: metadata.responseId,
      };
    }

    if (errors.length > 0) {
      throw new Error(errors[0]);
    }
  }

  const chunks = [];
  const errors = [];
  const metadata = {
    provider: '',
    model: '',
    usage: null,
    responseId: '',
  };

  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('event:') || trimmed.startsWith('id:') || trimmed.startsWith(':')) {
      continue;
    }

    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;

    if (!payload || payload === '[DONE]') {
      continue;
    }

    const parsed = tryParseJson(payload);

    if (parsed !== null) {
      collectText(parsed, chunks, errors);
      collectMetadata(parsed, metadata);
      continue;
    }

    chunks.push(payload);
  }

  const text = sanitizeKnownProviderArtifacts(chunks.join('').trim(), '');

  if (text) {
    return {
      text,
      provider: metadata.provider,
      model: metadata.model,
      usage: metadata.usage,
      responseId: metadata.responseId,
    };
  }

  if (errors.length > 0) {
    throw new Error(errors[0]);
  }

  return rawText.trim();
}

function isTimeoutError(error) {
  if (!error) {
    return false;
  }

  return (
    error.name === 'TimeoutError'
    || String(error.message ?? '').toLowerCase().includes('aborted due to timeout')
    || String(error.message ?? '').toLowerCase().includes('timeout')
  );
}

function isEmptyResponseError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('empty response');
}

async function parseResponse(response) {
  const rawText = await response.text();

  if (!response.ok) {
    const details = rawText.trim() || `${response.status} ${response.statusText}`;
    throw new Error(`g4f request failed: ${details}`);
  }

  const answer = extractResultFromRawPayload(rawText);

  if (!answer?.text) {
    throw new Error('g4f returned an empty response');
  }

  return answer;
}

export class G4FClient {
  constructor(config) {
    this.config = config;
  }

  async ask(messages, timeoutMs) {
    if (this.config.mode === 'cryptosmi') {
      return this.askCryptosmi(messages, timeoutMs);
    }

    if (this.config.mode === 'openai') {
      return this.askOpenAI(messages, timeoutMs);
    }

    return this.askBackendApi(messages, timeoutMs);
  }

  buildResponsesBootstrapText(historyMessages, userText) {
    const turns = Array.isArray(historyMessages)
      ? historyMessages
        .filter((message) => message && typeof message.content === 'string' && message.content.trim())
        .map((message) => `${message.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${message.content.trim()}`)
      : [];

    if (turns.length === 0) {
      return String(userText ?? '').trim();
    }

    const normalizedUserText = String(userText ?? '').trim();

    return [
      'Продолжай диалог, учитывая локально сохранённый контекст предыдущих сообщений.',
      '',
      'Контекст:',
      turns.join('\n\n'),
      '',
      normalizedUserText
        ? `Новый запрос пользователя:\n${normalizedUserText}`
        : 'Продолжи разговор с учётом этого контекста.',
    ].join('\n');
  }

  buildResponsesInput(userText, inputImage = null, historyMessages = []) {
    const content = [];
    const normalizedText = Array.isArray(historyMessages) && historyMessages.length > 0
      ? this.buildResponsesBootstrapText(historyMessages, userText)
      : String(userText ?? '').trim();

    if (normalizedText) {
      content.push({
        type: 'input_text',
        text: normalizedText,
      });
    }

    if (inputImage?.imageUrl) {
      content.push({
        type: 'input_image',
        image_url: inputImage.imageUrl,
        detail: inputImage.detail ?? 'auto',
      });
    }

    return [{
      role: 'user',
      content,
    }];
  }

  buildVisionMessages(systemPrompt, userText, inputImage) {
    const messages = [];
    const content = [];
    const normalizedText = String(userText ?? '').trim();

    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    if (normalizedText) {
      content.push({
        type: 'text',
        text: normalizedText,
      });
    }

    if (inputImage?.imageUrl) {
      content.push({
        type: 'image_url',
        image_url: {
          url: inputImage.imageUrl,
          detail: inputImage.detail ?? 'auto',
        },
      });
    }

    messages.push({
      role: 'user',
      content,
    });

    return messages;
  }

  isRecoverablePreviousResponseError(error) {
    const message = String(error?.message ?? '').toLowerCase();

    return (
      message.includes('previous_response_id')
      || message.includes('response not found')
      || message.includes('unknown response')
      || message.includes('invalid previous response')
      || message.includes('session not found')
    );
  }

  async askResponsesTurn({
    systemPrompt,
    userText,
    previousResponseId,
    inputImage = null,
    historyMessages = [],
  }, timeoutMs) {
    const makeRequest = async (responseId, requestTimeoutMs = timeoutMs) => {
      const payload = {
        model: this.config.model,
        stream: false,
        input: this.buildResponsesInput(
          userText,
          inputImage,
          responseId ? [] : historyMessages,
        ),
      };

      if (systemPrompt) {
        payload.instructions = systemPrompt;
      }

      if (responseId) {
        payload.previous_response_id = responseId;
      }

      const response = await fetch(resolveResponsesEndpoint(this.config.baseUrl), {
        method: 'POST',
        headers: buildHeaders(this.config.apiKey),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      return parseResponse(response);
    };

    try {
      return await makeRequest(previousResponseId);
    } catch (error) {
      if (previousResponseId && this.isRecoverablePreviousResponseError(error)) {
        const retried = await makeRequest(null, Math.min(timeoutMs, 45_000));
        return {
          ...retried,
          sessionReset: true,
        };
      }

      if (previousResponseId && isTimeoutError(error)) {
        const retried = await makeRequest(null, Math.min(timeoutMs, 45_000));
        return {
          ...retried,
          sessionReset: true,
          timeoutRecovered: true,
        };
      }

      throw error;
    }
  }

  buildCryptosmiPrompt(messages) {
    return messages
      .map((message) => {
        const roleLabel = message.role === 'system'
          ? 'Системная инструкция'
          : message.role === 'assistant'
            ? 'Ассистент'
            : 'Пользователь';

        return `${roleLabel}:\n${message.content}`;
      })
      .join('\n\n');
  }

  async askCryptosmi(messages, timeoutMs) {
    const response = await fetch(resolveCryptosmiEndpoint(this.config.baseUrl, this.config.generatePath), {
      method: 'POST',
      headers: buildHeaders(this.config.apiKey),
      body: JSON.stringify({
        modelUri: this.config.model,
        prompt: this.buildCryptosmiPrompt(messages),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    return parseResponse(response);
  }

  async askOpenAI(messages, timeoutMs) {
    const makeRequest = async (requestTimeoutMs = timeoutMs) => {
      const response = await fetch(resolveOpenAIEndpoint(this.config.baseUrl), {
        method: 'POST',
        headers: buildHeaders(this.config.apiKey),
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      return parseResponse(response);
    };

    try {
      return await makeRequest();
    } catch (error) {
      if (isEmptyResponseError(error)) {
        return makeRequest(Math.min(timeoutMs, 45_000));
      }

      throw error;
    }
  }

  async askBackendApi(messages, timeoutMs) {
    const payload = {
      model: this.config.model,
      messages,
      download_media: false,
    };

    if (this.config.provider) {
      payload.provider = this.config.provider;
    }

    const response = await fetch(resolveBackendApiEndpoint(this.config.baseUrl), {
      method: 'POST',
      headers: buildHeaders(this.config.apiKey),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    return parseResponse(response);
  }
}
