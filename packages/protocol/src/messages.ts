/**
 * Wire format: one type byte followed by an opaque payload. Yjs updates are
 * already compact binary diffs, so wrapping them in JSON would only inflate them.
 */
export const MessageType = {
  /** y-protocols/sync payload: step1, step2 or update. */
  Sync: 0,
  /** y-protocols/awareness payload: cursors, selections, user metadata. */
  Awareness: 1,
  /** Client to server liveness probe. */
  Ping: 2,
  /** Server to client reply to a Ping. */
  Pong: 3,
  /** Client to server, first frame of the connection. Payload is a UTF-8 token. */
  Auth: 4,
} as const;

export type Message =
  | { type: typeof MessageType.Sync; payload: Uint8Array }
  | { type: typeof MessageType.Awareness; payload: Uint8Array }
  | { type: typeof MessageType.Ping }
  | { type: typeof MessageType.Pong }
  | { type: typeof MessageType.Auth; token: string };

const EMPTY = new Uint8Array(0);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeMessage(message: Message): Uint8Array {
  let payload: Uint8Array = EMPTY;
  if (message.type === MessageType.Auth) {
    payload = textEncoder.encode(message.token);
  } else if (message.type === MessageType.Sync || message.type === MessageType.Awareness) {
    payload = message.payload;
  }

  const frame = new Uint8Array(payload.length + 1);
  frame[0] = message.type;
  frame.set(payload, 1);
  return frame;
}

export function decodeMessage(frame: Uint8Array): Message {
  if (frame.length === 0) throw new Error('empty frame');

  const payload = frame.subarray(1);
  switch (frame[0]) {
    case MessageType.Sync:
      return { type: MessageType.Sync, payload };
    case MessageType.Awareness:
      return { type: MessageType.Awareness, payload };
    case MessageType.Ping:
      return { type: MessageType.Ping };
    case MessageType.Pong:
      return { type: MessageType.Pong };
    case MessageType.Auth:
      return { type: MessageType.Auth, token: textDecoder.decode(payload) };
    default:
      throw new Error(`unknown message type ${frame[0]}`);
  }
}
