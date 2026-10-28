/**
 * CodeMirror 6 bound to a repository text. A local change hands the whole
 * text to `onEdit`, which writes it through an open note or file; the
 * repository stores exactly what the text now reads, so every edit changes
 * only the characters typed. A change from elsewhere is applied as the
 * smallest text changes, marked `Transaction.remote` so it skips `onEdit`
 * and kept out of the undo history; CodeMirror maps the selection and the
 * history through it, so the cursor stays where it was and Undo never takes
 * back someone else's text.
 *
 * `createSourceEditor` is the whole-file editor `<SourceEditor>` mounts;
 * an app with its own editor (Honeycrisp's note body) uses the binding alone.
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { diff } from '@codemirror/merge';
import { type ChangeSpec, EditorState, type Extension, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import type { OpenFile, Saved } from '@epicenter/repository';
import { merge } from '@epicenter/repository/merge';

/** The line break a text uses, so the editor writes it back unchanged. */
export const lineBreakOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');

/** Write every local change of the document; ignore the ones `applyExternal` made. */
export function textBinding(onEdit: (text: string) => void): Extension {
	return EditorView.updateListener.of((update) => {
		if (!update.docChanged) return;
		if (update.transactions.every((transaction) => !transaction.docChanged || transaction.annotation(Transaction.remote))) return;
		// `sliceDoc` spells line breaks as the text does; `doc.toString()` always uses `\n`.
		onEdit(update.state.sliceDoc());
	});
}

/**
 * The changes that turn the document into `next`, in document positions,
 * where a line break counts once whatever it is spelled as.
 */
export function changesTo(state: EditorState, next: string): ChangeSpec[] {
	const separator = state.lineBreak;
	const current = state.doc.sliceString(0, state.doc.length, '\n');
	const target = separator === '\n' ? next : next.split(separator).join('\n');
	if (current === target) return [];
	return diff(current, target).map(({ fromA, toA, fromB, toB }) => ({
		from: fromA,
		to: toA,
		insert: target.slice(fromB, toB).split('\n').join(separator),
	}));
}

/** Show `next`, which arrived from elsewhere, as the smallest changes. Returns whether anything changed. */
export function applyExternal(view: EditorView, next: string) {
	const changes = changesTo(view.state, next);
	if (changes.length === 0) return false;
	view.dispatch({ changes, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] });
	return true;
}

export type SourceEditorOptions = {
	parent: HTMLElement;
	/** The file held open; the editor writes through it and follows it. */
	file: OpenFile;
	/** Called with the text the editor shows after every change, local or not, and after the file's sync state changes. */
	onText: (text: string) => void;
	/** Called with each save, so its owner can report one that failed. */
	onSave?: (saved: Saved) => void;
	/** The editor's accessible name. */
	label?: string;
};

/**
 * A file's whole text, frontmatter included, in CodeMirror. Every change is
 * saved through the open file as it is typed. One that would turn
 * frontmatter that parses into frontmatter that does not is saved on this
 * device and held there, not sent, until it parses again; the repository
 * keeps it through changes from elsewhere, and the file's sync state says
 * so. A file that does not parse saves every step of its repair.
 *
 * A save the repository refuses, for its size, its bytes or its path,
 * leaves its text in the editor, unsent until it changes; a change from
 * elsewhere merges under it, the editor's text winning an overlap.
 */
export function createSourceEditor({ parent, file, onText, onSave, label = 'File source' }: SourceEditorOptions) {
	/** The file's text as the editor last read or saved it. */
	let stored = file.read()?.text ?? '';
	/** While a write is made, its own echo arrives; the editor already shows it. */
	let writing = false;
	/** A text whose save failed: it stays in the editor and is not sent again until it changes. */
	let refused: string | null = null;

	function save(text: string) {
		if (text === stored || text === refused) return;
		const before = stored;
		stored = text;
		writing = true;
		try {
			const saved = file.writeText(text);
			onSave?.(saved);
			// The file then shows its stored text again; with `stored` back, that merges under the text kept here.
			void saved.then(({ error }) => {
				if (error === null) return;
				refused = text;
				if (stored === text) stored = before;
			});
		} finally {
			writing = false;
		}
	}

	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: stored,
			extensions: [
				// Split only on the text's own line break, so it is written back as it was.
				EditorState.lineSeparator.of(lineBreakOf(stored)),
				lineNumbers(),
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap]),
				markdown({ base: markdownLanguage }),
				EditorView.lineWrapping,
				EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
				textBinding((text) => {
					save(text);
					onText(text);
				}),
			],
		}),
	});

	const stop = file.subscribe((next) => {
		// A deleted file keeps its last text here; the editor's owner decides what to show.
		if (writing || next === null) return;
		const shown = view.state.sliceDoc();
		const text = shown === stored ? next.text : (merge(stored, shown, next.text).text ?? shown);
		stored = next.text;
		applyExternal(view, text);
		save(text);
		onText(text);
	});
	onText(stored);

	return {
		view,
		focus: () => view.focus(),
		destroy() {
			stop();
			view.destroy();
		},
	};
}
export type SourceEditor = ReturnType<typeof createSourceEditor>;
