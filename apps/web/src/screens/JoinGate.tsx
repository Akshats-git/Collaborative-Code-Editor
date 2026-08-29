import { useState } from 'react';

export interface JoinGateProps {
  roomId: string;
  name: string;
  onJoin(name: string): void;
  onCancel(): void;
}

/**
 * What someone sees when they open a shared link. No socket is opened and no
 * document is fetched until they are through it: not joining means not seeing
 * the room at all, rather than seeing it and being unable to type.
 */
export function JoinGate({ roomId, name, onJoin, onCancel }: JoinGateProps) {
  // Empty, with the generated name as the placeholder. See Lobby.
  const [draft, setDraft] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    onJoin(draft.trim().slice(0, 32) || name);
  };

  return (
    <main className="gate">
      <form className="gate__card" onSubmit={submit}>
        <div className="gate__brand">
          <span className="gate__mark" aria-hidden="true" />
          <h1 className="gate__title">Join this room</h1>
        </div>

        <p className="gate__lede">You have been invited to edit</p>
        <code className="gate__roomCode">{roomId}</code>
        <p className="gate__lede">
          Pick a name so everyone can tell whose cursor is whose.
        </p>

        <label className="field">
          <span className="field__label">Your name</span>
          <input
            className="field__input"
            value={draft}
            maxLength={32}
            spellCheck={false}
            autoComplete="nickname"
            placeholder={name}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>

        <button className="button button--primary" type="submit">
          Join room
        </button>

        <button className="gate__link" type="button" onClick={onCancel}>
          Start my own room instead
        </button>
      </form>
    </main>
  );
}
