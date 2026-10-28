/**
 * One CodeMirror editor over a note's body: the Markdown text itself, with
 * live preview, conflict cards, undo history, and the binding that writes
 * local changes and shows changes from elsewhere. It knows nothing of
 * Honeycrisp's UI; `NoteEditor.svelte` mounts it.
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { applyExternal, lineBreakOf, noteBinding } from './binding.js';
import { conflictCards } from './conflicts.js';
import { livePreview } from './live-preview.js';

export type NoteEditorOptions = {
	parent: HTMLElement;
	/** The body as the note holds it now. */
	body: string;
	/** Called with the whole body after every local change. */
	onEdit: (body: string) => void;
	/** The editor's accessible name. */
	label?: string;
};

export function createNoteEditor({ parent, body, onEdit, label = 'Note text' }: NoteEditorOptions) {
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: body,
			extensions: [
				// Split only on the body's own line break, so the text is written back as it was.
				EditorState.lineSeparator.of(lineBreakOf(body)),
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap]),
				markdown({ base: markdownLanguage, addKeymap: true }),
				livePreview,
				conflictCards,
				EditorView.lineWrapping,
				EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'true' }),
				noteBinding(onEdit),
			],
		}),
	});
	return {
		view,
		/** Show the body as it now reads after a change from elsewhere. */
		follow: (next: string) => applyExternal(view, next),
		focus: () => view.focus(),
		destroy: () => view.destroy(),
	};
}
export type NoteEditor = ReturnType<typeof createNoteEditor>;
