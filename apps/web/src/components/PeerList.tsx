import type { Peer } from '../collab/useCollab.js';

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * Everyone currently in the document. This is awareness state, so it is
 * accurate to within one heartbeat and never read from storage.
 */
export function PeerList({ peers }: { peers: Peer[] }) {
  const others = peers.filter((peer) => !peer.isSelf);
  if (others.length === 0) return <p className="peers__empty">Only you are here</p>;

  return (
    <ul className="peers" aria-label={`${others.length} other people editing`}>
      {others.map((peer) => (
        <li key={peer.clientId} className="peers__item" title={peer.name}>
          <span className="avatar" style={{ background: peer.color }}>
            {initials(peer.name)}
          </span>
        </li>
      ))}
    </ul>
  );
}
