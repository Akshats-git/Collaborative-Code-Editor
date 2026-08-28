import { useMemo, useState } from 'react';
import { useCollab } from './collab/useCollab.js';
import { CodeEditor } from './editor/CodeEditor.js';
import { localUser } from './user.js';

const STATUS_LABEL = {
  connecting: 'connecting',
  connected: 'live',
  offline: 'reconnecting',
  rejected: 'rejected',
} as const;

function documentIdFromLocation(): string {
  return new URLSearchParams(location.search).get('doc') ?? 'demo';
}

export function App() {
  const user = useMemo(localUser, []);
  const [documentId] = useState(documentIdFromLocation);
  const { session, status, peers } = useCollab(documentId, user);

  return (
    <div className="app">
      <header className="bar">
        <span className="doc">{documentId}</span>

        <span className={`status status--${status}`}>{STATUS_LABEL[status]}</span>

        <ul className="peers">
          {peers.map((peer) => (
            <li key={peer.clientId} style={{ borderColor: peer.color }}>
              {peer.name}
            </li>
          ))}
        </ul>
      </header>

      {session && <CodeEditor session={session} />}
    </div>
  );
}
