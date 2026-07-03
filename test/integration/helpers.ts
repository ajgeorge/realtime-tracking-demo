import WebSocket, { ClientOptions } from 'ws';

// 127.0.0.1, not 'localhost': some Docker Desktop networking configurations
// resolve 'localhost' to ::1 first and don't forward IPv6 loopback, which
// hangs/resets these connections even though IPv4 works fine.
export const API_1 = 'ws://127.0.0.1:3001/ws';
export const API_2 = 'ws://127.0.0.1:3002/ws';
export const REDIS_URL = 'redis://127.0.0.1:6379';

export function wsConnect(url: string, options?: ClientOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

export function send(ws: WebSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}

/** Resolve with the next message of the given type, ignoring others. */
export function nextMessage<T = Record<string, unknown>>(
  ws: WebSocket,
  type: string,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for '${type}' message`));
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        cleanup();
        resolve(msg as T);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };

    ws.on('message', onMessage);
  });
}

export async function auth(
  ws: WebSocket,
  payload: { role: 'driver' | 'watcher'; driverId?: string },
): Promise<{ payload: { nodeId: string } }> {
  const reply = nextMessage<{ payload: { nodeId: string } }>(ws, 'auth_ok');
  send(ws, { type: 'auth', payload });
  return reply;
}

export function closed(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('socket was not closed within the timeout')),
      timeoutMs,
    );
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Poll until the predicate passes or the timeout elapses. */
export async function eventually(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
  stepMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('condition not met within timeout');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
