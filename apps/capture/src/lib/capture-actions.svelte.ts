/** Capture commands compose over the text currently shown by one body draft. */
import { type CaptureBody, captureBody } from '@epicenter/capture';

/** A range of a file's text as a text box shows it, with LF lines. */
export type TextRange = { readonly start: number; readonly end: number };
export type BodyDraft = { readonly value: string; set(value: string): void };

const CHANGED =
	'The thoughts changed since they were shown, so nothing was changed.';
const sameList = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((item, index) => item === b[index]);

/** Locate a thought in saved file text after the body draft has settled. */
export function locateThought(
	fileText: string,
	body: string,
	index: number,
	list: readonly string[],
): TextRange | undefined {
	const reading = captureBody.decode(body);
	if (
		reading.error !== null ||
		!sameList(reading.data.thoughts, list) ||
		!fileText.endsWith(body)
	)
		return undefined;
	const span = captureBody.locate(body).data?.thoughts[index];
	if (span === undefined) return undefined;
	const bodyStart = fileText.length - body.length;
	const at = (offset: number) =>
		fileText.slice(0, bodyStart + offset).replace(/\r\n?/g, '\n').length;
	return { start: at(span.start), end: at(span.end) };
}

export function createCaptureActions(body: BodyDraft) {
	let refusal = $state<string | undefined>();
	const shown = () => {
		const reading = captureBody.decode(body.value);
		return reading.error === null
			? { body: body.value, ...reading.data }
			: undefined;
	};
	function write(
		over: NonNullable<ReturnType<typeof shown>>,
		value: CaptureBody,
	): boolean {
		const encoded = captureBody.encode(value, over.body);
		if (encoded.error !== null) {
			refusal = encoded.error.message;
			return false;
		}
		refusal = undefined;
		if (encoded.data !== over.body) body.set(encoded.data);
		return true;
	}
	function current(list: readonly string[]) {
		const now = shown();
		return now !== undefined && sameList(list, now.thoughts) ? now : undefined;
	}
	return {
		get refusal() {
			return refusal;
		},
		refuseChanged() {
			refusal = CHANGED;
		},
		inputText(value: string) {
			const now = shown();
			if (now !== undefined)
				write(now, { text: value, thoughts: now.thoughts });
		},
		addThought(text: string): boolean {
			if (text.trim() === '') {
				refusal = 'Write something first.';
				return false;
			}
			const now = shown();
			return (
				now !== undefined &&
				write(now, { text: now.text, thoughts: [...now.thoughts, text] })
			);
		},
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
