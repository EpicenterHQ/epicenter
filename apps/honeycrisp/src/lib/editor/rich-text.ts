/**
 * The rich-text view's editing: its commands and plugins, and the two rules
 * that keep its ProseMirror state the note's body.
 *
 * The note's body edit holds text ahead of disk, with line feeds for
 * presentation. The view's `EditorState` adds cursor, pending formatting,
 * undo history, and an empty paragraph Markdown cannot spell yet. The body
 * is compared by content:
 *
 * - `stateAfter` decides every transaction before it is shown. One that
 *   changes the document is checked against the body shown now, then its
 *   Markdown goes into the note's edit in the same step, which saves it.
 *   If the Markdown would not open as the same document, the screen does not
 *   change. Accepted Markdown enters the note's edit before it is shown.
 * - `stateShowing` follows the body. The same content keeps the state, so a
 *   body this view wrote or a save landing changes nothing on screen.
 *   Different content from Source or another tab starts a new state and undo
 *   history. A pending edit hides an outside body until its save answers;
 *   a failed save keeps the typed body visible for retry or discard.
 *
 * Neither needs a DOM. The view calls both; tests drive them the same way.
 */

import {
	baseKeymap,
	chainCommands,
	exitCode,
	lift,
	toggleMark,
	wrapIn,
} from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import {
	ellipsis,
	inputRules,
	smartQuotes,
	textblockTypeInputRule,
	wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { Node, NodeType } from 'prosemirror-model';
import {
	liftListItem,
	sinkListItem,
	splitListItem,
} from 'prosemirror-schema-list';
import {
	type Command,
	EditorState,
	type Plugin,
	type Transaction,
} from 'prosemirror-state';
import type { NoteRow } from '../data.js';
import { bodyCodec, equivalentNoteDocs } from './markdown.js';
import { noteSchema } from './schema.js';

export function nodeActive(
	state: EditorState,
	type: NodeType,
	attrs?: Record<string, unknown>,
): boolean {
	const { $from: start } = state.selection;
	for (let depth = start.depth; depth >= 0; depth -= 1) {
		const node = start.node(depth);
		if (node.type !== type) continue;
		if (!attrs) return true;
		if (
			Object.entries(attrs).every(([key, value]) => node.attrs[key] === value)
		)
			return true;
	}
	return false;
}

export const toggleQuote: Command = (state, dispatch) =>
	nodeActive(state, noteSchema.nodes.blockquote)
		? lift(state, dispatch)
		: wrapIn(noteSchema.nodes.blockquote)(state, dispatch);

const hardBreak: Command = chainCommands(exitCode, (state, dispatch) => {
	dispatch?.(
		state.tr
			.replaceSelectionWith(noteSchema.nodes.hard_break.create())
			.scrollIntoView(),
	);
	return true;
});

/**
 * Editing behavior that needs no DOM: history, keys, and typing shortcuts.
 * Each call makes new plugins; a state built from them starts its own history.
 */
export function editingPlugins(): Plugin[] {
	return [
		history(),
		keymap({
			'Mod-z': undo,
			'Mod-y': redo,
			'Mod-Shift-z': redo,
			'Mod-b': toggleMark(noteSchema.marks.strong),
			'Mod-i': toggleMark(noteSchema.marks.em),
			'Mod-Shift-s': toggleMark(noteSchema.marks.strike),
			'Mod-e': toggleMark(noteSchema.marks.code),
			'Mod-Shift-b': toggleQuote,
			'Shift-Enter': hardBreak,
			// SAFETY: the base keymap defines Enter as a ProseMirror command.
			Enter: chainCommands(
				splitListItem(noteSchema.nodes.taskItem),
				splitListItem(noteSchema.nodes.list_item),
				baseKeymap.Enter as Command,
			),
			Tab: (state, dispatch) =>
				sinkListItem(noteSchema.nodes.taskItem)(state, dispatch) ||
				sinkListItem(noteSchema.nodes.list_item)(state, dispatch),
			'Shift-Tab': (state, dispatch) =>
				liftListItem(noteSchema.nodes.taskItem)(state, dispatch) ||
				liftListItem(noteSchema.nodes.list_item)(state, dispatch),
		}),
		keymap(baseKeymap),
		inputRules({
			rules: [
				...smartQuotes,
				ellipsis,
				textblockTypeInputRule(
					/^(#{1,3})\s$/,
					noteSchema.nodes.heading,
					(match) => ({
						// SAFETY: the matched heading pattern always captures its hash prefix.
						level: (match[1] as string).length,
					}),
				),
				wrappingInputRule(/^\s*\[([ xX]?)\]\s$/, noteSchema.nodes.taskList),
				wrappingInputRule(/^\s*([-+*])\s$/, noteSchema.nodes.bullet_list),
				wrappingInputRule(
					/^(\d+)\.\s$/,
					noteSchema.nodes.ordered_list,
					(match) => ({ order: Number(match[1]) }),
					(match, node) =>
						node.childCount + node.attrs.order === Number(match[1]),
				),
				wrappingInputRule(/^\s*>\s$/, noteSchema.nodes.blockquote),
				textblockTypeInputRule(/^```$/, noteSchema.nodes.code_block),
			],
		}),
	];
}

/**
 * The state that shows `doc`, the note's body as a document. That is `state`
 * itself while its document holds the same content, so its cursor, pending
 * formatting, and undo history stay. Otherwise it is a new state over `doc`
 * with the same plugins: a new undo history, with the cursor at the start.
 */
export function stateShowing(state: EditorState, doc: Node): EditorState {
	if (equivalentNoteDocs(doc, state.doc)) return state;
	return EditorState.create({ doc, plugins: state.plugins });
}

/** The valid note's body shown by Honeycrisp, with line feeds and no source mutation. */
export function noteBody(row: NoteRow | undefined): string | undefined {
	return row?.issues === null ? row.body.replace(/\r\n?/g, '\n') : undefined;
}

/** The body edit an editor shows and writes. */
export type NoteBody = {
	read(): string | undefined;
	write(body: string): void;
};

/**
 * The state to show after `transaction`, or undefined when the screen stays
 * as it is.
 *
 * A transaction built on a document `state` no longer has is dropped: its
 * steps describe text that was replaced. A changed document meets the body
 * shown now: if the body is undefined, there is nothing to edit. A
 * body that changed since `state` showed it is shown instead and the
 * transaction is dropped, and a body that is no longer rich text takes
 * nothing. Markdown that cannot spell the new document is refused with its
 * reason through `refuse`. Otherwise the new body goes into the note's
 * edit, which saves it. A lone surrogate
 * becomes U+FFFD within the same transaction, as the file will store it, so
 * the screen and the undo history never show what the file does not hold.
 */
export function stateAfter(
	state: EditorState,
	transaction: Transaction,
	note: NoteBody,
	refuse: (reason: string) => void,
): EditorState | undefined {
	if (transaction.before !== state.doc) return undefined;
	// A selection or pending formatting writes nothing: opening a note never
	// changes its file.
	if (!transaction.docChanged) return state.apply(transaction);
	const body = note.read();
	if (body === undefined) return undefined;
	const current = bodyCodec.decode(body);
	if (!current.supported) return undefined;
	const shown = stateShowing(state, current.doc);
	if (shown !== state) return shown;
	// The file stores a lone surrogate as U+FFFD (ADR-0572). The same
	// transaction replaces it now, so the screen, the edit, and the undo
	// history agree, and the save landing does not restart the state.
	repairLoneSurrogates(transaction);
	const next = state.apply(transaction);
	const { data: encoded, error } = bodyCodec.encode(next.doc, body);
	if (error !== null) {
		refuse(error);
		return undefined;
	}
	// An edit Markdown has no spelling for (a new empty paragraph) gives the
	// same body back: it is shown, and nothing saves.
	if (encoded === body) return next;
	note.write(encoded);
	return next;
}

const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replace each lone surrogate in the document `transaction` makes with U+FFFD, as more steps of it. */
function repairLoneSurrogates(transaction: Transaction) {
	const found: number[] = [];
	transaction.doc.descendants((node, pos) => {
		if (!node.isText || node.text === undefined) return;
		for (const match of node.text.matchAll(LONE_SURROGATE))
			found.push(pos + match.index);
	});
	// Last first, so earlier positions stay where they were found.
	for (const at of found.reverse())
		transaction.insertText('\uFFFD', at, at + 1);
}
