import { z } from 'zod';

const driverIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w-]+$/, 'driverId must be alphanumeric, underscore or dash');

export const locationPayloadSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  heading: z.number().gte(0).lt(360),
  speed: z.number().gte(0),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth'),
    payload: z.object({
      role: z.enum(['driver', 'watcher']),
      driverId: driverIdSchema.optional(),
    }),
  }),
  z.object({
    type: z.literal('location'),
    payload: locationPayloadSchema,
    seq: z.number().int().nonnegative(),
    ts: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('watch'),
    payload: z.object({ driverId: driverIdSchema }),
  }),
  z.object({
    type: z.literal('unwatch'),
    payload: z.object({ driverId: driverIdSchema }),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type LocationPayload = z.infer<typeof locationPayloadSchema>;

/**
 * Server → client messages. `via` on location broadcasts names the node that
 * handled the driver's update — it makes cross-server routing visible in the UI.
 * `seq` lets watchers drop stale/out-of-order frames: Redis pub/sub gives no
 * ordering guarantee across reconnects.
 */
export interface LocationBroadcast {
  type: 'location';
  payload: LocationPayload;
  seq: number;
  ts: number;
  driverId: string;
  via: string;
}

export interface PresenceBroadcast {
  type: 'presence';
  payload: { driverId: string; status: 'online' | 'offline' };
}

export interface AuthOkMessage {
  type: 'auth_ok';
  payload: { nodeId: string };
}

export interface ErrorMessage {
  type: 'error';
  payload: { code: string; message: string };
}

export type ServerMessage = LocationBroadcast | PresenceBroadcast | AuthOkMessage | ErrorMessage;

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

/** Validate raw frames at the boundary; everything past this point is typed. */
export function parseClientMessage(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const result = clientMessageSchema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return { ok: false, error: detail };
  }
  return { ok: true, message: result.data };
}
