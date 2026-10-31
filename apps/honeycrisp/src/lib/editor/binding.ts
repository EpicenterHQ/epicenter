/**
 * CodeMirror bound to a note's body. A local change hands the whole body to
 * `onEdit`, which saves it (`fieldEdit(notes, { id }, 'body')`); the note
 * then holds exactly what the text reads, so every edit changes only the
 * characters typed. A change from elsewhere is applied as the smallest text
 * changes, marked `Transaction.remote` so it skips `onEdit` and kept out of
 * the undo history; CodeMirror maps the selection and the history through
 * it, so the cursor stays where it was and Undo never takes back someone
 * else's text.
 */
import { diff } from '@codemirror/merge';
import {
	type ChangeSpec,
	type EditorState,
	type Extension,
	Transaction,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** The line break a body uses, so the editor writes it back unchanged. */
export const lineBreakOf = (body: string) =>
	body.includes('\r\n') ? '\r\n' : '\n';

/** Write every local change of the document; ignore the ones `applyExternal` made. */
export function noteBinding(onEdit: (body: string) => void): Extension {
	return EditorView.updateListener.of((update) => {
		if (!update.docChanged) return;
		if (
			update.transactions.every(
				(transaction) =>
					!transaction.docChanged || transaction.annotation(Transaction.remote),
			)
		)
			return;
		// `sliceDoc` spells line breaks as the body does; `doc.toString()` always uses `\n`.
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
	view.dispatch({
		changes,
		annotations: [
			Transaction.remote.of(true),
			Transaction.addToHistory.of(false),
		],
	});
	return true;
}
