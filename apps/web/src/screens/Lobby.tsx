import { useState } from 'react';
import { parseRoomInput } from '../room.js';

export interface LobbyProps {
  name: string;
  onCreate(name: string): void;
  onJoin(roomId: string, name: string): void;
}

/**
 * The front door. Two ways in and nothing else: start a room, or open one
 * somebody sent you.
 */
export function Lobby({ name, onCreate, onJoin }: LobbyProps) {
  // Empty, with the generated name as the placeholder: pre-filling the value
  // means anyone who types is appending to a name they never chose.
  const [draftName, setDraftName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const displayName = (): string => draftName.trim().slice(0, 32) || name;

  const join = (event: React.FormEvent) => {
    event.preventDefault();
    const roomId = parseRoomInput(code);
    if (!roomId) {
      setError('That does not look like a room code or link.');
      return;
    }
    onJoin(roomId, displayName());
  };

  return (
    <main className="gate">
      <div className="gate__card">
        <div className="gate__brand">
          <span className="gate__mark" aria-hidden="true" />
          <h1 className="gate__title">Collaborative Code Editor</h1>
        </div>
        <p className="gate__lede">
          Start a room and share the link. Everyone who opens it edits the same file, at the same
          time.
        </p>

        <label className="field">
          <span className="field__label">Your name</span>
          <input
            className="field__input"
            value={draftName}
            maxLength={32}
            spellCheck={false}
            autoComplete="nickname"
            placeholder={name}
            onChange={(event) => setDraftName(event.target.value)}
          />
        </label>

        <button className="button button--primary" type="button" onClick={() => onCreate(displayName())}>
          Create a room
        </button>

        <div className="gate__divider">
          <span>or join one</span>
        </div>

        <form className="gate__join" onSubmit={join}>
          <input
            className="field__input field__input--mono"
            value={code}
            spellCheck={false}
            placeholder="Paste a link or code"
            aria-label="Room link or code"
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setCode(event.target.value);
              setError('');
            }}
          />
          <button className="button" type="submit">
            Join
          </button>
        </form>

        {error && (
          <p className="gate__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
