import { EditorState, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import { yCollab } from 'y-codemirror.next';
import type { CollabSession } from '../collab/useCollab.js';
import { languageById } from './languages.js';

interface CodeEditorProps {
  session: CollabSession;
  language: string;
}

/**
 * CodeMirror is bound straight to the Y.Text. `yCollab` turns editor
 * transactions into Yjs updates and remote updates back into transactions, so
 * there is no local copy of the document to keep in sync.
 */
export function CodeEditor({ session, language }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // A compartment swaps the language without rebuilding the view. Rebuilding it
  // would drop the Yjs binding and everyone's cursors with it.
  const languageSlot = useRef(new Compartment());

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const editor = new EditorView({
      parent,
      state: EditorState.create({
        extensions: [
          basicSetup,
          oneDark,
          languageSlot.current.of(languageById(language).extension()),
          EditorView.lineWrapping,
          yCollab(session.text, session.awareness),
        ],
      }),
    });
    view.current = editor;

    return () => {
      editor.destroy();
      view.current = null;
    };
    // Keyed on the session only. `language` is applied by the effect below,
    // because re-running this one would rebuild the editor for no reason.
  }, [session]);

  useEffect(() => {
    view.current?.dispatch({
      effects: languageSlot.current.reconfigure(languageById(language).extension()),
    });
  }, [language]);

  return <div className="editor" ref={host} />;
}
