/**
 * Application close codes. RFC 6455 reserves 4000-4999 for private use, so the
 * client can tell "you did something wrong, do not retry" apart from "the
 * connection dropped, reconnect".
 */
export const CloseCode = {
  Unauthorized: 4001,
  DocumentNotSpecified: 4002,
  RateLimited: 4003,
  /** Send buffer grew past the point where the client could catch up. */
  Backpressure: 4004,
  ServerShuttingDown: 4005,
} as const;

export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

/** Codes where reconnecting with the same credentials would fail identically. */
const TERMINAL: ReadonlySet<number> = new Set<number>([
  CloseCode.Unauthorized,
  CloseCode.DocumentNotSpecified,
]);

export function isTerminalCloseCode(code: number): boolean {
  return TERMINAL.has(code);
}
