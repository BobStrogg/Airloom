import type { AIAdapter } from './types.js';
import type { WriteStream } from '@airloom/channel';

export class OpenAIAdapter implements AIAdapter {
  readonly name = 'openai';
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string }) {
    if (!config.apiKey) throw new Error('API key is required for OpenAI adapter');
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-4o';
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  }

  async streamResponse(
    messages: Array<{ role: string; content: string }>,
    stream: WriteStream,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, stream: true, messages }),
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
            const content = event.choices?.[0]?.delta?.content;
            if (content) stream.write(content);
          } catch { /* skip */ }
        }
      }
    } finally {
      stream.end();
    }
  }
}
