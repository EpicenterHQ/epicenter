/**
 * The capture view's form for one capture: the edit not saved yet, the
 * input not committed yet, and the commands that turn a change of text or
 * thoughts into a new body.
 *
 * A capture's body is a document, so the form opens it with
 * `createBodyEditor` (ADR-0575): a body draft that holds the version it
 * started from and the body typed, outside the cache, so reading the folder
 * again never replaces it, and the folder merges each save by line with
 * whatever changed since that version.
 * A thought added, edited, deleted, or moved saves at once; the capture
 * text is saved by the view after a pause in typing, or when the person
 * leaves it (`flush`). Saves run one at a time; text typed while one runs
 * goes in the next. A failed save keeps the draft.
 *
 * Every structured change reads the body the form shows now (the typed
 * body, or the cache's), composes the complete `{ text, thoughts }`, encodes it
 * over that body (`captureBody.encode`), and puts it in the draft. A change
 * the body cannot hold exactly is refused with the reason, and nothing
 * changes.
 *
 * A new thought and a thought being edited are typed here until they are
 * added or saved; they are `$state`, kept while the person moves between
 * captures. Thoughts are selected by position, so a command names the list
 * it was shown and is refused when the list changed since; a thought edit
 * remembers the thought it started from and is refused, with its text kept,
 * when that thought changed.
 */
import {
	type CaptureBody,
	type CaptureFields,
	captureBody,
} from '@epicenter/capture';
import type { SavedRow, StoredRow } from '@epicenter/folder';
import { createBodyEditor } from '@epicenter/folder/svelte';

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

export function createCaptureForm(capture: {
	/** The capture as the cache holds it now, if it reads as a row. */
	row(): StoredRow<CaptureFields> | undefined;
	/**
	 * Replace the body of the row the edit started from (`base`) with
	 * `text`: the table's `setBody` mutation, rejecting on failure.
	 */
	save(variables: {
		readonly base: StoredRow<CaptureFields>;
		readonly text: string;
	}): Promise<SavedRow<CaptureFields>>;
	/** A save landed, with the save that restores what it replaced. */
	onSaved(saved: SavedRow<CaptureFields>, restore: () => void): void;
	/** Whether input is refused now: closing, or deleting. */
	locked(): boolean;
}) {
	const draft = createBodyEditor<CaptureFields>({
		row: capture.row,
		save: capture.save,
		onSaved: capture.onSaved,
	});
	let newThought = $state('');
	let editing = $state.raw<ThoughtEdit | undefined>();
	/** Why the last change was not taken; the next change clears it. */
	let refusal = $state<string | undefined>();

	/** The body the form shows: the typed body, or the cache's. */
	const shown = () => draft.text;

	/**
	 * Put `body` in the draft, and save it unless `later`, when the view
	 * saves it after a pause; answers whether the change was taken.
	 */
	function edit(body: string, { later = false } = {}): boolean {
		if (capture.locked() || capture.row() === undefined) return false;
		draft.change(body);
		if (!later) void draft.save();
		return true;
	}

	/** The body now as text and thoughts, if it reads as them. */
	function current() {
		const body = shown();
		if (body === undefined) return undefined;
		const { data } = captureBody.decode(body);
		return data === null ? undefined : { body, ...data };
	}

	/** Encode a complete value over the body now and put it in the draft. */
	function write(value: CaptureBody, options?: { later?: boolean }): boolean {
		if (capture.locked()) return false;
		const now = current();
		if (now === undefined) return false;
		const { data: body, error } = captureBody.encode(value, now.body);
		if (error !== null) {
			refusal = error.message;
			return false;
		}
		refusal = undefined;
		return body === now.body || edit(body, options);
	}

	return {
		/** The edited body, until its saves land; `undefined` with no edit. */
		get body() {
			return draft.typed;
		},
		/** Whether a save of the edit is running. */
		get saving() {
			return draft.saving;
		},
		/** Save what the draft holds; resolves once no save of it runs. */
		flush: () => draft.save(),
		/** Drop the edit, as when its file is gone. */
		discard: () => draft.discard(),
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

		/**
		 * Replace the capture text; the view saves it after a pause in typing
		 * (`flush`). A refused change leaves the text in the file.
		 */
		inputText(value: string) {
			const now = current();
			if (now === undefined) return;
			write(
				{ text: value, thoughts: now.thoughts },
				{ later: true },
			);
		},

		get newThought() {
			return newThought;
		},
		inputNewThought(value: string) {
			if (!capture.locked()) newThought = value;
		},
		/** Add the new thought after the last one. The text stays if refused. */
		addThought(): boolean {
			if (capture.locked()) return false;
			if (newThought.trim() === '') {
				refusal = 'Write something first.';
				return false;
			}
			const now = current();
			if (now === undefined) return false;
			if (
				!write({
					text: now.text,
					thoughts: [...now.thoughts, newThought],
				})
			)
				return false;
			newThought = '';
			return true;
		},

		get editing() {
			return editing;
		},
		/** Begin editing the thought at `index` of the list `shown`. */
		startEditing(index: number, shown: readonly string[]) {
			const now = current();
			if (
				capture.locked() ||
				now === undefined ||
				!sameList(shown, now.thoughts)
			)
				return;
			const original = shown[index];
			if (original === undefined) return;
			editing = { index, original, text: original, id: {} };
			refusal = undefined;
		},
		/** Type into the edit `id`; refused unless that is the edit open now. */
		inputEditing(text: string, id: object) {
			if (capture.locked() || editing?.id !== id) return;
			editing = { ...editing, text };
		},
		/**
		 * Save the edit `id`. Refused, with its text kept, when the thought it
		 * started from is no longer at its position.
		 */
		commitEditing(id: object): boolean {
			if (capture.locked() || editing?.id !== id) return false;
			const { index, original, text: edited } = editing;
			const now = current();
			if (now === undefined || now.thoughts[index] !== original) {
				refusal = `${CHANGED} Your edit is kept here; copy it, then cancel.`;
				return false;
			}
			if (edited.trim() === '') {
				refusal = 'A thought needs text. Delete it instead.';
				return false;
			}
			if (
				!write({
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
		/** Delete the thought at `index` of the list `shown`. */
		deleteThought(index: number, shown: readonly string[]): boolean {
			if (capture.locked()) return false;
			const now = current();
			if (
				now === undefined ||
				!sameList(shown, now.thoughts) ||
				shown[index] === undefined
			) {
				refusal = CHANGED;
				return false;
			}
			return write({
				text: now.text,
				thoughts: shown.filter((_, at) => at !== index),
			});
		},
		/** Swap two neighbouring thoughts of the list `shown`. */
		swapThoughts(from: number, to: number, shown: readonly string[]): boolean {
			if (capture.locked()) return false;
			const now = current();
			const next = [...shown];
			const first = next[from];
			const second = next[to];
			if (
				now === undefined ||
				!sameList(shown, now.thoughts) ||
				Math.abs(from - to) !== 1 ||
				first === undefined ||
				second === undefined
			) {
				refusal = CHANGED;
				return false;
			}
			next[from] = second;
			next[to] = first;
			return write({ text: now.text, thoughts: next });
		},
	};
}
