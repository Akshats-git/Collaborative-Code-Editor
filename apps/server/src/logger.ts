import { config } from './config.js';

type Fields = Record<string, unknown>;

/**
 * One JSON object per line. Most log aggregators parse that for free, and it
 * stays greppable when three instances interleave their output.
 */
function write(level: 'info' | 'warn' | 'error', message: string, fields?: Fields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    instance: config.instanceId,
    message,
    ...fields,
  });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  info: (message: string, fields?: Fields) => write('info', message, fields),
  warn: (message: string, fields?: Fields) => write('warn', message, fields),
  error: (message: string, fields?: Fields) => write('error', message, fields),
};
