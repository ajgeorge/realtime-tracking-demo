# ADR 0006: least_conn, not sticky sessions

## Context

The standard fix for multi-instance WebSockets is session affinity — pin each
client to one node (ip_hash, cookies) so its state stays local.

## Decision

nginx uses `least_conn`. Any client may land on any node at any time,
including a different node after every reconnect.

## Consequences

- This is the load-bearing decision: the Redis bridge and TTL presence exist
  precisely so that affinity is unnecessary. If the demo *worked only with*
  sticky sessions, the architecture would be decorative.
- Node death is handled by the same mechanism as normal login — reconnect,
  re-auth, re-watch — rather than a special failover path. The chaos script
  demonstrates it.
- `least_conn` (over round-robin) because WebSockets are long-lived: balance
  should track *current open connections*, not arrival order, or a node
  restart leaves the survivor permanently overloaded.
