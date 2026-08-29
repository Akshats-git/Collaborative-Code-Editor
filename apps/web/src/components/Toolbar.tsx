import { useEffect, useRef, useState } from 'react';
import type { ConnectionStatus } from '../collab/provider.js';
import type { Peer } from '../collab/useCollab.js';
import { roomUrl } from '../room.js';
import { PeerList } from './PeerList.js';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  connected: 'Live',
  offline: 'Reconnecting',
  rejected: 'Rejected',
};

export interface ToolbarProps {
  roomId: string;
  onLeave(): void;
  status: ConnectionStatus;
  peers: Peer[];
}

type CopyState = 'idle' | 'copied' | 'failed';

export function Toolbar({ roomId, onLeave, status, peers }: ToolbarProps) {
  const [copy, setCopy] = useState<CopyState>('idle');
  const fallback = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => setCopy('idle'), copy === 'copied' ? 1500 : 8000);
    return () => clearTimeout(timer);
  }, [copy]);

  // The clipboard needs a secure context and a permission, and neither is
  // guaranteed. Falling back to a selected input keeps the link reachable
  // instead of leaving the button doing nothing.
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(roomUrl(roomId));
      setCopy('copied');
    } catch {
      setCopy('failed');
      queueMicrotask(() => fallback.current?.select());
    }
  };

  return (
    <header className="toolbar">
      <div className="toolbar__brand" aria-hidden="true" />

      <span className="toolbar__room">
        <span className="toolbar__roomPrefix">room /</span>
        <code className="toolbar__roomId">{roomId}</code>
      </span>

      <button className="button" type="button" onClick={() => void copyLink()}>
        {copy === 'copied' ? 'Copied' : 'Copy link'}
      </button>

      {copy === 'failed' && (
        <input
          ref={fallback}
          className="toolbar__fallback"
          readOnly
          value={roomUrl(roomId)}
          aria-label="Room link, copy it manually"
          onFocus={(event) => event.currentTarget.select()}
        />
      )}

      <div className="toolbar__right">
        <PeerList peers={peers} />
        <span className={`status status--${status}`}>
          <span className="status__dot" />
          {STATUS_LABEL[status]}
        </span>
        <button className="button" type="button" onClick={onLeave}>
          Leave
        </button>
      </div>
    </header>
  );
}
