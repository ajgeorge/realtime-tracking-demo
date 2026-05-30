import { Hub, WatcherSocket } from '../../src/hub';

const OPEN = 1;
const CLOSED = 3;
const MAX_BUFFER = 1024;

interface FakeSocket extends WatcherSocket {
  sent: string[];
}

function fakeSocket(overrides: Partial<WatcherSocket> = {}): FakeSocket {
  const socket: FakeSocket = {
    readyState: OPEN,
    bufferedAmount: 0,
    sent: [],
    send(data: string) {
      socket.sent.push(data);
    },
    ...overrides,
  };
  return socket;
}

function makeHub() {
  const onFirstWatcher = jest.fn();
  const onLastWatcher = jest.fn();
  const hub = new Hub({ onFirstWatcher, onLastWatcher }, MAX_BUFFER);
  return { hub, onFirstWatcher, onLastWatcher };
}

describe('hub', () => {
  it('fires onFirstWatcher only for the first local watcher of a driver', () => {
    const { hub, onFirstWatcher } = makeHub();
    hub.watch('d1', fakeSocket());
    hub.watch('d1', fakeSocket());
    expect(onFirstWatcher).toHaveBeenCalledTimes(1);
    expect(onFirstWatcher).toHaveBeenCalledWith('d1');
  });

  it('fires onLastWatcher only when the last watcher leaves', () => {
    const { hub, onLastWatcher } = makeHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.watch('d1', a);
    hub.watch('d1', b);
    hub.unwatch('d1', a);
    expect(onLastWatcher).not.toHaveBeenCalled();
    hub.unwatch('d1', b);
    expect(onLastWatcher).toHaveBeenCalledTimes(1);
    expect(onLastWatcher).toHaveBeenCalledWith('d1');
  });

  it('ignores unwatch from a socket that never watched', () => {
    const { hub, onLastWatcher } = makeHub();
    hub.watch('d1', fakeSocket());
    hub.unwatch('d1', fakeSocket());
    expect(onLastWatcher).not.toHaveBeenCalled();
    expect(hub.watcherCount('d1')).toBe(1);
  });

  it('delivers only to watchers of that driver', () => {
    const { hub } = makeHub();
    const watching = fakeSocket();
    const other = fakeSocket();
    hub.watch('d1', watching);
    hub.watch('d2', other);
    const delivered = hub.deliverLocal('d1', 'msg');
    expect(delivered).toBe(1);
    expect(watching.sent).toEqual(['msg']);
    expect(other.sent).toEqual([]);
  });

  it('skips closed sockets', () => {
    const { hub } = makeHub();
    const closed = fakeSocket({ readyState: CLOSED });
    hub.watch('d1', closed);
    expect(hub.deliverLocal('d1', 'msg')).toBe(0);
    expect(closed.sent).toEqual([]);
  });

  it('drops frames for backpressured sockets instead of buffering', () => {
    const { hub } = makeHub();
    const slow = fakeSocket({ bufferedAmount: MAX_BUFFER });
    const fast = fakeSocket();
    hub.watch('d1', slow);
    hub.watch('d1', fast);
    expect(hub.deliverLocal('d1', 'msg')).toBe(1);
    expect(slow.sent).toEqual([]);
    expect(fast.sent).toEqual(['msg']);
  });

  it('removeSocket unwatches everywhere and fires onLastWatcher per emptied driver', () => {
    const { hub, onLastWatcher } = makeHub();
    const ws = fakeSocket();
    const stayer = fakeSocket();
    hub.watch('d1', ws);
    hub.watch('d2', ws);
    hub.watch('d2', stayer);
    hub.removeSocket(ws);
    expect(onLastWatcher).toHaveBeenCalledTimes(1);
    expect(onLastWatcher).toHaveBeenCalledWith('d1');
    expect(hub.watchedDrivers()).toEqual(['d2']);
  });
});
