/**
 * One action call as a caller makes it, for a page and for the command
 * alike: `POST /actions/<app>/<action>` with the input as JSON, answered by
 * JSON lines, `{"update": value}` for each update, then
 * `{"answer": {data, error}}`. A call serve refused before it began is a 200
 * with one line, its `NotStarted` answer.
 *
 * Any other status means serve did not take the call: a 4xx is
 * `NotStarted`, since nothing ran, and anything else is `Unreachable`. A 200
 * proves nothing more: one whose lines are not frames, whose answer is not
 * exactly `{ data, error }`, or whose stream ends with no answer, is
 * `Unreachable` too. This module uses only web APIs, so a page's bundle can
 * carry it.
 */
import type { Result } from 'wellcrafted/result';
import { ActionError, type PublicError } from './errors.ts';
import { isPlainObject, parseJson } from './json.ts';

/** An action's answer on every surface: what it returned, or the error itself. */
export type Answer = Result<unknown, PublicError>;

/** Whether `value` is a Result: `{ data, error }` and nothing else. */
export function isResult(value: unknown): value is Answer {
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

/** Where an action is called, from serve's root. */
export const actionPath = (app: string, action: string) =>
	`/actions/${encodeURIComponent(app)}/${encodeURIComponent(action)}`;

/** What a refusal status says, where serve's reason is known. */
const REFUSED: Record<number, string> = {
	403: 'serve refused the request: it came through a tunnel, or from another host or site',
	409: "The serve on this port is another home's; give this home another port in its package.json",
	413: 'The input is larger than 25 MiB, the most serve takes',
};

/**
 * What a fetch that threw means: nothing listening is `NotStarted`, and any
 * other failure is `Unreachable`, saying `ended`, since the request may have
 * reached serve before the connection dropped.
 */
export function fetchFailed(cause: unknown, ended: string) {
	const { code } = (cause ?? {}) as { code?: string };
	return code === 'ECONNREFUSED' || code === 'ConnectionRefused'
		? ActionError.NotStarted({
				message: 'serve is not running; if it stopped, its output says why',
				next: 'epicenter serve',
			})
		: ActionError.Unreachable({ message: ended });
}

/** A response that is not 200, as the error it means. */
export function statusFailed({ status, statusText }: Response) {
	const message =
		REFUSED[status] ?? `serve answered ${status} ${statusText}`.trim();
	return status >= 400 && status < 500
		? ActionError.NotStarted({ message })
		: ActionError.Unreachable({ message });
}

const invalid = () =>
	ActionError.Unreachable({ message: 'serve sent an invalid answer' });

const cut = () =>
	ActionError.Unreachable({
		message:
			'The connection ended before the answer; the action may still be running, or may have finished',
	});

/**
 * Post `body`, an action's input as JSON text, to `url`, hand each update to
 * `onUpdate` in order, and give the answer. A stream that ends before its
 * answer was cut off, and the action may still be running or may have
 * finished.
 */
export async function postAction(
	url: string,
	body: string,
	{
		headers,
		onUpdate,
	}: {
		headers?: Record<string, string>;
		onUpdate?: (value: unknown) => unknown;
	} = {},
): Promise<Answer> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body,
	}).catch((cause: unknown) => fetchFailed(cause, cut().error.message));
	if (!(response instanceof Response)) return response;
	if (response.status !== 200) {
		void response.body?.cancel().catch(() => undefined);
		return statusFailed(response);
	}
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
					return isResult(line.answer) ? line.answer : invalid();
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
