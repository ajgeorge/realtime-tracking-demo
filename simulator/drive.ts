/**
 * Driver simulator: N fake drivers moving along looping routes around Manama,
 * each with its own WebSocket connection (through nginx, like a real phone
 * would connect), reconnecting with backoff if its node dies.
 */
import WebSocket from 'ws';

const WS_URL = process.env.WS_URL ?? 'ws://localhost:8080/ws';
const DRIVER_COUNT = Number(process.env.DRIVERS ?? 5);
const UPDATE_HZ = Number(process.env.UPDATE_HZ ?? 2);

const CENTER = { lat: 26.2235, lng: 50.5876 };
const METERS_PER_DEG_LAT = 111_320;

interface Point {
  lat: number;
  lng: number;
}

/** Deterministic per-driver PRNG so routes are stable across restarts. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A closed loop of waypoints: a wobbly ring around a per-driver center. */
function makeRoute(seed: number): Point[] {
  const rand = mulberry32(seed);
  const center = {
    lat: CENTER.lat + (rand() - 0.5) * 0.06,
    lng: CENTER.lng + (rand() - 0.5) * 0.06,
  };
  const radius = 800 + rand() * 1500; // meters
  const points: Point[] = [];
  const waypoints = 8 + Math.floor(rand() * 5);
  for (let i = 0; i < waypoints; i++) {
    const angle = (i / waypoints) * 2 * Math.PI;
    const r = radius * (0.7 + rand() * 0.6);
    points.push({
      lat: center.lat + (r * Math.sin(angle)) / METERS_PER_DEG_LAT,
      lng:
        center.lng +
        (r * Math.cos(angle)) / (METERS_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180)),
    });
  }
  return points;
}

function distanceMeters(a: Point, b: Point): number {
  const dLat = (b.lat - a.lat) * METERS_PER_DEG_LAT;
  const dLng = (b.lng - a.lng) * METERS_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

function bearingDegrees(a: Point, b: Point): number {
  const dLat = (b.lat - a.lat) * METERS_PER_DEG_LAT;
  const dLng = (b.lng - a.lng) * METERS_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return (Math.atan2(dLng, dLat) * 180) / Math.PI + (dLng < 0 ? 360 : 0);
}

class Driver {
  private ws?: WebSocket;
  private seq = 0;
  private attempts = 0;
  private waypoint = 0;
  private position: Point;
  private speed: number; // m/s
  private route: Point[];
  private tickTimer?: NodeJS.Timeout;

  constructor(private id: string, seed: number) {
    this.route = makeRoute(seed);
    this.position = { ...this.route[0] };
    this.speed = 8 + mulberry32(seed + 1)() * 8; // 29–58 km/h
  }

  connect(): void {
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      this.attempts = 0;
      this.ws!.send(JSON.stringify({ type: 'auth', payload: { role: 'driver', driverId: this.id } }));
      this.tickTimer = setInterval(() => this.tick(), 1000 / UPDATE_HZ);
      console.log(`[${this.id}] connected`);
    });

    const reconnect = () => {
      if (this.tickTimer) clearInterval(this.tickTimer);
      const base = Math.min(30_000, 1000 * 2 ** this.attempts);
      const delay = base / 2 + Math.random() * (base / 2);
      this.attempts++;
      console.log(`[${this.id}] disconnected, retrying in ${Math.round(delay)}ms`);
      setTimeout(() => this.connect(), delay);
    };

    this.ws.on('close', reconnect);
    this.ws.on('error', () => this.ws?.close());
  }

  private tick(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Advance along the loop by speed × dt, hopping waypoints as needed.
    let remaining = this.speed / UPDATE_HZ;
    while (remaining > 0) {
      const target = this.route[this.waypoint];
      const dist = distanceMeters(this.position, target);
      if (dist <= remaining) {
        this.position = { ...target };
        this.waypoint = (this.waypoint + 1) % this.route.length;
        remaining -= dist;
      } else {
        const frac = remaining / dist;
        this.position = {
          lat: this.position.lat + (target.lat - this.position.lat) * frac,
          lng: this.position.lng + (target.lng - this.position.lng) * frac,
        };
        remaining = 0;
      }
    }

    const heading = bearingDegrees(this.position, this.route[this.waypoint]) % 360;
    this.ws.send(
      JSON.stringify({
        type: 'location',
        payload: {
          lat: Number(this.position.lat.toFixed(6)),
          lng: Number(this.position.lng.toFixed(6)),
          heading: Number(heading.toFixed(1)),
          speed: Number(this.speed.toFixed(1)),
        },
        seq: this.seq++,
        ts: Date.now(),
      }),
    );
  }
}

console.log(`starting ${DRIVER_COUNT} drivers → ${WS_URL} @ ${UPDATE_HZ} Hz`);
for (let i = 1; i <= DRIVER_COUNT; i++) {
  new Driver(`sim-${i}`, i * 1337).connect();
}
