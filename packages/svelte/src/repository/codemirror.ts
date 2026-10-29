/**
 * CodeMirror 6 bound to a repository editor (`openEditor`). Each local
 * change hands the editor the new draft; the editor saves it. When the
 * editor replaces its draft from outside (typing carried onto the worker's
 * merged text, or a change from elsewhere followed), its changes are
 * applied in place, marked `Transaction.remote` and kept out of the undo
 * history: CodeMirror maps the selection and the history through them, so
 * the cursor stays where the person was typing and Undo takes back only
 * their own keystrokes.
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, type Extension, Transaction } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin } from '@codemirror/view';
import type { Editor } from '@epicenter/repository/api';

/** Keep a view and an editor's draft one text. */
export function editorBinding(editor: Editor): Extension {
	return [
		EditorView.updateListener.of((update) => {
			if (!update.docChanged) return;
			if (update.transactions.every((transaction) => !transaction.docChanged || transaction.annotation(Transaction.remote))) return;
			editor.update(update.state.doc.toString());
		}),
		ViewPlugin.define((view) => {
			const stop = editor.subscribe(({ replaced }) => {
				if (replaced === null || replaced.length === 0) return;
				view.dispatch({ changes: replaced, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] });
			});
			return { destroy: stop };
		}),
	];
}

/** A Markdown editing view over `editor`'s draft. */
export function createEditorView({ parent, editor, label = 'Note', extensions = [] }: { parent: HTMLElement; editor: Editor; label?: string; extensions?: Extension[] }) {
	return new EditorView({
		parent,
		state: EditorState.create({
			doc: editor.draft(),
			extensions: [
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap]),
				markdown({ base: markdownLanguage }),
				EditorView.lineWrapping,
				EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
				editorBinding(editor),
				...extensions,
			],
		}),
	});
}
