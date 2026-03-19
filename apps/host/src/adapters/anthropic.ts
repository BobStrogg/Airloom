import type { AIAdapter } from './types.js';
import type { WriteStream } from '@airloom/channel';

export class AnthropicAdapter implements AIAdapter {
  readonly name = 'anthropic';
  readonly model: string;
  private apiKey: string;

  constructor(config: { apiKey: string; model?: string }) {
    if (!config.apiKey) throw new Error('API key is required for Anthropic adapter');
    this.apiKey = config.apiKey;
    this.model = config.model || 'claude-sonnet-4-20250514';
  }

  async streamResponse(
    messages: Array<{ role: string; content: string }>,
    stream: WriteStream,
  ): Promise<void> {
    const systemMsg = messages.find((m) => m.role === 'system')?.content;
    const chatMsgs = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      stream: true,
      messages: chatMsgs,
    };
    if (systemMsg) body.system = systemMsg;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      stream.write(`[Error: ${response.status} ${error}]`);
      stream.end();
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      stream.write('[Error: No response body]');
      stream.end();
      return;
    }
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_delta' && event.delta?.text) {
              stream.write(event.delta.text);
            }
          } catch { /* skip malformed events */ }
        }
      }
    } finally {
      stream.end();
    }
  }
}
