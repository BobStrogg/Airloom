export interface RateLimitConfig {
  maxMessagesPerSecond: number;
  maxMessageSize: number;
  maxSessionsTotal: number;
}

export const DEFAULT_LIMITS: RateLimitConfig = {
  maxMessagesPerSecond: 20,
  maxMessageSize: 65536,
  maxSessionsTotal: 100,
};

export class RateLimiter {
  private windowStart = 0;
  private windowCount = 0;
  private maxPerSecond: number;
  private maxSize: number;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.maxPerSecond = config.maxMessagesPerSecond ?? DEFAULT_LIMITS.maxMessagesPerSecond;
    this.maxSize = config.maxMessageSize ?? DEFAULT_LIMITS.maxMessageSize;
  }

  checkMessage(sizeBytes: number): boolean {
    if (sizeBytes > this.maxSize) return false;
    const now = Date.now();
    if (now - this.windowStart > 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    return ++this.windowCount <= this.maxPerSecond;
  }

  reset(): void {
    this.windowStart = 0;
    this.windowCount = 0;
  }
}
