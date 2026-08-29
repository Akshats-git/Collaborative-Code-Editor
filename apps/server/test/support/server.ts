import { createApp } from '../../src/app.js';
import type { DocumentBus } from '../../src/cluster/index.js';
import { NO_BUS } from '../../src/cluster/index.js';
import type { DocumentStore } from '../../src/persistence/index.js';

/**
 * Runs `body` against a server on an ephemeral port and always shuts it down.
 *
 * The `finally` matters: a failed assertion inside `body` would otherwise leave
 * the server listening, and the test process would never exit.
 */
export async function withServer<T>(
  store: DocumentStore,
  body: (url: string) => Promise<T>,
  bus: DocumentBus = NO_BUS,
): Promise<T> {
  const app = createApp({ store, bus });
  const port = await app.listen(0);
  try {
    return await body(`ws://127.0.0.1:${port}`);
  } finally {
    await app.close();
  }
}

/**
 * Two instances sharing one store and one bus. That is what a pair of servers
 * behind nginx looks like, minus the network.
 */
export async function withCluster<T>(
  store: DocumentStore,
  bus: { endpoint(instanceId: string): DocumentBus },
  size: number,
  body: (urls: string[]) => Promise<T>,
): Promise<T> {
  const apps = Array.from({ length: size }, (_, index) =>
    createApp({ store, bus: bus.endpoint(`instance-${index}`) }),
  );
  const urls = await Promise.all(
    apps.map(async (app) => `ws://127.0.0.1:${await app.listen(0)}`),
  );
  try {
    return await body(urls);
  } finally {
    await Promise.all(apps.map((app) => app.close()));
  }
}
