# ADR 0004: Backpressure — drop frames to slow watchers

## Context

`ws.send()` never blocks; frames queue in `bufferedAmount` if the client
can't keep up. A watcher on a bad mobile link could balloon a node's memory
without bound — the classic slow-consumer problem.

## Decision

Before each send, check `bufferedAmount`. Past a threshold (1 MiB), skip the
frame for that socket. No queueing, no per-client buffers.

## Consequences

- Server memory stays bounded regardless of client behaviour.
- Correctness holds because location data is **last-write-wins**: a watcher
  that missed frames 5–8 renders frame 9 and is fully caught up. Dropping
  intermediate positions loses nothing a map cares about.
- This would be the wrong policy for value-carrying streams (chat, orders),
  which need per-client queues with eviction or resumable cursors — worth
  saying out loud, since "drop on backpressure" is only safe when the data
  model allows it.
- The heartbeat reaper still catches the fully-dead socket case; this handles
  the alive-but-slow case.
