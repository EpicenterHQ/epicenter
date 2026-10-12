/**
 * The capture view's form for one capture: the input not committed yet, and
 * the commands that turn a change of text or thoughts into a new body.
 *
 * Every structured change reads the body the cache holds now, composes the
 * complete `{ text, thoughts }`, encodes it over that body
 * (`captureBody.encode`), and edits the cache, which writes at once. A
 * change the body cannot hold exactly is refused with the reason, and the
 * cache is unchanged.
 *
 * A new thought and a thought being edited are typed here until they are
 * added or saved; they are `$state`, kept while the person moves between
 * captures. Thoughts are selected by position, so a command names the list
 * it was shown and is refused when the list changed since; a thought edit
 * remembers the thought it started from and is refused, with its text kept,
 * when that thought changed.
 */
import { type CaptureBody, captureBody } from '@epicenter/capture';
import { wellFormed } from '@epicenter/folder';

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
	/** The body the cache holds now, if the capture reads as a row. */
	body(): string | undefined;
	/** Put a new body in the cache and queue its write; answers whether it was taken. */
	setBody(body: string): boolean;
	/** Whether input is refused now: leaving, closing, or deleting. */
	locked(): boolean;
}) {
	let newThought = $state('');
	let editing = $state.raw<ThoughtEdit | undefined>();
	/** Why the last change was not taken; the next change clears it. */
	let refusal = $state<string | undefined>();

	/** The body now as text and thoughts, if it reads as them. */
	function current() {
		const body = capture.body();
		if (body === undefined) return undefined;
		const { data } = captureBody.decode(body);
		return data === null ? undefined : { body, ...data };
	}

	/** Encode a complete value over the body now and put it in the cache. */
	function write(value: CaptureBody): boolean {
		if (capture.locked()) return false;
		const now = current();
		if (now === undefined) return false;
		const { data: body, error } = captureBody.encode(value, now.body);
		if (error !== null) {
			refusal = error.message;
			return false;
		}
		refusal = undefined;
		return body === now.body || capture.setBody(body);
	}

	return {
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

		/** Replace the capture text. A refused change leaves the text in the file. */
		inputText(value: string) {
			const now = current();
			if (now === undefined) return;
			write({ text: wellFormed(value), thoughts: now.thoughts });
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
					thoughts: [...now.thoughts, wellFormed(newThought)],
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
						at === index ? wellFormed(edited) : thought,
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
