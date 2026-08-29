/**
 * A room is a document plus the link that gets you into it.
 *
 * There is no account system, so the room id is the credential. A room is
 * private because nobody can find it, not because the server knows who you are,
 * which is the same model as an "anyone with the link" share.
 */

/** No 0/o/1/l/i, because a room code gets read aloud and typed by hand. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const GROUPS = 3;
const GROUP_SIZE = 4;

/** Matches the server's route, so an id it would reject never gets tried. */
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

const JOINED_KEY = 'cce.joined';

/**
 * 12 characters from a 31-character alphabet is a little under 60 bits, which
 * is the number that matters: it is the only thing standing between a stranger
 * and the document.
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

/** The room in the address bar, or null for the lobby. */
export function roomFromLocation(): string | null {
  return /^\/r\/([A-Za-z0-9_-]{1,64})\/?$/.exec(location.pathname)?.[1] ?? null;
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
 * Which rooms this tab has joined. Reloading the editor should not throw you
 * back to the door, but opening a shared link in a new tab should ask who you
 * are, and sessionStorage draws exactly that line.
 */
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
    return /\/r\/([A-Za-z0-9_-]{1,64})\/?$/.exec(new URL(trimmed).pathname)?.[1] ?? null;
  } catch {
    // Not a URL, so treat it as a bare code.
    return ROOM_ID.test(trimmed) ? trimmed : null;
  }
}

function joinedRooms(): string[] {
  try {
    const raw = sessionStorage.getItem(JOINED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
