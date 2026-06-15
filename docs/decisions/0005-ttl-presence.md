# ADR 0005: Presence via Redis TTL keys

## Context

"Is driver X online?" must have one answer across all nodes, but no node owns
the driver — it may reconnect anywhere at any time, or vanish without a FIN.

## Decision

Every location update refreshes `SET presence:driver:{id} {nodeId} EX 45`.
A driver is online iff the key exists. The `SET ... GET` form atomically
reveals offline→online flips, which are broadcast on a `presence` channel.
A per-node sweeper polls the keys that node last refreshed: key gone → TTL
lapsed → broadcast `offline`; key owned by another node → the driver moved →
hand over silently.

## Consequences

- No cleanup handshake exists to forget: crashed driver, crashed node, or
  partitioned network all converge to "key expires" with zero coordination.
- Liveness lag is bounded by the TTL (45s) plus sweep interval — presence is
  deliberately eventual. Brief reconnects don't flap to offline, which is a
  feature for a driver going through a tunnel.
- Alternative considered: Redis keyspace notifications (`notify-keyspace-events Ex`)
  push expiry events instead of polling. Rejected here because notifications
  are fire-and-forget (a node that's down during the event misses it forever)
  and need server config; the sweep re-derives truth from the keys themselves
  every pass, so it self-heals.
