/**
 * Per-node subscription registry. Each API node only knows about watchers
 * connected to *itself*; Redis pub/sub stitches the nodes together.
 */

const OPEN = 1; // WebSocket.OPEN

/** The minimal socket surface the hub needs — real `ws` sockets satisfy it. */
export interface WatcherSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
}

export interface HubEvents {
  /** First local watcher for a driver — time to subscribe to its channel. */
  onFirstWatcher(driverId: string): void;
  /** Last local watcher left — unsubscribe so Redis fan-out tracks interest, not fleet size. */
  onLastWatcher(driverId: string): void;
}

export class Hub {
  private watchers = new Map<string, Set<WatcherSocket>>();

  constructor(
    private events: HubEvents,
    private maxBufferedBytes: number,
  ) {}

  watch(driverId: string, ws: WatcherSocket): void {
    let set = this.watchers.get(driverId);
    if (!set) {
      set = new Set();
      this.watchers.set(driverId, set);
      this.events.onFirstWatcher(driverId);
    }
    set.add(ws);
  }

  unwatch(driverId: string, ws: WatcherSocket): void {
    const set = this.watchers.get(driverId);
    if (!set || !set.delete(ws)) return;
    if (set.size === 0) {
      this.watchers.delete(driverId);
      this.events.onLastWatcher(driverId);
    }
  }

  /** Socket closed — drop it from every driver it was watching. */
  removeSocket(ws: WatcherSocket): void {
    for (const driverId of [...this.watchers.keys()]) {
      this.unwatch(driverId, ws);
    }
  }

  /**
   * Fan a message out to this node's watchers of a driver.
   *
   * The bufferedAmount check is deliberate backpressure: a slow consumer gets
   * dropped frames rather than ballooning server memory. Location data is
   * last-write-wins, so skipping intermediate points is correct behaviour.
   * See docs/decisions/0004-backpressure-drop-frames.md.
   */
  deliverLocal(driverId: string, message: string): number {
    let delivered = 0;
    for (const ws of this.watchers.get(driverId) ?? []) {
      if (ws.readyState === OPEN && ws.bufferedAmount < this.maxBufferedBytes) {
        ws.send(message);
        delivered++;
      }
    }
    return delivered;
  }

  watchedDrivers(): string[] {
    return [...this.watchers.keys()];
  }

  watcherCount(driverId: string): number {
    return this.watchers.get(driverId)?.size ?? 0;
  }
}
