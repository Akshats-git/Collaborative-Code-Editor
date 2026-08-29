const scheme = location.protocol === 'https:' ? 'wss' : 'ws';

/**
 * In dev the client is served by Vite on its own port, so it has to be told
 * where the server is. Built, it is served *by* that server, so the origin the
 * page came from is already the right answer and a deployment configures
 * nothing. Set VITE_WS_URL only to point a build at some other host.
 */
const fallback = import.meta.env.DEV
  ? `${scheme}://${location.hostname}:8080`
  : `${scheme}://${location.host}`;

export const serverUrl: string = import.meta.env.VITE_WS_URL ?? fallback;

/** The HTTP side of the same server: session tokens and health. */
export const apiUrl: string = import.meta.env.VITE_API_URL ?? serverUrl.replace(/^ws/, 'http');

export function socketUrl(documentId: string): string {
  return `${serverUrl}/doc/${encodeURIComponent(documentId)}`;
}
