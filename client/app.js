/* global L */
'use strict';

// --- map ------------------------------------------------------------------
const map = L.map('map').setView([26.2235, 50.5876], 13); // Manama
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const COLORS = ['#3567c4', '#c43333', '#1a9c4b', '#d99114', '#8a4bc9', '#0e8a8a'];
const TRAIL_LENGTH = 60;

// --- state ----------------------------------------------------------------
const drivers = new Map(); // id -> { online, watching, marker, trail, lastSeq, via, el }
let ws = null;
let attempts = 0;
let reconnectTimer = null;

const statusEl = document.getElementById('status');
const listEl = document.getElementById('drivers');

function setStatus(cls, text) {
  statusEl.className = cls;
  statusEl.textContent = text;
}

// --- driver list ----------------------------------------------------------
function colorFor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function ensureDriver(id) {
  let d = drivers.get(id);
  if (d) return d;
  d = { online: false, watching: false, marker: null, trail: null, lastSeq: -1, via: null };

  const li = document.createElement('li');
  li.innerHTML = `<span class="dot"></span><span class="name">${id}</span><span class="via"></span>`;
  li.addEventListener('click', () => toggleWatch(id));
  listEl.appendChild(li);
  d.el = li;

  drivers.set(id, d);
  return d;
}

function renderDriver(id) {
  const d = drivers.get(id);
  if (!d) return;
  d.el.classList.toggle('watching', d.watching);
  d.el.querySelector('.dot').className = `dot${d.online ? ' online' : ''}`;
  const via = d.el.querySelector('.via');
  via.textContent = d.watching && d.via ? `via ${d.via}` : '';
  via.className = `via ${d.via || ''}`;
}

function toggleWatch(id) {
  const d = ensureDriver(id);
  d.watching = !d.watching;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: d.watching ? 'watch' : 'unwatch', payload: { driverId: id } }));
  }
  if (!d.watching) {
    if (d.marker) { d.marker.remove(); d.marker = null; }
    if (d.trail) { d.trail.remove(); d.trail = null; }
    d.lastSeq = -1;
    d.via = null;
  }
  renderDriver(id);
}

// --- websocket with reconnect + backoff ------------------------------------
function connect() {
  setStatus('connecting', attempts ? `reconnecting (try ${attempts + 1})…` : 'connecting…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    attempts = 0;
    setStatus('connected', 'connected');
    ws.send(JSON.stringify({ type: 'auth', payload: { role: 'watcher' } }));
    // Re-establish every watch after a reconnect — the new node knows nothing
    // about us, and it might be a *different* node than before.
    for (const [id, d] of drivers) {
      if (d.watching) {
        d.lastSeq = -1; // seq restarts if the driver also reconnected
        ws.send(JSON.stringify({ type: 'watch', payload: { driverId: id } }));
      }
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'location') handleLocation(msg);
    else if (msg.type === 'presence') handlePresence(msg);
  };

  ws.onclose = () => {
    setStatus('disconnected', 'disconnected');
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  // Exponential backoff with jitter: 1s → 30s cap. Jitter stops every client
  // a dead node was carrying from stampeding the survivor in sync.
  const base = Math.min(30000, 1000 * 2 ** attempts);
  const delay = base / 2 + Math.random() * (base / 2);
  attempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// --- message handling -------------------------------------------------------
function handleLocation(msg) {
  const d = ensureDriver(msg.driverId);
  if (!d.watching) return;
  // Drop stale/out-of-order frames: Redis pub/sub guarantees no ordering
  // across reconnects, so the client enforces it with seq.
  if (msg.seq <= d.lastSeq) return;
  d.lastSeq = msg.seq;
  d.via = msg.via;

  const { lat, lng, speed } = msg.payload;
  const pos = [lat, lng];
  const color = colorFor(msg.driverId);

  if (!d.marker) {
    d.marker = L.circleMarker(pos, { radius: 8, color, fillColor: color, fillOpacity: 0.9 }).addTo(map);
    d.trail = L.polyline([pos], { color, weight: 2, opacity: 0.6 }).addTo(map);
  } else {
    d.marker.setLatLng(pos);
    const points = d.trail.getLatLngs();
    points.push(L.latLng(lat, lng));
    if (points.length > TRAIL_LENGTH) points.shift();
    d.trail.setLatLngs(points);
  }
  d.marker.bindTooltip(`${msg.driverId} · ${(speed * 3.6).toFixed(0)} km/h · via ${msg.via}`);
  renderDriver(msg.driverId);
}

function handlePresence(msg) {
  const d = ensureDriver(msg.payload.driverId);
  d.online = msg.payload.status === 'online';
  renderDriver(msg.payload.driverId);
}

// --- driver discovery -------------------------------------------------------
async function refreshDrivers() {
  try {
    const res = await fetch('/drivers');
    if (!res.ok) return;
    const body = await res.json();
    for (const id of body.drivers) {
      const d = ensureDriver(id);
      if (!d.online) { d.online = true; renderDriver(id); }
    }
  } catch {
    /* API unreachable — the status pill already says so */
  }
}

connect();
refreshDrivers();
setInterval(refreshDrivers, 5000);
