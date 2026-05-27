import { parseClientMessage } from '../../src/protocol';

describe('protocol validation', () => {
  it('accepts a valid driver auth', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'auth', payload: { role: 'driver', driverId: 'd1' } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.type).toBe('auth');
  });

  it('accepts a watcher auth without driverId', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'auth', payload: { role: 'watcher' } }));
    expect(result.ok).toBe(true);
  });

  it('accepts a valid location update', () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: 'location',
        payload: { lat: 26.22, lng: 50.58, heading: 90, speed: 12.5 },
        seq: 1,
        ts: 1716200000000,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects invalid JSON', () => {
    const result = parseClientMessage('{nope');
    expect(result).toEqual({ ok: false, error: 'invalid JSON' });
  });

  it('rejects unknown message types', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'teleport', payload: {} }));
    expect(result.ok).toBe(false);
  });

  it('rejects out-of-range coordinates', () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: 'location',
        payload: { lat: 91, lng: 50.58, heading: 90, speed: 10 },
        seq: 1,
        ts: 1716200000000,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('payload.lat');
  });

  it('rejects a location without seq', () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: 'location',
        payload: { lat: 26.22, lng: 50.58, heading: 90, speed: 10 },
        ts: 1716200000000,
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects negative or fractional seq', () => {
    for (const seq of [-1, 1.5]) {
      const result = parseClientMessage(
        JSON.stringify({
          type: 'location',
          payload: { lat: 0, lng: 0, heading: 0, speed: 0 },
          seq,
          ts: 1716200000000,
        }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it('rejects driverIds with unsafe characters (they become Redis channel names)', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'watch', payload: { driverId: 'd1 OR *' } }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects heading of exactly 360 (use 0)', () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: 'location',
        payload: { lat: 0, lng: 0, heading: 360, speed: 0 },
        seq: 1,
        ts: 1716200000000,
      }),
    );
    expect(result.ok).toBe(false);
  });
});
