import { useCallback, useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { languageById } from '../editor/languages.js';

const META = 'meta';
const LANGUAGE = 'language';

function read(doc: Y.Doc): string {
  return languageById(doc.getMap<string>(META).get(LANGUAGE)).id;
}

/**
 * The document's language, kept in a Y.Map inside the same Y.Doc as the text.
 * It is a property of the document rather than of the person looking at it, so
 * keeping it in the CRDT means it syncs, persists and merges like an edit.
 */
export function useDocumentLanguage(doc: Y.Doc): [string, (id: string) => void] {
  const [language, setLanguage] = useState(() => read(doc));

  useEffect(() => {
    const meta = doc.getMap<string>(META);
    const onChange = () => setLanguage(read(doc));
    meta.observe(onChange);
    onChange();
    return () => meta.unobserve(onChange);
  }, [doc]);

  const change = useCallback(
    (id: string) => {
      doc.getMap<string>(META).set(LANGUAGE, languageById(id).id);
    },
    [doc],
  );

  return [language, change];
}
