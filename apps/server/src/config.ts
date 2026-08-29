function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

export const config = {
  port: int('PORT', 8080),
  /** Turns warnings that are fine locally into refusals to start. */
  isProduction: process.env.NODE_ENV === 'production',
  /** Unset means no durability: documents live only as long as the process. */
  databaseUrl: process.env.DATABASE_URL ?? '',
  /**
   * Identifies this process in logs, and on the bus, where it is how an instance
   * recognises the echo of its own publishes. Must be unique per instance.
   */
  instanceId:
    process.env.INSTANCE_ID ??
    // Render exposes this; other hosts will not, and the pid is only unique
    // within one machine -- so set INSTANCE_ID explicitly anywhere that runs
    // more than one instance.
    process.env.RENDER_INSTANCE_ID ??
    `srv-${process.pid}`,
  /** Unset means one instance: edits never leave the process that accepted them. */
  redisUrl: process.env.REDIS_URL ?? '',

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

  /**
   * Per connection. Bursts are allowed at twice the sustained rate, which is
   * what a paste or a reconnect resync looks like.
   */
  rateLimit: {
    /** Budget for document traffic. A frame costs at least `minFrameCost`. */
    bytesPerSecond: int('RATE_LIMIT_BYTES_PER_SECOND', 1024 * 1024),
    /**
     * Charged for every frame regardless of size, so a flood of tiny updates
     * costs the same budget as a flood of large ones.
     */
    minFrameCost: int('RATE_LIMIT_MIN_FRAME_COST', 1024),
    /** Cursor and selection frames, counted rather than weighed. */
    presencePerSecond: int('RATE_LIMIT_PRESENCE_PER_SECOND', 60),
  },

  /**
   * How far behind a client's send buffer may fall before we start protecting
   * the server from it. Measured in bytes still queued in the kernel and in
   * `ws`, which is what `bufferedAmount` reports.
   */
  backpressure: {
    /** Above this, presence updates for that client are dropped. */
    softBytes: int('BACKPRESSURE_SOFT_BYTES', 256 * 1024),
    /** Above this, the connection is closed. Document updates are never dropped. */
    hardBytes: int('BACKPRESSURE_HARD_BYTES', 4 * 1024 * 1024),
  },

  persistence: {
    /** Upper bound on how much editing a hard crash can lose. */
    debounceMs: int('PERSIST_DEBOUNCE_MS', 500),
    maxBatchBytes: int('PERSIST_MAX_BATCH_BYTES', 64 * 1024),
    compactAfter: int('COMPACT_AFTER_UPDATES', 200),
  },
} as const;
