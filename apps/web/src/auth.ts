import { apiUrl } from './config.js';

interface Session {
  token: string;
  expiresAt: number;
}

export interface TokenRequest {
  /** Set after the server rejected the current token, e.g. because it expired. */
  refresh: boolean;
}

/** Re-fetch a little before expiry rather than waiting to be rejected. */
const RENEW_MARGIN_MS = 60_000;

/**
 * Returns a function that hands out a valid session token, fetching a new one
 * when the current one is close to expiring or has just been refused.
 *
 * The token is held in a closure rather than in localStorage: it is short-lived,
 * it is only useful for the tab that is holding a socket open, and keeping it
 * out of persistent storage means an XSS bug cannot read a stale one back out.
 */
export function sessionSource(name: string): (request: TokenRequest) => Promise<string> {
  let session: Session | undefined;
  let inFlight: Promise<Session> | undefined;

  async function fetchSession(): Promise<Session> {
    const response = await fetch(`${apiUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
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
