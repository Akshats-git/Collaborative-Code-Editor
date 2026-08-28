import { javascript } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import { yCollab } from 'y-codemirror.next';
import type { CollabSession } from '../collab/useCollab.js';

/**
 * CodeMirror is bound straight to the Y.Text. `yCollab` turns editor
 * transactions into Yjs updates and remote updates back into transactions, so
 * there is no local copy of the document to keep in sync.
 */
export function CodeEditor({ session }: { session: CollabSession }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const view = new EditorView({
      parent,
      state: EditorState.create({
        extensions: [
          basicSetup,
          javascript({ typescript: true }),
          EditorView.lineWrapping,
          yCollab(session.text, session.awareness),
        ],
      }),
    });

    return () => view.destroy();
  }, [session]);

  return <div className="editor" ref={host} />;
}
