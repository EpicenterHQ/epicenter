/**
 * The capture view's form for one capture: the input not committed yet, and
 * the commands that turn a change of text or thoughts into a new body.
 *
 * A capture's body is a document, so the form types it through the folder's
 * edit of the row (`createRowEdit(folder.tables.captures, stem)`): the folder
 * holds the capture as stored and the body typed over it, so reading the
 * folder again never replaces the typing, and each save starts from the
 * body the form typed over, which the folder merges with whatever was saved
 * since. A thought added, edited, deleted, or moved saves at once; the
 * capture text saves a second after the last keystroke, or when the person
 * leaves it (`flush`). Saves run one at a time; text typed while one runs
 * goes in the next. A failed save keeps the edit and its error.
 *
 * Every view of the capture shows the one edit, so the commands compose and
 * encode over the body it shows now. A positional command also compares the
 * list a view showed with that body, so a thought deleted, moved, or changed
 * since, here or in another tab, refuses the command.
 *
 * A change the body cannot hold exactly is refused with the reason, and
 * nothing changes.
 *
 * A new thought and a thought being edited are typed here until they are
 * added or saved; they are `$state`, kept while the person moves between
 * captures, and shared by every view of the capture. Thoughts are selected
 * by position, so a command names the list it was shown and is refused when
 * the list changed since; a thought edit remembers the thought it started
 * from and is refused, with its text kept, when that thought changed.
 */
import {
	type CaptureBody,
	type CaptureRow,
	captureBody,
	type captureTables,
} from '@epicenter/capture';
import { createRowEdit } from '@epicenter/svelte/edits';

/** A capture file that reads as a capture's frontmatter. */
export type StoredCapture = Extract<CaptureRow, { issues: null }>;

/** The folder's edit of one capture, read reactively. */
export type CaptureEdit = ReturnType<
	typeof createRowEdit<(typeof captureTables)['captures']>
>;

/** One edit of a thought, from Edit until it is saved or cancelled. */
export type ThoughtEdit = {
	readonly index: number;
	/** The thought as it was when the edit started. */
	readonly original: string;
	readonly text: string;
	/** This edit's identity: a later edit, of the same thought or another, has its own. */
	readonly id: object;
};

export type CaptureForm = ReturnType<typeof createCaptureForm>;

/** Why a command on a position did nothing: the thoughts changed under it. */
const CHANGED =
	'The thoughts changed since they were shown, so nothing was changed.';

const sameList = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((item, index) => item === b[index]);

/** `body` as text and thoughts, if it reads as them. */
function parse(body: string | undefined) {
	if (body === undefined) return undefined;
	const { data } = captureBody.decode(body);
	return data === null ? undefined : { body, ...data };
}

/** The form of the capture `edit` edits. */
export function createCaptureForm(rowEdit: CaptureEdit) {
	let newThought = $state('');
	let editing = $state.raw<ThoughtEdit | undefined>();
	/** Why the last change was not taken; the next change clears it. */
	let refusal = $state<string | undefined>();

	/** Whether input is refused now: the folder closes, or the capture is deleted. */
	const locked = () => rowEdit.locked;
	/** The body this command composes over: the capture as it reads now. */
	const shown = () => {
		const row = rowEdit.row;
		return row?.issues === null ? parse(row.body) : undefined;
	};

	/**
	 * Encode `value` over the body `over` and type it; it saves at once
	 * unless `later`, when it saves after a pause. Answers whether the change
	 * was taken.
	 */
	function write(
		over: NonNullable<ReturnType<typeof shown>>,
		value: CaptureBody,
		{ later = false } = {},
	): boolean {
		const { data: body, error } = captureBody.encode(value, over.body);
		if (error !== null) {
			refusal = error.message;
			return false;
		}
		refusal = undefined;
		if (body === over.body) return true;
		const changed = rowEdit.change({ body });
		if (changed.error !== null) {
			refusal = changed.error.message;
			return false;
		}
		if (!later) void rowEdit.save();
		return true;
	}

	/** The body now, when `list` is its thoughts: a position in it names the same thought. */
	function current(list: readonly string[]) {
		const now = shown();
		return now !== undefined && sameList(list, now.thoughts) ? now : undefined;
	}

	return {
		/** The folder's edit of the capture, which every view shows. */
		rowEdit,
		/** The edited body, until its saves land; `undefined` with no rowEdit. */
		get body() {
			return rowEdit.pending === undefined ? undefined : shown()?.body;
		},
		/** Whether a save of the edit is running. */
		get saving() {
			return rowEdit.pending?.saving ?? false;
		},
		/** Why the edit's last save failed, while it is held. */
		get error() {
			return rowEdit.pending?.error;
		},
		/** Save what is typed; resolves once no save of it runs. */
		flush: () => rowEdit.save(),
		get refusal() {
			return refusal;
		},
		/** Typed here and not in the file: a new thought, or a changed thought rowEdit. */
		get unsent() {
			return (
				newThought !== '' ||
				(editing !== undefined && editing.text !== editing.original)
			);
		},
		get newThought() {
			return newThought;
		},
		get editing() {
			return editing;
		},
		/**
		 * Replace the capture text; it saves after a pause in typing
		 * (`flush`). A refused change leaves the text in the file.
		 */
		inputText(value: string) {
			const now = shown();
			if (locked() || now === undefined) return;
			write(now, { text: value, thoughts: now.thoughts }, { later: true });
		},
		inputNewThought(value: string) {
			if (!locked()) newThought = value;
		},
		/** Add the new thought after the last one. The text stays if refused. */
		addThought(): boolean {
			if (locked()) return false;
			if (newThought.trim() === '') {
				refusal = 'Write something first.';
				return false;
			}
			const now = shown();
			if (now === undefined) return false;
			if (
				!write(now, {
					text: now.text,
					thoughts: [...now.thoughts, newThought],
				})
			)
				return false;
			newThought = '';
			return true;
		},
		/** Begin editing the thought at `index` of the list `list` a view showed. */
		startEditing(index: number, list: readonly string[]) {
			if (locked() || current(list) === undefined) return;
			const original = list[index];
			if (original === undefined) return;
			editing = { index, original, text: original, id: {} };
			refusal = undefined;
		},
		/** Type into the edit `id`; refused unless that is the edit open now. */
		inputEditing(text: string, id: object) {
			if (locked() || editing?.id !== id) return;
			editing = { ...editing, text };
		},
		/**
		 * Save the edit `id`. Refused, with its text kept, when the thought it
		 * started from is no longer at its position.
		 */
		commitEditing(id: object): boolean {
			if (locked() || editing?.id !== id) return false;
			const { index, original, text: edited } = editing;
			const now = shown();
			if (now === undefined || now.thoughts[index] !== original) {
				refusal = `${CHANGED} Your edit is kept here; copy it, then cancel.`;
				return false;
			}
			if (edited.trim() === '') {
				refusal = 'A thought needs text. Delete it instead.';
				return false;
			}
			if (
				!write(now, {
					text: now.text,
					thoughts: now.thoughts.map((thought, at) =>
						at === index ? edited : thought,
					),
				})
			)
				return false;
			editing = undefined;
			return true;
		},
		cancelEditing(id: object) {
			if (editing?.id !== id) return;
			editing = undefined;
			refusal = undefined;
		},
		/** Delete the thought at `index` of the list `list` a view showed. */
		deleteThought(index: number, list: readonly string[]): boolean {
			if (locked()) return false;
			const now = current(list);
			if (now === undefined || list[index] === undefined) {
				refusal = CHANGED;
				return false;
			}
			return write(now, {
				text: now.text,
				thoughts: list.filter((_, at) => at !== index),
			});
		},
		/** Swap two neighbouring thoughts of the list `list` a view showed. */
		swapThoughts(from: number, to: number, list: readonly string[]): boolean {
			if (locked()) return false;
			const now = current(list);
			const next = [...list];
			const first = next[from];
			const second = next[to];
			if (
				now === undefined ||
				Math.abs(from - to) !== 1 ||
				first === undefined ||
				second === undefined
			) {
				refusal = CHANGED;
				return false;
			}
			next[from] = second;
			next[to] = first;
			return write(now, { text: now.text, thoughts: next });
		},
	};
}
