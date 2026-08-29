/**
 * A room is a document plus the link that gets you into it.
 *
 * There is no account system and no server-side membership list, so the room id
 * *is* the credential: it is unguessable, it travels in the URL, and holding it
 * is what lets you in. That is the same model as a "anyone with the link" share
 * in Docs or a Meet code, and it is worth being explicit that it is the model --
 * a room is private because nobody can find it, not because the server knows who
 * you are. Scoping session tokens to a room is the next step up, and it is a
 * server change rather than a client one.
 */

/** No 0/o/1/l/i: a room code gets read aloud and typed by hand. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const GROUPS = 3;
const GROUP_SIZE = 4;

/** Matches the server's route, so an id it would reject never gets tried. */
export const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 12 characters from a 31-character alphabet is a little under 60 bits, which is
 * the number that matters: it is the only thing standing between a stranger and
 * the document.
 */
export function createRoomId(): string {
  const chars: string[] = [];
  // Rejection sampling rather than `% ALPHABET.length`, which would make the
  // first few letters marginally likelier and quietly cost a bit of entropy.
  const limit = 256 - (256 % ALPHABET.length);
  const buffer = new Uint8Array(GROUPS * GROUP_SIZE * 2);

  while (chars.length < GROUPS * GROUP_SIZE) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= limit) continue;
      chars.push(ALPHABET[byte % ALPHABET.length] as string);
      if (chars.length === GROUPS * GROUP_SIZE) break;
    }
  }

  return Array.from({ length: GROUPS }, (_, group) =>
    chars.slice(group * GROUP_SIZE, (group + 1) * GROUP_SIZE).join(''),
  ).join('-');
}

/**
 * The room in the address bar, or null for the lobby. `?doc=` is the shape links
 * had before rooms existed; it still resolves so old ones do not break.
 */
export function roomFromLocation(): string | null {
  const path = /^\/r\/([A-Za-z0-9_-]{1,64})\/?$/.exec(location.pathname);
  if (path) return path[1] as string;

  const legacy = new URLSearchParams(location.search).get('doc');
  return legacy && ROOM_ID.test(legacy) ? legacy : null;
}

export function roomUrl(roomId: string): string {
  return `${location.origin}/r/${roomId}`;
}

export function pushRoom(roomId: string): void {
  history.pushState({}, '', `/r/${roomId}`);
}

export function pushLobby(): void {
  history.pushState({}, '', '/');
}

/**
 * Which rooms this tab has joined.
 *
 * Reloading the editor should not throw you back to the door, but opening a
 * shared link in a new tab should ask who you are. sessionStorage draws exactly
 * that line, and it is already where the local identity lives.
 */
const JOINED_KEY = 'cce.joined';

function joinedRooms(): string[] {
  try {
    const raw = sessionStorage.getItem(JOINED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function hasJoined(roomId: string): boolean {
  return joinedRooms().includes(roomId);
}

export function rememberJoin(roomId: string): void {
  const rooms = joinedRooms();
  if (!rooms.includes(roomId)) {
    sessionStorage.setItem(JOINED_KEY, JSON.stringify([...rooms, roomId]));
  }
}

export function forgetJoin(roomId: string): void {
  sessionStorage.setItem(JOINED_KEY, JSON.stringify(joinedRooms().filter((id) => id !== roomId)));
}

/**
 * Accepts what people actually paste: a full room link, or just the code.
 * Returns null for anything the server would refuse.
 */
export function parseRoomInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const fromPath = /\/r\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
    if (fromPath) return fromPath[1] as string;
    const legacy = url.searchParams.get('doc');
    return legacy && ROOM_ID.test(legacy) ? legacy : null;
  } catch {
    // Not a URL, so treat it as a bare code.
    return ROOM_ID.test(trimmed) ? trimmed : null;
  }
}
