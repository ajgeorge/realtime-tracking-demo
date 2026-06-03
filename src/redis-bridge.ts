import Redis from 'ioredis';

export type MessageHandler = (channel: string, message: string) => void;

/**
 * Pub/sub wiring between this node and Redis. Two connections on purpose:
 * a Redis connection in subscriber mode can't issue regular commands, so
 * publishing (and presence SET/GET) needs its own connection.
 */
export class RedisBridge {
  private pub: Redis;
  private sub: Redis;
  private handlers: MessageHandler[] = [];

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.sub.on('message', (channel: string, message: string) => {
      for (const handler of this.handlers) handler(channel, message);
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.pub.publish(channel, message);
  }

  async subscribe(channel: string): Promise<void> {
    await this.sub.subscribe(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    await this.sub.unsubscribe(channel);
  }

  /** The non-subscriber connection, for regular commands (presence keys, scans). */
  get commands(): Redis {
    return this.pub;
  }

  async close(): Promise<void> {
    this.sub.disconnect();
    this.pub.disconnect();
  }
}
