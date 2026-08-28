import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { User } from '../user.js';
import { type ConnectionStatus } from './provider.js';
export interface CollabSession {
    doc: Y.Doc;
    text: Y.Text;
    awareness: Awareness;
}
export interface Peer extends User {
    clientId: number;
}
/**
 * Owns one document's lifetime: the Y.Doc, the awareness state and the socket.
 * Everything is created inside the effect so that switching documents (or React
 * StrictMode's double-mount in development) tears the previous one down cleanly.
 */
export declare function useCollab(documentId: string, user: User): {
    session: CollabSession | null;
    status: ConnectionStatus;
    peers: Peer[];
};
//# sourceMappingURL=useCollab.d.ts.map