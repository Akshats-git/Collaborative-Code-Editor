/**
 * Framing for messages relayed between server instances.
 *
 * This is a separate wire format from `@cce/protocol`: that one is the contract
 * with browsers, this one is internal and carries a field browsers never need --
 * the id of the instance that sent it, so we can ignore our own echo.
 *
 *   [0]        kind
 *   [1]        length of the origin id in bytes
 *   [2 .. 2+n) origin id, utf-8
 *   [2+n ..]   payload
 */

export const BusKind = {
  /** A Yjs document update. */
  Update: 0,
  /** An awareness update: cursors, selections, joins and leaves. */
  Awareness: 1,
  /**
   * "I have just opened this document, send me what you have." Answered with an
   * Update carrying the full state.
   */
  StateRequest: 2,
} as const;

export type BusKindValue = (typeof BusKind)[keyof typeof BusKind];

export interface BusMessage {
  kind: BusKindValue;
  origin: string;
  payload: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const EMPTY_PAYLOAD = new Uint8Array(0);

export function encodeBusMessage(message: BusMessage): Uint8Array {
  const origin = textEncoder.encode(message.origin);
  if (origin.length > 255) throw new Error('instance id must be at most 255 bytes');

  const frame = new Uint8Array(2 + origin.length + message.payload.length);
  frame[0] = message.kind;
  frame[1] = origin.length;
  frame.set(origin, 2);
  frame.set(message.payload, 2 + origin.length);
  return frame;
}

export function decodeBusMessage(frame: Uint8Array): BusMessage {
  if (frame.length < 2) throw new Error('bus message is too short');

  const kind = frame[0] as BusKindValue;
  if (kind !== BusKind.Update && kind !== BusKind.Awareness && kind !== BusKind.StateRequest) {
    throw new Error(`unknown bus message kind ${String(frame[0])}`);
  }

  const originLength = frame[1] ?? 0;
  if (frame.length < 2 + originLength) throw new Error('bus message is truncated');

  return {
    kind,
    origin: textDecoder.decode(frame.subarray(2, 2 + originLength)),
    payload: frame.subarray(2 + originLength),
  };
}
