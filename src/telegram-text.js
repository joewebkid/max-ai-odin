import { marked } from 'marked';

const TELEGRAM_HTML_LIMIT = 3600;
const SUPPORTED_BLOCK_HTML_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'tg-spoiler',
  'code',
  'pre',
  'blockquote',
]);

function preprocessMarkdown(text) {
  return String(text ?? '').replace(/\|\|([^|\n][\s\S]*?[^|\n]?)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function repeatString(value, count) {
  return Array.from({ length: Math.max(0, count) }, () => value).join('');
}

function prefixMultiline(text, prefix, continuationIndent = repeatString(' ', prefix.length)) {
  const lines = String(text ?? '').split('\n');

  return lines.map((line, index) => {
    if (index === 0) {
      return `${prefix}${line}`;
    }

    return `${continuationIndent}${line}`;
  }).join('\n');
}

function splitLongString(value, maxLength) {
  if (value.length <= maxLength) {
    return [value];
  }

  const chunks = [];
  let remaining = value;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);

    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }

    if (splitAt < Math.floor(maxLength * 0.35)) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function renderTable(rows) {
  const widths = [];

  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }

  const formatRow = (row) => row
    .map((cell, index) => cell.padEnd(widths[index], ' '))
    .join(' | ')
    .trimEnd();
  const separator = widths.map((width) => repeatString('-', width)).join('-+-');

  return [
    formatRow(rows[0]),
    separator,
    ...rows.slice(1).map(formatRow),
  ].join('\n');
}

function sanitizeInlineHtml(raw) {
  const html = String(raw ?? '').trim();
  const simpleTagMatch = html.match(/^<\s*(\/?)\s*([a-zA-Z0-9-]+)([^>]*)>$/);

  if (!simpleTagMatch) {
    return escapeHtml(raw);
  }

  const [, slash, rawTagName, rawAttributes] = simpleTagMatch;
  const tagName = rawTagName.toLowerCase();

  if (!SUPPORTED_BLOCK_HTML_TAGS.has(tagName) && tagName !== 'a' && tagName !== 'br') {
    return escapeHtml(raw);
  }

  if (slash) {
    return `</${tagName}>`;
  }

  if (tagName === 'br') {
    return '<br>';
  }

  if (tagName === 'a') {
    const hrefMatch = rawAttributes.match(/\bhref\s*=\s*(['"])(.*?)\1/i);

    if (!hrefMatch) {
      return escapeHtml(raw);
    }

    return `<a href="${escapeHtmlAttribute(hrefMatch[2])}">`;
  }

  return `<${tagName}>`;
}

function renderInlineText(text) {
  return escapeHtml(String(text ?? ''));
}

function renderInlineTokens(tokens) {
  return (tokens ?? []).map((token) => renderInlineToken(token)).join('');
}

function renderInlineToken(token) {
  if (!token || typeof token !== 'object') {
    return '';
  }

  switch (token.type) {
    case 'text':
    case 'escape':
      return renderInlineText(token.text ?? token.raw ?? '');
    case 'strong':
      return `<b>${renderInlineTokens(token.tokens)}</b>`;
    case 'em':
      return `<i>${renderInlineTokens(token.tokens)}</i>`;
    case 'del':
      return `<s>${renderInlineTokens(token.tokens)}</s>`;
    case 'codespan':
      return `<code>${escapeHtml(token.text ?? '')}</code>`;
    case 'br':
      return '\n';
    case 'link':
      return `<a href="${escapeHtmlAttribute(token.href ?? '')}">${renderInlineTokens(token.tokens)}</a>`;
    case 'image': {
      const altText = token.text ? `[Изображение: ${token.text}]` : '[Изображение]';
      const urlText = token.href ? ` ${token.href}` : '';
      return renderInlineText(`${altText}${urlText}`);
    }
    case 'checkbox':
      return '';
    case 'html':
      return sanitizeInlineHtml(token.raw ?? token.text ?? '');
    default:
      if (Array.isArray(token.tokens)) {
        return renderInlineTokens(token.tokens);
      }

      return renderInlineText(token.text ?? token.raw ?? '');
  }
}

function renderPlainText(tokens) {
  return (tokens ?? []).map((token) => {
    if (!token || typeof token !== 'object') {
      return '';
    }

    switch (token.type) {
      case 'text':
      case 'escape':
      case 'codespan':
        return String(token.text ?? token.raw ?? '');
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        return renderPlainText(token.tokens);
      case 'br':
        return '\n';
      case 'image':
        return token.text ? `[${token.text}]` : '[image]';
      case 'checkbox':
        return '';
      default:
        if (Array.isArray(token.tokens)) {
          return renderPlainText(token.tokens);
        }

        return String(token.text ?? token.raw ?? '');
    }
  }).join('');
}

function renderTaskMarker(item) {
  if (!item?.task) {
    return '• ';
  }

  return item.checked ? '☑ ' : '☐ ';
}

function renderListItems(items, depth = 0, ordered = false, start = 1) {
  const rendered = [];

  for (const [index, item] of (items ?? []).entries()) {
    const marker = ordered ? `${start + index}. ` : renderTaskMarker(item);
    const childIndent = repeatString('  ', depth);
    const prefix = `${childIndent}${marker}`;
    const continuationIndent = `${childIndent}${repeatString(' ', marker.length)}`;
    const content = renderBlockTokens(item.tokens ?? [], depth + 1).join('\n');

    rendered.push(prefixMultiline(content.trim(), prefix, continuationIndent));
  }

  return rendered.join('\n');
}

function renderCodeBlock(language, code) {
  const escapedCode = escapeHtml(String(code ?? '').replace(/\n+$/g, ''));
  const cleanLanguage = String(language ?? '').trim().replace(/[^a-zA-Z0-9_+-]/g, '');

  if (!cleanLanguage) {
    return `<pre>${escapedCode}</pre>`;
  }

  return `<pre><code class="language-${escapeHtmlAttribute(cleanLanguage)}">${escapedCode}</code></pre>`;
}

function splitCodeBlock(language, code, maxLength = TELEGRAM_HTML_LIMIT) {
  const wrapperCost = language ? 96 : 24;
  const payloadLimit = Math.max(600, maxLength - wrapperCost);
  const chunks = [];
  let current = '';

  for (const line of String(code ?? '').split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;

    if (candidate.length <= payloadLimit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(renderCodeBlock(language, current));
      current = line;
      continue;
    }

    for (const part of splitLongString(line, payloadLimit)) {
      chunks.push(renderCodeBlock(language, part));
    }

    current = '';
  }

  if (current || chunks.length === 0) {
    chunks.push(renderCodeBlock(language, current));
  }

  return chunks;
}

function renderHtmlToken(token) {
  const raw = String(token?.raw ?? token?.text ?? '').trim();

  if (!raw) {
    return '';
  }

  return sanitizeInlineHtml(raw);
}

function renderBlockToken(token, depth = 0) {
  if (!token || typeof token !== 'object') {
    return [];
  }

  switch (token.type) {
    case 'space':
      return [];
    case 'heading':
      return [`<b>${renderInlineTokens(token.tokens)}</b>`];
    case 'paragraph':
    case 'text':
      return [renderInlineTokens(token.tokens ?? [{ type: 'text', text: token.text ?? token.raw ?? '' }])];
    case 'blockquote': {
      const content = renderBlockTokens(token.tokens ?? [], depth + 1).join('\n');
      return content ? [`<blockquote>${content}</blockquote>`] : [];
    }
    case 'list':
      return [renderListItems(token.items ?? [], depth, Boolean(token.ordered), Number(token.start ?? 1) || 1)];
    case 'code':
      return splitCodeBlock(token.lang, token.text, TELEGRAM_HTML_LIMIT);
    case 'hr':
      return ['──────────'];
    case 'checkbox':
      return [];
    case 'table': {
      const rows = [
        (token.header ?? []).map((cell) => renderPlainText(cell.tokens ?? [])),
        ...(token.rows ?? []).map((row) => row.map((cell) => renderPlainText(cell.tokens ?? []))),
      ];

      return [`<pre>${escapeHtml(renderTable(rows))}</pre>`];
    }
    case 'html':
      return [renderHtmlToken(token)];
    default:
      if (Array.isArray(token.tokens)) {
        return [renderInlineTokens(token.tokens)];
      }

      return [renderInlineText(token.text ?? token.raw ?? '')];
  }
}

function renderBlockTokens(tokens, depth = 0) {
  return (tokens ?? []).flatMap((token) => renderBlockToken(token, depth)).filter(Boolean);
}

function mergeChunks(chunks, maxLength = TELEGRAM_HTML_LIMIT) {
  const merged = [];
  let current = '';

  for (const chunk of chunks) {
    const candidate = current ? `${current}\n\n${chunk}` : chunk;

    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) {
      merged.push(current);
    }

    if (chunk.length <= maxLength) {
      current = chunk;
      continue;
    }

    const parts = splitLongString(chunk, maxLength);
    merged.push(...parts.slice(0, -1));
    current = parts.at(-1) ?? '';
  }

  if (current) {
    merged.push(current);
  }

  return merged;
}

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function renderTelegramHtmlChunks(text, maxChunkLength = TELEGRAM_HTML_LIMIT) {
  const source = String(text ?? '').trim();

  if (!source) {
    return [''];
  }

  const tokens = marked.lexer(preprocessMarkdown(source));
  const renderedBlocks = renderBlockTokens(tokens);

  if (renderedBlocks.length === 0) {
    return [escapeHtml(source)];
  }

  return mergeChunks(renderedBlocks, maxChunkLength);
}
