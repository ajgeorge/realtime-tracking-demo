# realtime-tracking-demo

Cross-server realtime location streaming: raw WebSockets, Redis pub/sub,
nginx `least_conn` — no sticky sessions.

**The claim this repo will prove:** a driver connected to server A streams
live location to watchers connected to server B. Two API instances behind a
proxy, dead connections reaped by heartbeats. One command to run, one page to
watch it happen.

Building in the open, evenings. Proper README once the cross-server path is
proven by an integration test.
