/**
 * One CodeMirror view of a note's body, over the note's repository editor
 * (`openEditor`): the Markdown text itself, with live preview, conflict
 * cards and undo history. The editor owns the draft, the note's exact text;
 * this view shows its body and types through it (`editorBinding`), so a
 * change from elsewhere arrives in place, the cursor stays where the person
 * was typing, and Undo takes back only their own keystrokes. It knows
 * nothing of Honeycrisp's UI; `NoteEditor.svelte` mounts it.
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { bodyOf, type Editor } from '@epicenter/repository';
import { editorBinding } from '@epicenter/svelte/repository';
import { conflictCards } from './conflicts.js';
import { livePreview } from './live-preview.js';

export type NoteEditorOptions = {
	parent: HTMLElement;
	/** The note's editor, which this view shows the body of. */
	editor: Editor;
	/** The view's accessible name. */
	label?: string;
};

export function createNoteEditor({ parent, editor, label = 'Note text' }: NoteEditorOptions) {
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: bodyOf(editor.draft()),
			extensions: [
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap]),
				markdown({ base: markdownLanguage, addKeymap: true }),
				livePreview,
				conflictCards,
				EditorView.lineWrapping,
				EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'true' }),
				editorBinding(editor, { shows: 'body' }),
			],
		}),
	});
	return {
		view,
		focus: () => view.focus(),
		destroy: () => view.destroy(),
	};
}
export type NoteEditor = ReturnType<typeof createNoteEditor>;
