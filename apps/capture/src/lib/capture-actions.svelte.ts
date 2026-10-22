/**
 * Capture-specific commands over the Folder's file edit. Each command encodes
 * over its current body; positional commands refuse a changed thought list.
 * The only local state is the reason a command was refused.
 */
import {
	type CaptureBody,
	captureBody,
	type captureTables,
} from '@epicenter/capture';
import type { FileDocument } from '@epicenter/folder/document';

/** A range of a file's text as a text box shows it, with LF lines. */
export type TextRange = { readonly start: number; readonly end: number };

/** Why a command on a position did nothing: the thoughts changed under it. */
const CHANGED =
	'The thoughts changed since they were shown, so nothing was changed.';

const sameList = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((item, index) => item === b[index]);

/** Commands that change the capture through `fileEdit`. */
export function createCaptureActions(
	fileEdit: FileDocument<(typeof captureTables)['captures']>,
) {
	/** Why the last change was not taken; the next change clears it. */
	let refusal = $state<string | undefined>();

	/** The body this command composes over: the capture as it reads now. */
	const shown = () => {
		const row = fileEdit.getSnapshot().content;
		if (row?.issues !== null || row.fields.draft === true) return undefined;
		const { data, error } = captureBody.decode(row.body);
		return error === null ? { body: row.body, ...data } : undefined;
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
		const changed = fileEdit.patch({ body });
		if (changed.error !== null) {
			refusal = changed.error.message;
			return false;
		}
		if (!later) void fileEdit.save();
		return true;
	}

	/** The body now, when `list` is its thoughts: a position in it names the same thought. */
	function current(list: readonly string[]) {
		const now = shown();
		return now !== undefined && sameList(list, now.thoughts) ? now : undefined;
	}

	return {
		get refusal() {
			return refusal;
		},
		/**
		 * Replace the capture text and let the Folder autosave it. A refused
		 * change leaves the current text.
		 */
		inputText(value: string) {
			const now = shown();
			if (now === undefined) return;
			write(now, { text: value, thoughts: now.thoughts }, { later: true });
		},
		/**
		 * Add `text` as a thought after the last one. Answers whether it was
		 * taken; the view clears its input only then.
		 */
		addThought(text: string): boolean {
			if (text.trim() === '') {
				refusal = 'Write something first.';
				return false;
			}
			const now = shown();
			if (now === undefined) return false;
			return write(now, { text: now.text, thoughts: [...now.thoughts, text] });
		},
		/**
		 * Where the thought at `index` of the list `list` a view showed sits in
		 * the file's text, for editing it as text. Refused when the list changed.
		 */
		locateThought(
			index: number,
			list: readonly string[],
		): TextRange | undefined {
			const now = current(list);
			const row = fileEdit.getSnapshot().content;
			const span =
				now === undefined
					? undefined
					: captureBody.locate(now.body).data?.thoughts[index];
			if (
				span === undefined ||
				row?.body === undefined ||
				!row.text.endsWith(row.body)
			) {
				refusal = CHANGED;
				return undefined;
			}
			refusal = undefined;
			// The body ends the file; a text box shows every line ending as LF.
			const bodyStart = row.text.length - row.body.length;
			const at = (offset: number) =>
				row.text.slice(0, bodyStart + offset).replace(/\r\n?/g, '\n').length;
			return { start: at(span.start), end: at(span.end) };
		},
		/** Delete the thought at `index` of the list `list` a view showed. */
		deleteThought(index: number, list: readonly string[]): boolean {
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
