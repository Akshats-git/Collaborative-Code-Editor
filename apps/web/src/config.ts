const fallback = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8080`;

/** Set VITE_WS_URL when the server is not on localhost:8080 (Render, nginx, ...). */
export const serverUrl: string = import.meta.env.VITE_WS_URL ?? fallback;

/** The HTTP side of the same server: session tokens and health. */
export const apiUrl: string = import.meta.env.VITE_API_URL ?? serverUrl.replace(/^ws/, 'http');

export function socketUrl(documentId: string): string {
  return `${serverUrl}/doc/${encodeURIComponent(documentId)}`;
}
