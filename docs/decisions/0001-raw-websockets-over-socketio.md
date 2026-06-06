# ADR 0001: Raw `ws` over socket.io

## Context

socket.io gives you heartbeats, reconnection, rooms and multi-node adapters
out of the box. This repo's purpose is to demonstrate understanding of exactly
those mechanisms.

## Decision

Use the bare `ws` library and build heartbeats, reconnection with backoff,
subscription rooms (the hub) and cross-node fan-out (the Redis bridge)
explicitly.

## Consequences

- Every moving part is visible, testable and small (~100 lines each).
- We own the failure modes: half-open TCP detection, proxy timeout interplay,
  re-watch on reconnect — all documented where they're implemented.
- In a product codebase under deadline, socket.io (or its adapter pattern)
  would be a perfectly good choice; the point is knowing what it does for you.
