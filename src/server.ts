import http from 'node:http';
import { config } from './config';

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        nodeId: config.nodeId,
        uptimeSec: Math.round(process.uptime()),
        rssBytes: process.memoryUsage().rss,
      }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(config.port, () => {
  console.log(`[${config.nodeId}] listening on :${config.port}`);
});
