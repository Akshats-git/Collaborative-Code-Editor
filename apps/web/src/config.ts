const fallback = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8080`;

/** Set VITE_WS_URL when the server is not on localhost:8080 (Render, nginx, ...). */
export const serverUrl: string = import.meta.env.VITE_WS_URL ?? fallback;

export function socketUrl(documentId: string): string {
  return `${serverUrl}/doc/${encodeURIComponent(documentId)}`;
}
