import type { WebSocket, WebSocketServer } from 'ws';

/**
 * Protocol-level ping/pong reaper. Application-level keepalives can't detect
 * half-open TCP connections (client vanished without a FIN), and traffic on
 * the wire is also what keeps nginx's proxy_read_timeout from severing the
 * upstream — so pings must arrive more often than that timeout.
 */

interface AliveSocket extends WebSocket {
  isAlive?: boolean;
}

/** Call on every new connection so the reaper sees it as alive. */
export function trackLiveness(ws: WebSocket): void {
  const socket = ws as AliveSocket;
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });
}

/** Every interval: reap sockets that missed the previous ping, ping the rest. */
export function startReaper(wss: WebSocketServer, intervalMs: number): () => void {
  const timer = setInterval(() => {
    for (const client of wss.clients) {
      const socket = client as AliveSocket;
      if (socket.isAlive === false) {
        socket.terminate(); // missed the last ping → dead or unreachable
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
