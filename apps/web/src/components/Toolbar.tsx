import { useEffect, useState } from 'react';
import type { ConnectionStatus } from '../collab/provider.js';
import type { Peer } from '../collab/useCollab.js';
import { PeerList } from './PeerList.js';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  connected: 'Live',
  offline: 'Reconnecting',
  rejected: 'Rejected',
};

export interface ToolbarProps {
  documentId: string;
  onOpenDocument(id: string): void;
  status: ConnectionStatus;
  peers: Peer[];
}

export function Toolbar({ documentId, onOpenDocument, status, peers }: ToolbarProps) {
  const [draft, setDraft] = useState(documentId);
  const [copied, setCopied] = useState(false);

  // Keeps the field honest when the document changes from somewhere else, such
  // as the back button.
  useEffect(() => setDraft(documentId), [documentId]);

  const open = () => {
    const next = draft.trim();
    // Matches the server's route, so a name it would reject never gets tried.
    if (next && /^[A-Za-z0-9_-]{1,64}$/.test(next)) onOpenDocument(next);
    else setDraft(documentId);
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <header className="toolbar">
      <div className="toolbar__brand" aria-hidden="true" />

      <label className="toolbar__doc">
        <span className="toolbar__docPrefix">doc /</span>
        <input
          className="toolbar__docInput"
          value={draft}
          spellCheck={false}
          aria-label="Document name"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={open}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setDraft(documentId);
          }}
        />
      </label>

      <button className="button" type="button" onClick={() => void copyLink()}>
        {copied ? 'Copied' : 'Copy link'}
      </button>

      <div className="toolbar__right">
        <PeerList peers={peers} />
        <span className={`status status--${status}`}>
          <span className="status__dot" />
          {STATUS_LABEL[status]}
        </span>
      </div>
    </header>
  );
}
