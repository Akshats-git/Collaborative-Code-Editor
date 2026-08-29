import { useCallback, useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar.js';
import { StatusBar } from './components/StatusBar.js';
import { useCollab } from './collab/useCollab.js';
import { useDocumentLanguage } from './collab/useDocumentLanguage.js';
import { useDocumentStats } from './collab/useDocumentStats.js';
import { CodeEditor } from './editor/CodeEditor.js';
import { localUser, saveUser, type User } from './user.js';

function documentIdFromLocation(): string {
  return new URLSearchParams(location.search).get('doc') ?? 'demo';
}

export function App() {
  const [user, setUser] = useState(localUser);
  const [documentId, setDocumentId] = useState(documentIdFromLocation);
  const { session, status, peers } = useCollab(documentId, user);

  const openDocument = useCallback((id: string) => {
    if (id === documentIdFromLocation()) return;
    const url = new URL(location.href);
    url.searchParams.set('doc', id);
    history.pushState({}, '', url);
    setDocumentId(id);
  }, []);

  useEffect(() => {
    document.title = `${documentId} · Collaborative Code Editor`;
  }, [documentId]);

  // The address bar is part of the interface here: a document is a link, and
  // the back button should behave.
  useEffect(() => {
    const onPopState = () => setDocumentId(documentIdFromLocation());
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, []);

  const rename = useCallback((name: string) => {
    setUser((current: User) => saveUser({ ...current, name }));
  }, []);

  return (
    <div className="app">
      <Toolbar
        documentId={documentId}
        onOpenDocument={openDocument}
        status={status}
        peers={peers}
      />

      {status === 'offline' && (
        <p className="notice">
          Disconnected. You can keep typing &mdash; your edits are held locally and merged when the
          connection comes back.
        </p>
      )}
      {status === 'rejected' && (
        <p className="notice notice--error">
          The server refused this document. Check the name and try another.
        </p>
      )}

      {session ? <Document session={session} user={user} onRename={rename} /> : <div className="editor" />}
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
