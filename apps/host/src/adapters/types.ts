import type { WriteStream } from '@airloom/channel';

export interface AIAdapter {
  streamResponse(
    messages: Array<{ role: string; content: string }>,
    stream: WriteStream,
  ): Promise<void>;

  readonly name: string;
  readonly model: string;
}
