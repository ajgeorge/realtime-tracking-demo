export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeId: process.env.NODE_ID ?? 'api-local',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  /** Above this bufferedAmount a watcher stops receiving frames until it drains. */
  maxBufferedBytes: Number(process.env.MAX_BUFFERED_BYTES ?? 1_048_576),
};
