/**
 * Runs against the docker-compose stack: `docker compose up -d --build --wait`
 * then `npm run test:integration`. Connects straight to each API container's
 * published port — bypassing nginx on purpose, so each end of the conversation
 * is pinned to a known node.
 */
import WebSocket, { ClientOptions } from 'ws';
import Redis from 'ioredis';
import {
  API_1,
  API_2,
  REDIS_URL,
  auth,
  closed,
  eventually,
  nextMessage,
  send,
  wsConnect,
} from './helpers';

jest.setTimeout(60_000);

const LOC = { lat: 26.2235, lng: 50.5876, heading: 90, speed: 12.5 };

const sockets: WebSocket[] = [];
async function connect(url: string, options?: ClientOptions) {
  const ws = await wsConnect(url, options);
  sockets.push(ws);
  return ws;
}

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('cross-server delivery', () => {
  it('update from driver on node A reaches watcher on node B', async () => {
    const driver = await connect(API_1);
    const watcher = await connect(API_2);

    const driverAuth = await auth(driver, { role: 'driver', driverId: 't-cross' });
    expect(driverAuth.payload.nodeId).toBe('api-1');
    const watcherAuth = await auth(watcher, { role: 'watcher' });
    expect(watcherAuth.payload.nodeId).toBe('api-2');

    send(watcher, { type: 'watch', payload: { driverId: 't-cross' } });
    await settle(500); // let api-2's SUBSCRIBE land before the driver publishes

    const incoming = nextMessage<{ driverId: string; via: string; seq: number }>(
      watcher,
      'location',
    );
    send(driver, { type: 'location', payload: LOC, seq: 1, ts: Date.now() });

    const msg = await incoming;
    expect(msg.driverId).toBe('t-cross');
    expect(msg.seq).toBe(1);
    expect(msg.via).toBe('api-1'); // handled by the OTHER node → cross-server proven
  });

  it('unsubscribes from the Redis channel when the last watcher leaves', async () => {
    const redis = new Redis(REDIS_URL);
    try {
      const channel = 'driver:t-interest';
      const watcher = await connect(API_1);
      await auth(watcher, { role: 'watcher' });

      send(watcher, { type: 'watch', payload: { driverId: 't-interest' } });
      await eventually(async () => {
        const channels = (await redis.pubsub('CHANNELS', 'driver:*')) as string[];
        return channels.includes(channel);
      });

      send(watcher, { type: 'unwatch', payload: { driverId: 't-interest' } });
      await eventually(async () => {
        const channels = (await redis.pubsub('CHANNELS', 'driver:*')) as string[];
        return !channels.includes(channel);
      });
    } finally {
      redis.disconnect();
    }
  });

  it('rejects a location update from a socket not authed as driver', async () => {
    const ws = await connect(API_1);
    await auth(ws, { role: 'watcher' });
    const error = nextMessage<{ payload: { code: string } }>(ws, 'error');
    send(ws, { type: 'location', payload: LOC, seq: 1, ts: Date.now() });
    expect((await error).payload.code).toBe('not_a_driver');
  });

  it('reaper terminates a client that stops answering pings', async () => {
    // autoPong: false simulates a wedged client: TCP is up, but the WS stack
    // is unresponsive. The server must notice within ~2 heartbeat intervals.
    const ws = await connect(API_1, { autoPong: false });
    await auth(ws, { role: 'watcher' });
    await closed(ws, 35_000); // 15s interval → dead by ~30s
  }, 45_000);
});
