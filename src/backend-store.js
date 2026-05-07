const SUPPORTED_BACKENDS = new Set(['g4f', 'codex']);

export class BackendStore {
  constructor(defaultBackend = 'g4f') {
    this.defaultBackend = defaultBackend;
    this.store = new Map();
  }

  get(key) {
    return this.store.get(key) ?? this.defaultBackend;
  }

  set(key, backend) {
    if (!SUPPORTED_BACKENDS.has(backend)) {
      throw new Error(`Unsupported backend "${backend}"`);
    }

    this.store.set(key, backend);
  }
}
