import { config } from '../config.js';
import { logger } from '../logger.js';
import { NO_BUS, type DocumentBus } from './bus.js';
import { RedisDocumentBus } from './redis-bus.js';

export { NO_BUS, type BusListener, type DocumentBus } from './bus.js';
export { BusKind, EMPTY_PAYLOAD, type BusKindValue, type BusMessage } from './messages.js';
export { decodeBusMessage, encodeBusMessage } from './messages.js';
export { RedisDocumentBus } from './redis-bus.js';

/** Falls back to a single-instance bus when no broker is configured. */
export function createDocumentBus(): DocumentBus {
  if (!config.redisUrl) {
    logger.warn('REDIS_URL is not set, edits will not reach other instances');
    return NO_BUS;
  }
  return new RedisDocumentBus(config.redisUrl, config.instanceId);
}
