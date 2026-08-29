import { useCallback, useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar.js';
import { StatusBar } from './components/StatusBar.js';
import { useCollab } from './collab/useCollab.js';
import { useDocumentLanguage } from './collab/useDocumentLanguage.js';
import { useDocumentStats } from './collab/useDocumentStats.js';
import { CodeEditor } from './editor/CodeEditor.js';
import {
  createRoomId,
  forgetJoin,
  hasJoined,
  pushLobby,
  pushRoom,
  rememberJoin,
  roomFromLocation,
} from './room.js';
import { JoinGate } from './screens/JoinGate.js';
import { Lobby } from './screens/Lobby.js';
import { localUser, saveUser, type User } from './user.js';

/**
 * Three states, decided by the address bar and by whether this tab has been
 * through the door: the lobby, the join gate, and the room itself.
 */
export function App() {
  const [user, setUser] = useState(localUser);
  const [roomId, setRoomId] = useState(roomFromLocation);
  const [joined, setJoined] = useState(() => {
    const current = roomFromLocation();
    return current !== null && hasJoined(current);
  });

  useEffect(() => {
    document.title = roomId ? `${roomId} · Code Room` : 'Collaborative Code Editor';
  }, [roomId]);

  // The address bar is part of the interface here: a room is a link, and the
  // back button should behave.
  useEffect(() => {
    const onPopState = () => {
      const current = roomFromLocation();
      setRoomId(current);
      setJoined(current !== null && hasJoined(current));
    };
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, []);

  const rename = useCallback((name: string) => {
    setUser((current: User) => saveUser({ ...current, name }));
  }, []);

  const enter = useCallback(
    (id: string, name: string) => {
      rename(name);
      rememberJoin(id);
      pushRoom(id);
      setRoomId(id);
      setJoined(true);
    },
    [rename],
  );

  const leave = useCallback(() => {
    if (roomId) forgetJoin(roomId);
    pushLobby();
    setRoomId(null);
    setJoined(false);
  }, [roomId]);

  if (roomId === null) {
    return (
      <Lobby name={user.name} onCreate={(name) => enter(createRoomId(), name)} onJoin={enter} />
    );
  }

  if (!joined) {
    return (
      <JoinGate
        roomId={roomId}
        name={user.name}
        onJoin={(name) => enter(roomId, name)}
        onCancel={leave}
      />
    );
  }

  // Keyed on the room so that switching rooms remounts rather than trying to
  // reuse a socket and a Y.Doc that belong to the previous one.
  return <Room key={roomId} roomId={roomId} user={user} onRename={rename} onLeave={leave} />;
}

function Room({
  roomId,
  user,
  onRename,
  onLeave,
}: {
  roomId: string;
  user: User;
  onRename(name: string): void;
  onLeave(): void;
}) {
  const { session, status, peers } = useCollab(roomId, user);

  return (
    <div className="app">
      <Toolbar roomId={roomId} onLeave={onLeave} status={status} peers={peers} />

      {status === 'offline' && (
        <p className="notice">
          Disconnected. You can keep typing &mdash; your edits are held locally and merged when the
          connection comes back.
        </p>
      )}
      {status === 'rejected' && (
        <p className="notice notice--error">
          The server refused this room. Check the link and try again.
        </p>
      )}

      {session ? (
        <Document session={session} user={user} onRename={onRename} />
      ) : (
        <div className="editor" />
      )}
    </div>
  );
}

/**
 * Split out so the language and stats hooks can depend on a session that is
 * known to exist, rather than being written to tolerate null.
 */
function Document({
  session,
  user,
  onRename,
}: {
  session: NonNullable<ReturnType<typeof useCollab>['session']>;
  user: User;
  onRename(name: string): void;
}) {
  const [language, setLanguage] = useDocumentLanguage(session.doc);
  const stats = useDocumentStats(session.text);

  return (
    <>
      <CodeEditor session={session} language={language} />
      <StatusBar
        language={language}
        onLanguageChange={setLanguage}
        stats={stats}
        user={user}
        onRename={onRename}
      />
    </>
  );
}
