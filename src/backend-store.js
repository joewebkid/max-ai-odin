const BACKEND_ALIASES = new Map([
  ['g4f', 'free'],
  ['codex', 'chatgpt'],
]);
const SUPPORTED_BACKENDS = new Set(['free', 'chatgpt', 'claude', 'gemini']);

function normalizeBackend(backend) {
  const normalized = String(backend ?? '').trim().toLowerCase();
  return BACKEND_ALIASES.get(normalized) ?? normalized;
}

export class BackendStore {
  constructor(defaultBackend = 'free') {
    this.defaultBackend = normalizeBackend(defaultBackend);
    this.store = new Map();
  }

  get(key) {
    return normalizeBackend(this.store.get(key) ?? this.defaultBackend);
  }

  set(key, backend) {
    const normalizedBackend = normalizeBackend(backend);

    if (!SUPPORTED_BACKENDS.has(normalizedBackend)) {
      throw new Error(`Unsupported backend "${backend}"`);
    }

    this.store.set(key, normalizedBackend);
  }
}
