function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

export const config = {
  port: int('PORT', 8080),
  /** Identifies this process in logs. Useful once several instances are running. */
  instanceId: process.env.INSTANCE_ID ?? `srv-${process.pid}`,

  heartbeat: {
    /** How often the server pings each socket. */
    intervalMs: int('HEARTBEAT_INTERVAL_MS', 30_000),
  },
} as const;
