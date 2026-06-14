import type Redis from 'ioredis';
import { Presence, PRESENCE_CHANNEL } from '../../src/presence';

function makePresence() {
  const store = new Map<string, string>();
  const redis = {
    set: jest.fn(async (key: string, value: string) => {
      const previous = store.get(key) ?? null;
      store.set(key, value);
      return previous;
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
  };
  const publisher = { publish: jest.fn(async () => {}) };
  const presence = new Presence(redis as unknown as Redis, publisher, 'api-1', 45);
  return { presence, publisher, store };
}

const expectPublished = (
  publisher: { publish: jest.Mock },
  driverId: string,
  status: string,
  times: number,
) => {
  const matching = publisher.publish.mock.calls.filter(
    ([channel, message]: [string, string]) =>
      channel === PRESENCE_CHANNEL && JSON.parse(message).payload.driverId === driverId &&
      JSON.parse(message).payload.status === status,
  );
  expect(matching).toHaveLength(times);
};

describe('presence', () => {
  it('publishes online only on the offline→online flip, not every refresh', async () => {
    const { presence, publisher } = makePresence();
    await presence.touch('d1');
    await presence.touch('d1');
    await presence.touch('d1');
    expectPublished(publisher, 'd1', 'online', 1);
  });

  it('reports online while the key exists', async () => {
    const { presence } = makePresence();
    expect(await presence.isOnline('d1')).toBe(false);
    await presence.touch('d1');
    expect(await presence.isOnline('d1')).toBe(true);
  });

  it('sweep publishes offline when a tracked key expired', async () => {
    const { presence, publisher, store } = makePresence();
    await presence.touch('d1');
    store.delete('presence:driver:d1'); // simulate TTL expiry
    await presence.sweep();
    expectPublished(publisher, 'd1', 'offline', 1);
  });

  it('sweep publishes offline only once per expiry', async () => {
    const { presence, publisher, store } = makePresence();
    await presence.touch('d1');
    store.delete('presence:driver:d1');
    await presence.sweep();
    await presence.sweep();
    expectPublished(publisher, 'd1', 'offline', 1);
  });

  it('sweep hands over silently when another node owns the key', async () => {
    const { presence, publisher, store } = makePresence();
    await presence.touch('d1');
    store.set('presence:driver:d1', 'api-2'); // driver reconnected elsewhere
    await presence.sweep();
    expectPublished(publisher, 'd1', 'offline', 0);
    // ...and this node no longer tracks it: even if the key now expires,
    // it's api-2's sweeper that must announce it.
    store.delete('presence:driver:d1');
    await presence.sweep();
    expectPublished(publisher, 'd1', 'offline', 0);
  });
});
