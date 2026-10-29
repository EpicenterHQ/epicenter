/**
 * CodeMirror 6 bound to a repository editor (`openEditor`). The editor
 * holds the note's exact text; a view shows all of it (`source`) or its
 * body (`body`), and both kinds can be open on one note at once. Each
 * local change hands the editor the new exact text; the editor saves it.
 * When the draft changes from outside this view (typing carried onto the
 * worker's merged text, a change from elsewhere followed, or typing in
 * another view of the note), its changes are applied in place, marked
 * `Transaction.remote` and kept out of the undo history: CodeMirror maps
 * the selection and the history through them, so the cursor stays where
 * the person was typing and Undo takes back only their own keystrokes.
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, type Extension, Transaction } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin } from '@codemirror/view';
import { bodyChanges, bodyOf, type Editor, withBody } from '@epicenter/repository/api';

/** What a view shows of the note: its exact text, or its body under the frontmatter. */
export type Shows = 'source' | 'body';

/** What a view of `shows` shows of the exact text `text`. */
const shown = (text: string, shows: Shows) => (shows === 'body' ? bodyOf(text) : text);

/** Keep a view and an editor's draft one text. */
export function editorBinding(editor: Editor, { shows = 'source' }: { shows?: Shows } = {}): Extension {
	/** The exact text this view shows, as it last showed it. */
	let over = editor.draft();
	return [
		EditorView.updateListener.of((update) => {
			if (!update.docChanged) return;
			if (update.transactions.every((transaction) => !transaction.docChanged || transaction.annotation(Transaction.remote))) return;
			const doc = update.state.doc.toString();
			over = shows === 'body' ? withBody(editor.draft(), doc) : doc;
			editor.update(over);
		}),
		ViewPlugin.define((view) => {
			const stop = editor.subscribe(({ replaced, typed }) => {
				const made = replaced ?? typed;
				// What this view typed itself is already in it.
				if (made === null || editor.draft() === over) return;
				const before = over;
				over = editor.draft();
				const changes = shows === 'body' ? bodyChanges(before, over, made) : made;
				if (changes.length === 0) return;
				view.dispatch({ changes, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] });
			});
			return { destroy: stop };
		}),
	];
}

/** A Markdown editing view over `editor`'s draft: the exact text, or the body. */
export function createEditorView({
	parent,
	editor,
	shows = 'source',
	label = 'Note',
	extensions = [],
}: {
	parent: HTMLElement;
	editor: Editor;
	shows?: Shows;
	label?: string;
	extensions?: Extension[];
}) {
	return new EditorView({
		parent,
		state: EditorState.create({
			doc: shown(editor.draft(), shows),
			extensions: [
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap]),
				markdown({ base: markdownLanguage }),
				EditorView.lineWrapping,
				EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
				editorBinding(editor, { shows }),
				...extensions,
			],
		}),
	});
}
