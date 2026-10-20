/**
 * The capture view's form for one capture: the input not committed yet, and
 * the commands that turn a change of text or thoughts into a new body.
 *
 * A capture's body is a document, so the form types it through the row's
 * edit handle (`folder.tables.captures.edit(stem)`): the folder holds the
 * body typed, outside the cache, so reading the folder again never replaces
 * it, and each save starts from the body the form typed over, which the
 * folder merges with whatever was saved since.
 * A thought added, edited, deleted, or moved saves at once; the capture
 * text saves a second after the last keystroke, or when the person leaves
 * it (`flush`). Saves run one at a time; text typed while one runs goes in
 * the next. A failed save keeps the edit and its error.
 *
 * Commands belong to one view (`form.in(view)`, over that view's binding).
 * They compose and encode over `view.row`, the current projected body. A
 * positional command also compares its supplied list with the current body,
 * so a thought deleted, moved, or changed since refuses the command.
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
import type { RowEdit } from '@epicenter/folder/edits';
import { createRowEdit } from '@epicenter/svelte/edits';

/** A capture file that reads as a capture's frontmatter. */
export type StoredCapture = Extract<CaptureRow, { issues: null }>;

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
/** The form as one view gives it (`form.in(view)`): its state and commands. */
export type CaptureCommands = ReturnType<CaptureForm['in']>;

/** Why a command on a position did nothing: the thoughts changed under it. */
const CHANGED =
	'The thoughts changed since they were shown, so nothing was changed.';

const sameList = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((item, index) => item === b[index]);

/** A view's binding of the capture's edit, over the row that view shows. */
export type CaptureView = ReturnType<
	typeof createRowEdit<
		(typeof captureTables)['captures'],
		StoredCapture | undefined
	>
>;

/** `body` as text and thoughts, if it reads as them. */
function parse(body: string | undefined) {
	if (body === undefined) return undefined;
	const { data } = captureBody.decode(body);
	return data === null ? undefined : { body, ...data };
}

export function createCaptureForm(capture: {
	/** The capture as the cache holds it now, if it reads as one. */
	row(): StoredCapture | undefined;
	/** The capture's edit handle (`folder.tables.captures.edit(stem)`). */
	edit: RowEdit<(typeof captureTables)['captures']>;
}) {
	let newThought = $state('');
	let editing = $state.raw<ThoughtEdit | undefined>();
	/** Why the last change was not taken; the next change clears it. */
	let refusal = $state<string | undefined>();
	/** The held input, read reactively; it types nothing. */
	const held = createRowEdit(capture.edit, () => undefined);

	/** The body now: the cache's row with held input and own saves over it. */
	function now() {
		const row = capture.row();
		return row === undefined
			? undefined
			: parse(capture.edit.shown(row).row.body);
	}

	/** What every view of the capture shares. */
	const state = {
		/** The edited body, until its saves land; `undefined` with no edit. */
		get body() {
			return held.pending?.body;
		},
		/** Whether a save of the edit is running. */
		get saving() {
			return held.pending?.saving ?? false;
		},
		/** Why the edit's last save failed, while it is held. */
		get error() {
			return held.pending?.error;
		},
		/** Save what is typed; resolves once no save of it runs. */
		flush: () => capture.edit.save(),
		get refusal() {
			return refusal;
		},
		/** Typed here and not in the file: a new thought, or a changed thought edit. */
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
	};

	/** The form's commands in the view bound by `view`. */
	function commands(view: CaptureView) {
		/** Whether input is refused now: the folder closes, or the capture is deleted. */
		const locked = () => view.locked;
		/** The current projected body this command composes over. */
		const readView = () => parse(view.row?.body);

		/**
		 * Encode `value` over this projected body and type it; it saves
		 * at once unless `later`, when it saves after a pause. Answers whether
		 * the change was taken.
		 */
		function write(
			shown: NonNullable<ReturnType<typeof readView>>,
			value: CaptureBody,
			{ later = false } = {},
		): boolean {
			const { data: body, error } = captureBody.encode(value, shown.body);
			if (error !== null) {
				refusal = error.message;
				return false;
			}
			refusal = undefined;
			if (body === shown.body) return true;
			const changed = view.change({ body });
			if (changed.error !== null) {
				refusal = changed.error.message;
				return false;
			}
			if (!later) void view.save();
			return true;
		}

		/**
		 * The list `shown` is the one the view showed and the one now, so a
		 * position in it means the same thought in both.
		 */
		function current(shown: readonly string[]) {
			const showed = readView();
			const latest = now();
			return showed !== undefined &&
				latest !== undefined &&
				sameList(shown, showed.thoughts) &&
				sameList(shown, latest.thoughts)
				? showed
				: undefined;
		}

		const own = {
			/**
			 * Replace the capture text; the view saves it after a pause in typing
			 * (`flush`). A refused change leaves the text in the file.
			 */
			inputText(value: string) {
				const showed = readView();
				if (locked() || showed === undefined) return;
				write(
					showed,
					{ text: value, thoughts: showed.thoughts },
					{ later: true },
				);
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
				const showed = readView();
				if (showed === undefined) return false;
				if (
					!write(showed, {
						text: showed.text,
						thoughts: [...showed.thoughts, newThought],
					})
				)
					return false;
				newThought = '';
				return true;
			},
			/** Begin editing the thought at `index` of the list `shown`. */
			startEditing(index: number, shown: readonly string[]) {
				if (locked() || current(shown) === undefined) return;
				const original = shown[index];
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
			 * started from is no longer at its position, as shown or now.
			 */
			commitEditing(id: object): boolean {
				if (locked() || editing?.id !== id) return false;
				const { index, original, text: edited } = editing;
				const showed = readView();
				if (
					showed === undefined ||
					showed.thoughts[index] !== original ||
					now()?.thoughts[index] !== original
				) {
					refusal = `${CHANGED} Your edit is kept here; copy it, then cancel.`;
					return false;
				}
				if (edited.trim() === '') {
					refusal = 'A thought needs text. Delete it instead.';
					return false;
				}
				if (
					!write(showed, {
						text: showed.text,
						thoughts: showed.thoughts.map((thought, at) =>
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
			/** Delete the thought at `index` of the list `shown`. */
			deleteThought(index: number, shown: readonly string[]): boolean {
				if (locked()) return false;
				const showed = current(shown);
				if (showed === undefined || shown[index] === undefined) {
					refusal = CHANGED;
					return false;
				}
				return write(showed, {
					text: showed.text,
					thoughts: shown.filter((_, at) => at !== index),
				});
			},
			/** Swap two neighbouring thoughts of the list `shown`. */
			swapThoughts(
				from: number,
				to: number,
				shown: readonly string[],
			): boolean {
				if (locked()) return false;
				const showed = current(shown);
				const next = [...shown];
				const first = next[from];
				const second = next[to];
				if (
					showed === undefined ||
					Math.abs(from - to) !== 1 ||
					first === undefined ||
					second === undefined
				) {
					refusal = CHANGED;
					return false;
				}
				next[from] = second;
				next[to] = first;
				return write(showed, { text: showed.text, thoughts: next });
			},
		};
		return Object.defineProperties(
			own,
			Object.getOwnPropertyDescriptors(state),
		) as typeof own & typeof state;
	}

	return Object.defineProperties(
		{
			/**
			 * The form as one view gives it: each command composes and types
			 * over the current projection of `view`, that view's binding. The
			 * form's text, thought edit and refusal are the same for every view.
			 */
			in: commands,
		},
		Object.getOwnPropertyDescriptors(state),
	) as { in: typeof commands } & typeof state;
}
