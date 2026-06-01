import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { Hub } from './hub';
import { parseClientMessage, LocationBroadcast, ServerMessage } from './protocol';

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
  // Single-node for now: location updates fan out to local watchers directly.
  // The Redis bridge hooks into these callbacks next.
  const hub = new Hub(
    {
      onFirstWatcher: () => {},
      onLastWatcher: () => {},
    },
    config.maxBufferedBytes,
  );

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

  wss.on('connection', (ws) => {
    const state: ConnectionState = { watched: new Set() };

    ws.on('message', (data) => {
      handleMessage(ws, state, data.toString());
    });

    ws.on('close', () => {
      hub.removeSocket(ws);
    });
  });

  function handleMessage(ws: WebSocket, state: ConnectionState, raw: string): void {
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
        hub.deliverLocal(state.driverId, JSON.stringify(broadcast));
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

  return { server, wss, hub };
}

if (require.main === module) {
  const app = createApp();
  app.server.listen(config.port, () => {
    console.log(`[${config.nodeId}] listening on :${config.port}`);
  });
}
