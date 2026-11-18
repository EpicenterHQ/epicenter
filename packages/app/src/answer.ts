/**
 * How a caller reads serve's answer to an action call, for a page and for the
 * CLI alike (ADR-0930, ADR-0953). A call's response is JSON lines:
 * `{"update": value}` for each update, then `{"answer": {data, error}}`. A call
 * serve refused before it began is one answer, `NotStarted`, as the body of an
 * HTTP error.
 *
 * The status alone proves nothing: a 200 whose lines are not frames, or whose
 * stream ends with no answer, is `Unreachable`, and so is an HTTP error
 * without a `NotStarted` in its body. This module uses only web APIs, so a
 * page's bundle can carry it.
 */
import { Ok, type Result } from 'wellcrafted/result';
import { isActionResult, type PublicError } from './action-result.ts';
import { ActionError, RESERVED_NAMES } from './errors.ts';

/** An action's answer on every surface: what it returned, or the error itself. */
export type Answer = Result<unknown, PublicError>;

const NAMESPACE = 'epicenter/action-error';
const CAUSES = ['usage', 'app-problems', 'internal', 'unavailable'];

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown) => typeof value === 'string';

const invalid = () =>
	ActionError.Unreachable({ message: 'Epicenter sent an invalid answer' });

/** Whether a platform error's own fields are the ones its name carries. */
function fieldsFit(error: Record<string, unknown>): boolean {
	if (error.namespace !== NAMESPACE)
		return !RESERVED_NAMES.includes(error.name as string);
	if (error.name === 'Threw')
		return (
			error.thrown === undefined ||
			(isObject(error.thrown) &&
				isText(error.thrown.name) &&
				isText(error.thrown.message))
		);
	if (error.name === 'NotStarted')
		return (
			CAUSES.includes(error.cause as string) &&
			(error.next === undefined || isText(error.next)) &&
			(error.problems === undefined ||
				(Array.isArray(error.problems) && error.problems.every(isText)))
		);
	return true;
}

/**
 * One answer as a caller reads it: exactly `data` and `error`, where `error`
 * is `null` or a tagged object. A platform error must carry the fields its
 * name does, and `NotStarted` or `Unreachable` must carry the platform's
 * namespace. Anything else is `Unreachable`.
 */
export function checkAnswer(value: unknown): Answer {
	if (!isActionResult(value)) return invalid();
	if (value.error === null) return Ok(value.data);
	return fieldsFit(value.error as unknown as Record<string, unknown>)
		? value
		: invalid();
}

/**
 * Read a call's response: hand each update to `onUpdate` in order, and give
 * the answer. A stream that ends before its answer was cut off, and the
 * action may still be running or may have finished.
 */
export async function readAnswer(
	response: Response,
	onUpdate?: (value: unknown) => unknown,
): Promise<Answer> {
	if (!response.ok) {
		let body: unknown;
		try {
			body = JSON.parse(await response.text());
		} catch {
			// Not an answer; the status is all there is.
		}
		const refusal = checkAnswer(body);
		if (refusal.error?.name === 'NotStarted') return refusal;
		return ActionError.Unreachable({
			message:
				`Epicenter answered ${response.status} ${response.statusText}`.trim(),
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
				let line: unknown;
				try {
					line = JSON.parse(text);
				} catch {
					return invalid();
				}
				if (!isObject(line)) return invalid();
				if (Object.hasOwn(line, 'answer')) return checkAnswer(line.answer);
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
