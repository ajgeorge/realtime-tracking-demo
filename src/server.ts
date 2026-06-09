import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { Hub } from './hub';
import { RedisBridge } from './redis-bridge';
import { startReaper, trackLiveness } from './heartbeat';
import { parseClientMessage, LocationBroadcast, ServerMessage } from './protocol';

const DRIVER_CHANNEL_PREFIX = 'driver:';

interface ConnectionState {
  role?: 'driver' | 'watcher';
  driverId?: string;
  watched: Set<string>;
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, { type: 'error', payload: { code, message } });
}

export function createApp() {
  const bridge = new RedisBridge(config.redisUrl);
  const hub = new Hub(
    {
      // Subscribe on first local watcher, unsubscribe on last: Redis fan-out
      // stays proportional to interest, not fleet size.
      onFirstWatcher: (driverId) =>
        void bridge.subscribe(`${DRIVER_CHANNEL_PREFIX}${driverId}`).catch(logRedisError),
      onLastWatcher: (driverId) =>
        void bridge.unsubscribe(`${DRIVER_CHANNEL_PREFIX}${driverId}`).catch(logRedisError),
    },
    config.maxBufferedBytes,
  );

  bridge.onMessage((channel, message) => {
    if (channel.startsWith(DRIVER_CHANNEL_PREFIX)) {
      hub.deliverLocal(channel.slice(DRIVER_CHANNEL_PREFIX.length), message);
    }
  });

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          nodeId: config.nodeId,
          uptimeSec: Math.round(process.uptime()),
          rssBytes: process.memoryUsage().rss,
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  const stopReaper = startReaper(wss, config.heartbeatIntervalMs);

  wss.on('connection', (ws) => {
    trackLiveness(ws);
    const state: ConnectionState = { watched: new Set() };

    ws.on('message', (data) => {
      void handleMessage(ws, state, data.toString()).catch(() => {
        sendError(ws, 'internal', 'failed to process message');
      });
    });

    ws.on('close', () => {
      hub.removeSocket(ws);
    });
  });

  async function handleMessage(ws: WebSocket, state: ConnectionState, raw: string): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      sendError(ws, 'bad_message', parsed.error);
      return;
    }

    const msg = parsed.message;
    switch (msg.type) {
      case 'auth': {
        if (msg.payload.role === 'driver' && !msg.payload.driverId) {
          sendError(ws, 'bad_auth', 'drivers must provide a driverId');
          return;
        }
        state.role = msg.payload.role;
        state.driverId = msg.payload.driverId;
        send(ws, { type: 'auth_ok', payload: { nodeId: config.nodeId } });
        return;
      }

      case 'location': {
        if (state.role !== 'driver' || !state.driverId) {
          sendError(ws, 'not_a_driver', 'authenticate as a driver before sending locations');
          return;
        }
        const broadcast: LocationBroadcast = {
          type: 'location',
          payload: msg.payload,
          seq: msg.seq,
          ts: msg.ts,
          driverId: state.driverId,
          via: config.nodeId,
        };
        // Always publish through Redis — even for watchers on this node —
        // so there is exactly one delivery path.
        await bridge.publish(`${DRIVER_CHANNEL_PREFIX}${state.driverId}`, JSON.stringify(broadcast));
        return;
      }

      case 'watch': {
        if (state.role !== 'watcher') {
          sendError(ws, 'not_a_watcher', 'authenticate as a watcher before watching');
          return;
        }
        state.watched.add(msg.payload.driverId);
        hub.watch(msg.payload.driverId, ws);
        return;
      }

      case 'unwatch': {
        state.watched.delete(msg.payload.driverId);
        hub.unwatch(msg.payload.driverId, ws);
        return;
      }
    }
  }

  function logRedisError(err: unknown): void {
    console.error(`[${config.nodeId}] redis error:`, err);
  }

  async function stop(): Promise<void> {
    stopReaper();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await bridge.close();
  }

  return { server, wss, hub, bridge, stop };
}

if (require.main === module) {
  const app = createApp();
  app.server.listen(config.port, () => {
    console.log(`[${config.nodeId}] listening on :${config.port}`);
  });
  const shutdown = () => {
    void app.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
