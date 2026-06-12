import type Redis from 'ioredis';

/**
 * Driver online/offline without any node owning global state: every location
 * update refreshes a TTL key (`SET presence:driver:{id} {nodeId} EX ttl`).
 * A driver is online iff the key exists. No cleanup handshake is needed —
 * a crashed driver, node, or network path all converge to "key expires".
 * See docs/decisions/0005-ttl-presence.md.
 */

export const PRESENCE_CHANNEL = 'presence';
const KEY_PREFIX = 'presence:driver:';

const keyFor = (driverId: string) => `${KEY_PREFIX}${driverId}`;

export interface PresencePublisher {
  publish(channel: string, message: string): Promise<void>;
}

function presenceMessage(driverId: string, status: 'online' | 'offline'): string {
  return JSON.stringify({ type: 'presence', payload: { driverId, status } });
}

export class Presence {
  /** Drivers whose updates most recently flowed through this node. */
  private tracked = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private redis: Redis,
    private publisher: PresencePublisher,
    private nodeId: string,
    private ttlSec: number,
  ) {}

  /**
   * Refresh the driver's TTL key. `SET ... GET` is atomic — the old value
   * tells us whether this was an offline→online flip worth broadcasting.
   */
  async touch(driverId: string): Promise<void> {
    const previous = await this.redis.set(keyFor(driverId), this.nodeId, 'EX', this.ttlSec, 'GET');
    this.tracked.add(driverId);
    if (previous === null) {
      await this.publisher.publish(PRESENCE_CHANNEL, presenceMessage(driverId, 'online'));
    }
  }

  async isOnline(driverId: string): Promise<boolean> {
    return (await this.redis.exists(keyFor(driverId))) === 1;
  }

  /** Online driver ids, via SCAN (never KEYS — it blocks Redis). */
  async listOnline(): Promise<string[]> {
    const ids: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100);
      cursor = next;
      for (const key of keys) ids.push(key.slice(KEY_PREFIX.length));
    } while (cursor !== '0');
    return ids.sort();
  }

  /**
   * Sweep drivers this node last saw. Key gone → the TTL lapsed, broadcast
   * offline. Key owned by another node → the driver reconnected elsewhere,
   * quietly hand over. (Keyspace notifications could replace the sweep; the
   * trade-off is discussed in the ADR.)
   */
  async sweep(): Promise<void> {
    for (const driverId of [...this.tracked]) {
      const owner = await this.redis.get(keyFor(driverId));
      if (owner === null) {
        this.tracked.delete(driverId);
        await this.publisher.publish(PRESENCE_CHANNEL, presenceMessage(driverId, 'offline'));
      } else if (owner !== this.nodeId) {
        this.tracked.delete(driverId);
      }
    }
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {
        /* Redis hiccup — next sweep retries */
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
