/**
 * The rich-text view's editing: its commands and plugins, and the two rules
 * that keep its ProseMirror state the note's body.
 *
 * The note's body is the one `NoteBody.row` shows: the note's draft while an
 * edit is held, otherwise the row the query cache holds (ADR-0548). The
 * view's `EditorState` adds only what the note has no place for: the
 * cursor, pending formatting, undo history, and an empty paragraph Markdown
 * cannot spell yet. Its document is never a second draft. Nothing records
 * which body the state last read or wrote; the body is compared by content:
 *
 * - `stateAfter` decides every transaction before it is shown. One that
 *   changes the document is checked against the body shown now, then its
 *   Markdown goes into the note's draft in the same step, which saves it.
 *   If the Markdown would not open as the same document, or the note takes
 *   no edit, the screen does not change. There is never text on screen that
 *   the note does not hold.
 * - `stateShowing` follows the body. The same content keeps the state, so a
 *   body this view wrote, a save landing, or a respelling in Source changes
 *   nothing on screen. Different content (Source, a chosen version, the file
 *   read again after it changed elsewhere, or a save that merged a change
 *   made elsewhere) starts a new state and a new undo history, because the
 *   old history describes text that is gone. The draft holds the version
 *   its edit started from and a read never changes it, so typing in flight
 *   is never replaced.
 *
 * Neither needs a DOM. The view calls both; tests drive them the same way.
 */

import type { Row } from '@epicenter/folder';
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
import type { MarkType, Node, NodeType } from 'prosemirror-model';
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
import type { NoteFields } from '../data.js';
import { bodyCodec, equivalentNoteDocs } from './markdown.js';
import { noteSchema } from './schema.js';

export const marks = noteSchema.marks as unknown as Record<
	'strong' | 'em' | 'strike' | 'code' | 'link',
	MarkType
>;
export const nodes = noteSchema.nodes as unknown as Record<
	| 'paragraph'
	| 'heading'
	| 'blockquote'
	| 'code_block'
	| 'bullet_list'
	| 'ordered_list'
	| 'list_item'
	| 'taskList'
	| 'taskItem'
	| 'horizontal_rule'
	| 'hard_break',
	NodeType
>;

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
	nodeActive(state, nodes.blockquote)
		? lift(state, dispatch)
		: wrapIn(nodes.blockquote)(state, dispatch);

const hardBreak: Command = chainCommands(exitCode, (state, dispatch) => {
	dispatch?.(
		state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView(),
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
			'Mod-b': toggleMark(marks.strong),
			'Mod-i': toggleMark(marks.em),
			'Mod-Shift-s': toggleMark(marks.strike),
			'Mod-e': toggleMark(marks.code),
			'Mod-Shift-b': toggleQuote,
			'Shift-Enter': hardBreak,
			Enter: chainCommands(
				splitListItem(nodes.taskItem),
				splitListItem(nodes.list_item),
				baseKeymap.Enter as Command,
			),
			Tab: (state, dispatch) =>
				sinkListItem(nodes.taskItem)(state, dispatch) ||
				sinkListItem(nodes.list_item)(state, dispatch),
			'Shift-Tab': (state, dispatch) =>
				liftListItem(nodes.taskItem)(state, dispatch) ||
				liftListItem(nodes.list_item)(state, dispatch),
		}),
		keymap(baseKeymap),
		inputRules({
			rules: [
				...smartQuotes,
				ellipsis,
				textblockTypeInputRule(/^(#{1,3})\s$/, nodes.heading, (match) => ({
					level: (match[1] as string).length,
				})),
				wrappingInputRule(/^\s*\[([ xX]?)\]\s$/, nodes.taskList),
				wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
				wrappingInputRule(
					/^(\d+)\.\s$/,
					nodes.ordered_list,
					(match) => ({ order: Number(match[1]) }),
					(match, node) =>
						node.childCount + node.attrs.order === Number(match[1]),
				),
				wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
				textblockTypeInputRule(/^```$/, nodes.code_block),
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

/** What the rich-text view needs of one note. */
export type NoteBody = {
	/**
	 * The note as shown now: its draft while an edit is held, else as the
	 * cache holds it; `undefined` once it is gone.
	 */
	readonly row: Row<NoteFields> | undefined;
	/** Whether the note takes no edit now. */
	readonly locked: boolean;
	/** Type `body` as the note's body, which saves it. Answers whether it was taken. */
	edit(body: string): boolean;
};

/**
 * The state to show after `transaction`, or undefined when the screen stays
 * as it is.
 *
 * A transaction built on a document `state` no longer has is dropped: its
 * steps describe text that was replaced. One that changes the document is
 * refused while the note takes no edit. It then meets the body shown now: a
 * body that changed since `state` showed it is shown instead and the
 * transaction is dropped, and a body that is no longer rich text takes
 * nothing. Markdown that cannot spell the new document is refused with its
 * reason through `refuse`. Otherwise the new body goes into the note's
 * draft, which saves it; an edit the note refuses is not shown. A lone surrogate
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
	if (note.locked) return undefined;
	const row = note.row;
	if (row === undefined) return undefined;
	const { body } = row;
	const current = bodyCodec.decode(body);
	if (!current.supported) return undefined;
	const shown = stateShowing(state, current.doc);
	if (shown !== state) return shown;
	// The file stores a lone surrogate as U+FFFD (ADR-0570). The same
	// transaction replaces it now, so the screen, the draft, and the undo
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
	if (encoded !== body && !note.edit(encoded)) return undefined;
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
