# Architecture

## The claim

A driver connected to server A streams live location to watchers connected to
server B. Two API instances behind a proxy, Redis pub/sub in between, dead
connections reaped by heartbeats. No sticky sessions, no shared in-process
state, no node knows where anyone else is connected.

```
                    ┌─────────┐
  drivers ───ws───► │  nginx   │ ◄───ws─── watchers (browser)
  (simulator)       │ :8080    │
                    └────┬─────┘
               least_conn│
              ┌──────────┴──────────┐
              ▼                     ▼
         ┌─────────┐          ┌─────────┐
         │  api-1  │          │  api-2  │
         └────┬────┘          └────┬────┘
              │   publish/subscribe │
              └───────┬─────────────┘
                      ▼
                 ┌─────────┐
                 │  Redis  │   channels: driver:{id}
                 └─────────┘   presence: presence:driver:{id} (TTL keys)
```

## The path of one location update

1. A driver's socket (on whichever node nginx picked) sends a `location` frame.
2. The node validates it (zod, at the boundary), stamps `driverId` and
   `via: <its own node id>`, and `PUBLISH`es to `driver:{id}` — even if the
   only watchers are local (see [ADR 0002](decisions/0002-publish-through-redis-always.md)).
3. It also refreshes `presence:driver:{id}` with a 45s TTL
   ([ADR 0005](decisions/0005-ttl-presence.md)).
4. Every node whose local registry has at least one watcher for that driver is
   subscribed to the channel ([ADR 0003](decisions/0003-subscribe-on-interest.md))
   and fans the frame out to those sockets — skipping any that are backpressured
   ([ADR 0004](decisions/0004-backpressure-drop-frames.md)).
5. Watchers drop frames with a stale `seq`; Redis pub/sub guarantees no
   ordering across reconnects, so ordering is enforced at the edge.

## Per-node state

Each API node holds exactly one map: `driverId → Set<WebSocket>` of *its own*
watchers. That's the entire registry. Losing a node loses nothing durable —
clients reconnect through nginx, land wherever `least_conn` sends them,
re-auth and re-watch, and the new node subscribes to whatever channels its new
watchers need.

## Failure handling

- **Dead/half-open connections** — protocol-level ping every 15s; a socket
  that misses one full interval is terminated ([src/heartbeat.ts](../src/heartbeat.ts)).
  nginx's `proxy_read_timeout` is set to 60s, above the ping cadence, so the
  proxy never severs a healthy-but-quiet socket.
- **Node death** — clients reconnect with exponential backoff + jitter
  (1s → 30s cap), re-auth, re-watch. Try it: `./scripts/kill-node.sh api-1`.
- **Driver vanishes** — its presence key stops being refreshed and expires;
  the sweeper on the node that last saw it broadcasts `offline`.
- **Redis down** — the demo degrades: updates stop flowing until Redis
  returns (ioredis reconnects automatically). Making the system survive a
  Redis outage (local echo + replay) is out of scope and discussed in the
  README's scaling section.
