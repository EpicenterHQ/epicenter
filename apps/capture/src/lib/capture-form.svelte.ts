/**
 * The capture view's form for one capture: the edit not saved yet, the
 * input not committed yet, and the commands that turn a change of text or
 * thoughts into a new body.
 *
 * A capture's body is a document, so the form types into the row's draft
 * in the local folder's edit layer (`edits.row`): it holds the row the edit
 * started from and the body typed, outside the cache, so reading the folder
 * again never replaces it, and each save is the change from that row, which
 * the folder merges with whatever was saved since.
 * A thought added, edited, deleted, or moved saves at once; the capture
 * text saves a second after the last keystroke, or when the person leaves
 * it (`flush`). Saves run one at a time; text typed while one runs goes in
 * the next. A failed save keeps the draft and its error.
 *
 * Every structured change reads the body the form shows now (the typed
 * body, or the cache's), composes the complete `{ text, thoughts }`, encodes
 * it over that body (`captureBody.encode`), and puts it in the draft. A
 * change the body cannot hold exactly is refused with the reason, and
 * nothing changes.
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
	type CaptureRow,
	captureBody,
	type captureTables,
} from '@epicenter/capture';
import type { Edits } from '@epicenter/svelte/edits';

/** A capture file that reads as a capture's frontmatter. */
export type StoredCapture = Extract<CaptureRow, { issues: null }>;

/** One row's draft in the local folder's edit layer. */
export type CaptureDraft = ReturnType<
	Edits<typeof captureTables>['row']
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

export function createCaptureForm(capture: {
	/** The capture as the cache holds it now, if it reads as one. */
	row(): StoredCapture | undefined;
	/** The capture's draft (`edits.row('captures', stem)`). */
	draft: CaptureDraft;
}) {
	const { draft } = capture;
	let newThought = $state('');
	let editing = $state.raw<ThoughtEdit | undefined>();
	/** Why the last change was not taken; the next change clears it. */
	let refusal = $state<string | undefined>();

	/** Whether input is refused now: the folder closes, or the capture is deleted. */
	const locked = () => draft.locked;

	/** The body the form shows: the typed body, or the cache's. */
	function shown(): string | undefined {
		const row = capture.row();
		return row === undefined ? draft.pending?.body : draft.shown(row).body;
	}

	/**
	 * Put `body` in the draft, and save it at once unless `later`, when it
	 * saves after a pause; answers whether the change was taken.
	 */
	function edit(body: string, { later = false } = {}): boolean {
		const row = capture.row();
		if (row === undefined || !draft.change(row, { body })) return false;
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
		if (locked()) return false;
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
		draft,
		/** The edited body, until its saves land; `undefined` with no edit. */
		get body() {
			return draft.pending?.body;
		},
		/** Whether a save of the edit is running. */
		get saving() {
			return draft.saving;
		},
		/** Save what the draft holds; resolves once no save of it runs. */
		flush: () => draft.save(),
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
			write({ text: value, thoughts: now.thoughts }, { later: true });
		},

		get newThought() {
			return newThought;
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
			if (locked() || now === undefined || !sameList(shown, now.thoughts))
				return;
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
		 * started from is no longer at its position.
		 */
		commitEditing(id: object): boolean {
			if (locked() || editing?.id !== id) return false;
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
			if (locked()) return false;
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
			if (locked()) return false;
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
