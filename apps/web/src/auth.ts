import { apiUrl } from './config.js';

interface Session {
  token: string;
  expiresAt: number;
}

export interface TokenRequest {
  /** Set after the server rejected the current token, usually because it expired. */
  refresh: boolean;
}

/** Re-fetch a little before expiry rather than waiting to be rejected. */
const RENEW_MARGIN_MS = 60_000;

/**
 * Hands out a valid session token, fetching a new one when the current one is
 * close to expiring or has just been refused.
 *
 * `name` is a getter so that renaming yourself does not force a new token
 * source, and so does not drop the socket. The token lives in a closure rather
 * than localStorage, where an XSS bug could read a stale one back out.
 */
export function sessionSource(name: () => string): (request: TokenRequest) => Promise<string> {
  let session: Session | undefined;
  let inFlight: Promise<Session> | undefined;

  async function fetchSession(): Promise<Session> {
    const response = await fetch(`${apiUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name() }),
    });

    if (!response.ok) {
      throw new Error(`session request failed with ${response.status}`);
    }

    const body = (await response.json()) as { token: string; expiresIn: number };
    return { token: body.token, expiresAt: Date.now() + body.expiresIn * 1000 };
  }

  return async ({ refresh }) => {
    if (refresh) session = undefined;
    if (session && session.expiresAt - RENEW_MARGIN_MS > Date.now()) return session.token;

    // Collapse concurrent requests so a reconnect storm is one HTTP call.
    inFlight ??= fetchSession().finally(() => {
      inFlight = undefined;
    });

    session = await inFlight;
    return session.token;
  };
}
