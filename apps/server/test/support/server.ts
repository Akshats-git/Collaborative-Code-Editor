import { createApp } from '../../src/app.js';
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
): Promise<T> {
  const app = createApp({ store });
  const port = await app.listen(0);
  try {
    return await body(`ws://127.0.0.1:${port}`);
  } finally {
    await app.close();
  }
}
