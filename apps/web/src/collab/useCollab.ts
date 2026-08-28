import { useEffect, useState } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { socketUrl } from '../config.js';
import type { User } from '../user.js';
import { CollabProvider, type ConnectionStatus } from './provider.js';

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
export function useCollab(documentId: string, user: User) {
  const [session, setSession] = useState<CollabSession | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalStateField('user', user);

    const provider = new CollabProvider({ url: socketUrl(documentId), doc, awareness });
    const unsubscribe = provider.onStatusChange(setStatus);

    const readPeers = () => {
      setPeers(
        [...awareness.getStates()].flatMap(([clientId, state]) => {
          const peer = (state as { user?: User }).user;
          return peer ? [{ clientId, ...peer }] : [];
        }),
      );
    };

    awareness.on('change', readPeers);
    readPeers();

    setSession({ doc, text: doc.getText('content'), awareness });

    return () => {
      unsubscribe();
      awareness.off('change', readPeers);
      provider.destroy();
      awareness.destroy();
      doc.destroy();
      setSession(null);
    };
  }, [documentId, user]);

  return { session, status, peers };
}
