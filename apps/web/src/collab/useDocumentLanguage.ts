import { useCallback, useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { DEFAULT_LANGUAGE, languageById } from '../editor/languages.js';

const META = 'meta';
const LANGUAGE = 'language';

function read(doc: Y.Doc): string {
  return languageById(doc.getMap<string>(META).get(LANGUAGE)).id;
}

/**
 * The document's language, kept in a Y.Map inside the same Y.Doc as the text.
 *
 * It could have been local state, but it is a property of the document rather
 * than of the person looking at it -- so it syncs to everyone, persists with the
 * document, and merges under the same rules as an edit. Which is the argument
 * for putting shared state in the CRDT rather than beside it.
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

  return [language ?? DEFAULT_LANGUAGE, change];
}
