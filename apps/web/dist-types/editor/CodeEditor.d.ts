import type { CollabSession } from '../collab/useCollab.js';
/**
 * CodeMirror is bound straight to the Y.Text. `yCollab` turns editor
 * transactions into Yjs updates and remote updates back into transactions, so
 * there is no local copy of the document to keep in sync.
 */
export declare function CodeEditor({ session }: {
    session: CollabSession;
}): import("react").JSX.Element;
//# sourceMappingURL=CodeEditor.d.ts.map