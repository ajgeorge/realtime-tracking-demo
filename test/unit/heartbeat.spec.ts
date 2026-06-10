import type { WebSocket, WebSocketServer } from 'ws';
import { startReaper, trackLiveness } from '../../src/heartbeat';

interface FakeSocket {
  isAlive?: boolean;
  listeners: Map<string, () => void>;
  ping: jest.Mock;
  terminate: jest.Mock;
  on: (event: string, handler: () => void) => void;
  emitPong: () => void;
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    listeners: new Map(),
    ping: jest.fn(),
    terminate: jest.fn(),
    on(event, handler) {
      socket.listeners.set(event, handler);
    },
    emitPong() {
      socket.listeners.get('pong')?.();
    },
  };
  return socket;
}

const INTERVAL = 15_000;

describe('heartbeat reaper', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup() {
    const socket = fakeSocket();
    const wss = { clients: new Set([socket]) } as unknown as WebSocketServer;
    trackLiveness(socket as unknown as WebSocket);
    const stop = startReaper(wss, INTERVAL);
    return { socket, stop };
  }

  it('pings live sockets each interval', () => {
    const { socket, stop } = setup();
    jest.advanceTimersByTime(INTERVAL);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.terminate).not.toHaveBeenCalled();
    stop();
  });

  it('keeps a ponging socket alive across many intervals', () => {
    const { socket, stop } = setup();
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(INTERVAL);
      socket.emitPong();
    }
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.ping).toHaveBeenCalledTimes(5);
    stop();
  });

  it('terminates a socket that misses one ping', () => {
    const { socket, stop } = setup();
    jest.advanceTimersByTime(INTERVAL); // ping sent, no pong comes back
    jest.advanceTimersByTime(INTERVAL); // still marked dead → reaped
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops pinging after stop() is called', () => {
    const { socket, stop } = setup();
    stop();
    jest.advanceTimersByTime(INTERVAL * 3);
    expect(socket.ping).not.toHaveBeenCalled();
  });
});
