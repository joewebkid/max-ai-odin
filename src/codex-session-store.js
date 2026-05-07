import fs from 'node:fs/promises';
import path from 'node:path';

function normalizeState(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }

  const result = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (
      value &&
      typeof value === 'object' &&
      typeof value.responseId === 'string' &&
      value.responseId.trim()
    ) {
      result[key] = {
        responseId: value.responseId.trim(),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
      };
    }
  }

  return result;
}

export class CodexSessionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {};
    this.initialized = false;
    this.queue = Promise.resolve();
  }

  async init() {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      this.state = {};
    }

    this.initialized = true;
  }

  get(key) {
    return this.state[key]?.responseId ?? null;
  }

  async set(key, responseId) {
    const normalizedKey = String(key || '').trim();
    const normalizedResponseId = String(responseId || '').trim();

    if (!normalizedKey || !normalizedResponseId) {
      return;
    }

    this.state[normalizedKey] = {
      responseId: normalizedResponseId,
      updatedAt: new Date().toISOString(),
    };

    await this.persist();
  }

  async reset(key) {
    const normalizedKey = String(key || '').trim();

    if (!normalizedKey || !this.state[normalizedKey]) {
      return;
    }

    delete this.state[normalizedKey];
    await this.persist();
  }

  async persist() {
    const write = this.queue.then(async () => {
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(this.state, null, 2), 'utf8');
      await fs.rename(tempPath, this.filePath);
    });

    this.queue = write.catch(() => {});
    return write;
  }
}
