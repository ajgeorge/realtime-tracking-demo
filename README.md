# realtime-tracking-demo

[![ci](https://github.com/ajgeorge/realtime-tracking-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/ajgeorge/realtime-tracking-demo/actions/workflows/ci.yml)

**A driver connected to server A streams live location to watchers connected to
server B.** Two API instances behind nginx, Redis pub/sub in between, dead
connections reaped by heartbeats. One command to run, one page to watch it
happen.

> 🎬 *Chaos demo GIF coming here: `./scripts/kill-node.sh api-1` — watchers
> visibly reconnect with backoff, land on api-2, and updates resume.*

A single-server WebSocket demo is a tutorial. A multi-instance one is an
architecture: no sticky sessions, no node knows where anyone else is
connected, and killing either API node mid-stream is a non-event.

Hosted: backend on Railway (nginx + 2 API nodes + Redis, over Railway's
private network), map on Cloudflare Pages — see
[docs/deploy.md](docs/deploy.md) for the exact setup.

## Quick start

```sh
docker compose up -d --build --wait
```

Open <http://localhost:8080>. Five simulated drivers are moving around Manama;
click one to watch. The badge next to each watched driver shows **which API
node handled its latest update** — when it says `via api-1` and your socket is
on api-2, you're watching cross-server delivery live.

Then kill a node:

```sh
./scripts/kill-node.sh api-1
```

The status pill flips to *reconnecting*, backoff kicks in, the client lands on
api-2, re-watches, and updates resume.

## Architecture

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

Each node keeps one piece of state: `Map<driverId, Set<WebSocket>>` of watchers
connected to *itself*. Location updates are validated (zod), stamped with the
handling node's id, and published to `driver:{id}`; every interested node's
subscriber fans them out locally. Full walkthrough in
[docs/architecture.md](docs/architecture.md).

## Message protocol

```ts
// client → server
{ type: 'auth',     payload: { role: 'driver' | 'watcher', driverId?: string } }
{ type: 'location', payload: { lat, lng, heading, speed }, seq: number, ts: number }
{ type: 'watch',    payload: { driverId: string } }
{ type: 'unwatch',  payload: { driverId: string } }

// server → client
{ type: 'auth_ok',  payload: { nodeId } }
{ type: 'location', payload: {...}, seq, ts, driverId, via: 'api-1' }
{ type: 'presence', payload: { driverId, status: 'online' | 'offline' } }
{ type: 'error',    payload: { code, message } }
```

Two fields carry the design: **`seq`** lets watchers drop stale frames (Redis
pub/sub guarantees no ordering across reconnects, so ordering is enforced at
the edge), and **`via`** makes cross-server routing visible in the UI.

## Design decisions

Each of these is a deliberate choice with an ADR explaining the trade-off:

| Decision | ADR |
|---|---|
| Raw `ws`, not socket.io — build what it abstracts | [0001](docs/decisions/0001-raw-websockets-over-socketio.md) |
| Publish through Redis even for local watchers | [0002](docs/decisions/0002-publish-through-redis-always.md) |
| Subscribe on first watcher, unsubscribe on last | [0003](docs/decisions/0003-subscribe-on-interest.md) |
| Backpressure: drop frames to slow consumers | [0004](docs/decisions/0004-backpressure-drop-frames.md) |
| Presence via Redis TTL keys, no owned state | [0005](docs/decisions/0005-ttl-presence.md) |
| `least_conn`, not sticky sessions | [0006](docs/decisions/0006-least-conn-over-sticky.md) |

## Failure handling

- **Half-open connections**: protocol-level ping every 15s; miss one interval
  and the socket is terminated. Protocol pings (not app-level keepalives)
  because they also reset nginx's `proxy_read_timeout` — which is set to 60s,
  above the ping cadence, and commented in [nginx.conf](nginx.conf).
- **Node death**: reconnect with exponential backoff + jitter (1s → 30s),
  re-auth, re-watch. The new node may be a different node — that's the point.
- **Driver gone silent**: its presence TTL key expires; a sweeper broadcasts
  `offline` to watchers.

## Tests

```sh
npm run test:unit
docker compose up -d --build --wait && npm run test:integration
```

The money test connects a driver directly to api-1's port and a watcher
directly to api-2's, and asserts the delivered frame says `via: 'api-1'` —
cross-server delivery proven, not assumed. Also covered: the reaper actually
terminates a client that stops answering pings (`autoPong: false`), Redis
channel subscriptions appear/disappear with watcher interest (asserted via
`PUBSUB CHANNELS`), and presence flips reach watchers on other nodes.

## Bench

One driver publishing at 2 Hz, N watchers all subscribed to it — the worst
case for fan-out, since every frame becomes N sends on one hot channel:

| watchers | ramp time | delivery | p50 | p95 | p99 | RSS api-1 / api-2 |
|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 3.4 s | 100% | 27 ms | 70 ms | 93 ms | 82 / 87 MB |
| 5,000 | 15.0 s | 100% | 122 ms | 223 ms | 247 ms | 98 / 102 MB |
| 10,000 | 28.0 s | 97.5% | 155 ms | 283 ms | 324 ms | 124 / 129 MB |

Honest numbers from a dev machine (Docker Desktop, bench client running as a
container inside the compose network), not a load lab. At 10k the missing
2.5% is the backpressure policy working as designed — plus the bench process
itself becoming a bottleneck parsing 20k messages/sec. Run yours:

```sh
docker compose run --rm --no-deps simulator \
  node dist/bench/sockets-bench.js --watchers 5000 --duration 20 \
  --url ws://nginx:8080/ws --rss "http://api-1:3000/healthz,http://api-2:3000/healthz"
```

(From the host, `npm run bench -- --watchers 500` works too, but on
Docker Desktop the Windows→VM port proxy throttles the connection ramp long
before the servers do — measure from inside the network.)

**What changes at 100k sockets?** This design's ceiling and the next moves:
shard hot driver channels; move fan-out off the API nodes (NATS or Redis
Cluster with keyslot-aware subscribers); regional edge nodes so watchers
subscribe near themselves; delta-encode positions instead of full frames; and
per-connection send queues with coalescing (the current drop-on-backpressure
policy is right for maps, wrong for anything transactional).

## Repository tour

```
src/server.ts        HTTP + WS upgrade, auth, message routing
src/hub.ts           per-node watcher registry + fan-out (the only state)
src/redis-bridge.ts  pub/sub wiring, interest-scoped (un)subscription
src/heartbeat.ts     ping/pong reaper
src/presence.ts      TTL-key presence + expiry sweeper
src/protocol.ts      zod-validated message types
client/              Leaflet map, reconnect with backoff, via badges
simulator/           N drivers on looping routes through nginx
test/integration/    cross-server delivery, reaping, interest lifecycle
bench/               connection ramp + delivery latency percentiles
```
