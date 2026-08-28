function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

export const config = {
  port: int('PORT', 8080),
  /** Unset means no durability: documents live only as long as the process. */
  databaseUrl: process.env.DATABASE_URL ?? '',
  /** Identifies this process in logs. Useful once several instances are running. */
  instanceId: process.env.INSTANCE_ID ?? `srv-${process.pid}`,

  heartbeat: {
    /** How often the server pings each socket. */
    intervalMs: int('HEARTBEAT_INTERVAL_MS', 30_000),
  },

  auth: {
    /** Shared by every instance. Unset means tokens do not survive a restart. */
    secret: process.env.AUTH_SECRET ?? '',
    ttlSeconds: int('AUTH_TTL_SECONDS', 3600),
    /** How long a socket may sit unauthenticated before it is dropped. */
    handshakeTimeoutMs: int('AUTH_TIMEOUT_MS', 5_000),
  },

  /** Origin allowed to call the HTTP API. The WebSocket path does not use cookies. */
  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  persistence: {
    /** Upper bound on how much editing a hard crash can lose. */
    debounceMs: int('PERSIST_DEBOUNCE_MS', 500),
    maxBatchBytes: int('PERSIST_MAX_BATCH_BYTES', 64 * 1024),
    compactAfter: int('COMPACT_AFTER_UPDATES', 200),
  },
} as const;
