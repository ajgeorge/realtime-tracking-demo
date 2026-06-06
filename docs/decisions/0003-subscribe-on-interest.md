# ADR 0003: Subscribe on first watcher, unsubscribe on last

## Context

Each node needs to hear Redis messages for the drivers its watchers care
about. The lazy option is every node subscribing to a firehose (`driver:*`
via PSUBSCRIBE) and filtering locally.

## Decision

A node subscribes to `driver:{id}` when its *first* local watcher for that
driver arrives, and unsubscribes when the *last* one leaves. The hub owns the
watcher registry and emits first/last callbacks; the bridge translates them
into SUBSCRIBE/UNSUBSCRIBE.

## Consequences

- Redis fan-out work is proportional to *interest*, not fleet size: a driver
  nobody watches costs one `PUBLISH` to zero subscribers.
- The integration suite asserts the lifecycle via `PUBSUB CHANNELS` — the
  channel appears on watch and disappears on the last unwatch.
- Trade-off: subscribe latency (~1 RTT) sits on the first-watch path. The
  first frame a brand-new watcher sees may be the one after next. Acceptable
  for location streams; a chat system might pre-subscribe hot channels.
