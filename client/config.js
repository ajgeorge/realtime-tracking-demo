// Point this at your Railway edge (nginx) service's public domain, e.g.
// 'realtime-tracking-demo-edge-production.up.railway.app' — no protocol, no path.
// Leave empty for local dev: the client falls back to same-origin, exactly
// like docker compose (nginx serves the map and the API on the same :8080).
window.API_BASE = '';
