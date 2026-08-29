import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

export interface DocumentStats {
  lines: number;
  characters: number;
}

function measure(text: Y.Text): DocumentStats {
  const value = text.toString();
  return { lines: value === '' ? 1 : value.split('\n').length, characters: value.length };
}

/** Observes the shared text, so it counts remote edits as well as local ones. */
export function useDocumentStats(text: Y.Text): DocumentStats {
  const [stats, setStats] = useState(() => measure(text));

  useEffect(() => {
    const update = () => setStats(measure(text));
    text.observe(update);
    update();
    return () => text.unobserve(update);
  }, [text]);

  return stats;
}
