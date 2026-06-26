/**
 * Connection + delivery-latency bench against the compose stack.
 *
 *   npm run bench -- --watchers 1000 --duration 20
 *
 * Ramps N watcher connections through nginx (all watching one driver), then
 * has the driver publish at UPDATE_HZ for the measurement window. Latency is
 * measured client-side as receive-time minus the ts the driver stamped —
 * driver and watchers run in this same process, so one clock, no skew.
 */
import WebSocket from 'ws';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length - 1; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const URL = args.get('url') ?? 'ws://localhost:8080/ws';
const WATCHERS = Number(args.get('watchers') ?? 1000);
const DURATION_SEC = Number(args.get('duration') ?? 20);
const RAMP_BATCH = Number(args.get('batch') ?? 50);
// From the host, the compose ports are 3001/3002; when running inside the
// compose network (docker compose run), pass the api-N:3000 urls instead.
const RSS_URLS = (
  args.get('rss') ?? 'http://localhost:3001/healthz,http://localhost:3002/healthz'
).split(',');
const UPDATE_HZ = 2;
const DRIVER_ID = 'bench-driver';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function wsOpen(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function fetchRss(url: string): Promise<number | null> {
  try {
    const res = await fetch(url);
    const body = (await res.json()) as { rssBytes: number };
    return body.rssBytes;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`ramping ${WATCHERS} watchers → ${URL} (batches of ${RAMP_BATCH})`);
  const latencies: number[] = [];
  let measuring = false;
  let dropped = 0;

  const watchers: WebSocket[] = [];
  const rampStart = Date.now();
  for (let i = 0; i < WATCHERS; i += RAMP_BATCH) {
    const batch = await Promise.allSettled(
      Array.from({ length: Math.min(RAMP_BATCH, WATCHERS - i) }, () => wsOpen(URL)),
    );
    for (const result of batch) {
      if (result.status === 'rejected') {
        dropped++;
        continue;
      }
      const ws = result.value;
      watchers.push(ws);
      ws.on('error', () => {
        /* reset mid-bench — the delivery percentage already reflects it */
      });
      ws.send(JSON.stringify({ type: 'auth', payload: { role: 'watcher' } }));
      ws.send(JSON.stringify({ type: 'watch', payload: { driverId: DRIVER_ID } }));
      ws.on('message', (data) => {
        if (!measuring) return;
        const msg = JSON.parse(data.toString());
        if (msg.type === 'location') latencies.push(Date.now() - msg.ts);
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const rampMs = Date.now() - rampStart;
  console.log(`connected ${watchers.length}/${WATCHERS} in ${rampMs}ms (${dropped} failed)`);

  const driver = await wsOpen(URL);
  driver.on('error', () => {});
  driver.send(JSON.stringify({ type: 'auth', payload: { role: 'driver', driverId: DRIVER_ID } }));
  let seq = 0;
  const publisher = setInterval(() => {
    driver.send(
      JSON.stringify({
        type: 'location',
        payload: { lat: 26.2235, lng: 50.5876, heading: 90, speed: 10 },
        seq: seq++,
        ts: Date.now(),
      }),
    );
  }, 1000 / UPDATE_HZ);

  await new Promise((resolve) => setTimeout(resolve, 2000)); // warm-up
  measuring = true;
  console.log(`measuring for ${DURATION_SEC}s at ${UPDATE_HZ} Hz…`);
  await new Promise((resolve) => setTimeout(resolve, DURATION_SEC * 1000));
  measuring = false;
  clearInterval(publisher);

  latencies.sort((a, b) => a - b);
  const expected = DURATION_SEC * UPDATE_HZ * watchers.length;
  const [rss1, rss2] = await Promise.all(RSS_URLS.map(fetchRss));
  const mb = (bytes: number | null) => (bytes === null ? 'n/a' : `${(bytes / 1024 / 1024).toFixed(0)} MB`);

  console.log('\nresults');
  console.log(`  watchers connected   ${watchers.length}`);
  console.log(`  ramp time            ${rampMs} ms`);
  console.log(`  deliveries           ${latencies.length} (${((latencies.length / expected) * 100).toFixed(1)}% of expected ${expected})`);
  console.log(`  latency p50          ${percentile(latencies, 50)} ms`);
  console.log(`  latency p95          ${percentile(latencies, 95)} ms`);
  console.log(`  latency p99          ${percentile(latencies, 99)} ms`);
  console.log(`  rss api-1 / api-2    ${mb(rss1)} / ${mb(rss2)}`);

  driver.terminate();
  for (const ws of watchers) ws.terminate();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
