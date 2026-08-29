import { useEffect, useState } from 'react';
import type { DocumentStats } from '../collab/useDocumentStats.js';
import { LANGUAGES } from '../editor/languages.js';
import type { User } from '../user.js';

export interface StatusBarProps {
  language: string;
  onLanguageChange(id: string): void;
  stats: DocumentStats;
  user: User;
  onRename(name: string): void;
}

export function StatusBar({ language, onLanguageChange, stats, user, onRename }: StatusBarProps) {
  const [draft, setDraft] = useState(user.name);
  useEffect(() => setDraft(user.name), [user.name]);

  const commit = () => {
    const next = draft.trim().slice(0, 32);
    if (next) onRename(next);
    else setDraft(user.name);
  };

  return (
    <footer className="statusbar">
      <label className="statusbar__field">
        <span className="statusbar__label">Language</span>
        <select
          className="select"
          value={language}
          onChange={(event) => onLanguageChange(event.target.value)}
        >
          {LANGUAGES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <span className="statusbar__stats">
        {stats.lines} {stats.lines === 1 ? 'line' : 'lines'} &middot; {stats.characters}{' '}
        {stats.characters === 1 ? 'character' : 'characters'}
      </span>

      <label className="statusbar__field statusbar__field--right">
        <span className="dot" style={{ background: user.color }} />
        <input
          className="statusbar__name"
          value={draft}
          maxLength={32}
          spellCheck={false}
          aria-label="Your display name"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setDraft(user.name);
          }}
        />
      </label>
    </footer>
  );
}
