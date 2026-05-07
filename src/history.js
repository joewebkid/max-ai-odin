export class ConversationStore {
  constructor(limit = 12) {
    this.limit = limit;
    this.store = new Map();
  }

  get(key) {
    return this.store.get(key) ?? [];
  }

  reset(key) {
    this.store.delete(key);
  }

  append(key, role, content) {
    const current = this.get(key);
    const next = [...current, { role, content: content.trim() }]
      .filter((message) => message.content.length > 0)
      .slice(-this.limit);

    this.store.set(key, next);
  }

  buildMessages(key, systemPrompt, userText) {
    const messages = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push(...this.get(key));
    messages.push({ role: 'user', content: userText.trim() });

    return messages;
  }
}
