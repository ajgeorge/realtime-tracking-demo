# ADR 0002: Publish through Redis even for local watchers

## Context

When a driver's update arrives on a node that also hosts watchers for that
driver, the node could deliver to them directly and skip a Redis round-trip.

## Decision

Every update goes through `PUBLISH` → subscription → `deliverLocal`, even on
the publishing node.

## Consequences

- One code path. Delivery is identical whether the watcher is co-located with
  the driver or not, so the cross-server path is exercised by every message,
  not just the rare ones.
- Ordering is consistent: all watchers of a driver see frames in the order
  Redis fanned them out, not a mix of "local fast path" and "remote path".
- Cost: one Redis round-trip (~sub-millisecond on the compose network) added
  to local deliveries. For location streaming at 2 Hz this is noise; a
  latency-critical system might revisit this and accept the dual path.
