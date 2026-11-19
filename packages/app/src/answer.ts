/**
 * How a caller reads serve's answer to an action call, for a page and for
 * the command alike. A call's response is JSON lines: `{"update": value}` for
 * each update, then `{"answer": {data, error}}`. A call serve refused before
 * it began is a 200 with one line, its `NotStarted` answer.
 *
 * Any status but 200 means serve did not take the call, and is
 * `Unreachable`. A 200 proves nothing more: one whose lines are not frames,
 * whose answer is not exactly `{ data, error }`, or whose stream ends with
 * no answer, is `Unreachable` too. This module
 * uses only web APIs, so a page's bundle can carry it.
 */
import type { Result } from 'wellcrafted/result';
import { ActionError, type PublicError } from './errors.ts';
import { parseJson } from './markdown.ts';

/** An action's answer on every surface: what it returned, or the error itself. */
export type Answer = Result<unknown, PublicError>;

/** Whether `value` is an object made by `{}` or `Object.create(null)`. */
export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Whether `value` is an answer: `{ data, error }` and nothing else. */
export function isAnswer(value: unknown): value is Answer {
	if (
		!isPlainObject(value) ||
		Reflect.ownKeys(value).length !== 2 ||
		!Object.hasOwn(value, 'error') ||
		!Object.hasOwn(value, 'data')
	)
		return false;
	const { error } = value;
	if (error === null) return true;
	return (
		value.data === null &&
		isPlainObject(error) &&
		typeof error.name === 'string' &&
		typeof error.message === 'string'
	);
}

const invalid = () =>
	ActionError.Unreachable({ message: 'serve sent an invalid answer' });

/**
 * Read a call's response: hand each update to `onUpdate` in order, and give
 * the answer. A stream that ends before its answer was cut off, and the
 * action may still be running or may have finished.
 */
export async function readAnswer(
	response: Response,
	onUpdate?: (value: unknown) => unknown,
): Promise<Answer> {
	if (response.status !== 200) {
		void response.body?.cancel().catch(() => undefined);
		return ActionError.Unreachable({
			message:
				`serve answered ${response.status} ${response.statusText}`.trim(),
		});
	}
	const cut = () =>
		ActionError.Unreachable({
			message:
				'The connection ended before the answer; the action may still be running, or may have finished',
		});
	if (!response.body) return cut();
	const lines = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let pending = '';
	try {
		for (;;) {
			const { done, value } = await lines.read();
			pending += value ?? '';
			const whole = pending.split('\n');
			// A last line with no newline was cut off partway.
			pending = whole.pop() ?? '';
			for (const text of whole) {
				if (text === '') continue;
				const line = parseJson(text);
				if (!isPlainObject(line)) return invalid();
				if (Object.hasOwn(line, 'answer'))
					return isAnswer(line.answer) ? line.answer : invalid();
				if (!Object.hasOwn(line, 'update')) return invalid();
				onUpdate?.(line.update);
			}
			if (done) return cut();
		}
	} catch {
		return cut();
	} finally {
		void lines.cancel().catch(() => undefined);
	}
}
