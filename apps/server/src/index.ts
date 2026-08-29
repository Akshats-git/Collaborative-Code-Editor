import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';

if (!config.auth.secret) {
  // A random key per process is fine when there is one process. In production
  // it means every restart invalidates every token and no two instances agree
  // on anything, which is better to refuse than to debug from a support ticket.
  if (config.isProduction) {
    logger.error('AUTH_SECRET must be set in production');
    process.exit(1);
  }
  logger.warn('AUTH_SECRET is not set, tokens will not verify across restarts or instances');
}

if (config.isProduction && config.corsOrigin === '*') {
  logger.warn('CORS_ORIGIN is *, so any site can request a session token');
}

const app = createApp();
await app.listen(config.port);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  // Clients that ignore the close frame should not hold the process open.
  setTimeout(() => process.exit(0), 5_000).unref();

  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
