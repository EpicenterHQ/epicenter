/**
 * The HTTP contract between serve and its callers, a page and the command
 * alike: the listing, the header that names an Epicenter, and one action call.
 * A call is `POST /actions/<app>/<action>` with the input as JSON, answered
 * by JSON lines, `{"update": value}` for each update, then
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
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	ActionError,
	type Answer,
	isResult,
	type NotStarted,
	type Unreachable,
} from './answer.ts';
import type { ObjectSchema } from './field.ts';
import { isPlainObject, parseJson } from './json.ts';

/**
 * The header a request from the command names its Epicenter in: the Epicenter's real
 * path, percent-encoded. The command sends it only to 127.0.0.1, so the path
 * never leaves this computer, and serve refuses a request for another Epicenter
 * with 409, so a command in a second home on the same port reaches nothing.
 */
export const HOME_HEADER = 'x-epicenter-home';

/** An action as the listing shows it. */
export type ActionListing = {
	name: string;
	description: string;
	input: ObjectSchema;
};

/** An app as the listing shows it. */
export type AppListing = {
	name: string;
	description: string;
	actions: ActionListing[];
};

/** Everything serve offers, as `GET /actions/` answers it. */
export type Listing = {
	/** The version of `@epicenter/app` serve runs. */
	version: string;
	apps: AppListing[];
	/** Why `epicenter.ts` did not load, when it did not; then there are no apps. */
	problem?: string;
};

/** Where an action is called, from serve's root. */
export const actionPath = (app: string, action: string) =>
	`/actions/${encodeURIComponent(app)}/${encodeURIComponent(action)}`;

/** What a refusal status says, where serve's reason is known. */
const REFUSED: Record<number, string> = {
	403: 'serve refused the request: it came through a tunnel, or from another host or site',
	409: "The serve on this port is another Epicenter's; give this Epicenter another port in its package.json",
	413: 'The input is larger than 25 MiB, the most serve takes',
};

/**
 * What a fetch that threw means: nothing listening is `NotStarted`, and any
 * other failure is `Unreachable`, saying `ended`, since the request may have
 * reached serve before the connection dropped.
 */
function fetchFailed(cause: unknown, ended: string) {
	const { code } = (cause ?? {}) as { code?: string };
	return code === 'ECONNREFUSED' || code === 'ConnectionRefused'
		? ActionError.NotStarted({
				message: 'serve is not running; if it stopped, its output says why',
				next: 'epicenter serve',
			})
		: ActionError.Unreachable({ message: ended });
}

/** A response that is not 200, as the error it means. */
function statusFailed({ status, statusText }: Response) {
	const message =
		REFUSED[status] ?? `serve answered ${status} ${statusText}`.trim();
	return status >= 400 && status < 500
		? ActionError.NotStarted({ message })
		: ActionError.Unreachable({ message });
}

const invalid = () =>
	ActionError.Unreachable({ message: 'serve sent an invalid answer' });

const CUT =
	'The connection ended before the answer; the action may still be running, or may have finished';

/**
 * Fetch `url` from serve and give the response when it is a 200, or the
 * error a failed fetch or another status means. `ended` says what was lost
 * when the connection dropped.
 */
export async function fetchServe(
	url: string,
	init: RequestInit,
	ended: string,
): Promise<Result<Response, NotStarted | Unreachable>> {
	const response = await fetch(url, init).catch((cause: unknown) =>
		fetchFailed(cause, ended),
	);
	if (!(response instanceof Response)) return response;
	if (response.status === 200) return Ok(response);
	void response.body?.cancel().catch(() => undefined);
	return statusFailed(response);
}

/** Tell the page about a listener's failure without ending the call. */
const report = (cause: unknown) =>
	queueMicrotask(() => {
		throw cause;
	});

/** Hand `value` to `onUpdate`, reporting its failure instead of ending the call. */
function hear(
	onUpdate: ((value: unknown) => unknown) | undefined,
	value: unknown,
) {
	try {
		const heard = onUpdate?.(value);
		if (heard instanceof Promise) heard.catch(report);
	} catch (cause) {
		report(cause);
	}
}

/**
 * Post `body`, an action's input as JSON text, to `url`, hand each update to
 * `onUpdate` in order, and give the answer. A listener that throws is
 * reported and the call goes on. A stream that ends before its answer was
 * cut off, and the action may still be running or may have finished.
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
	const cut = () => ActionError.Unreachable({ message: CUT });
	const { data: response, error } = await fetchServe(
		url,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body,
		},
		CUT,
	);
	if (error !== null) return Err(error);
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
				hear(onUpdate, line.update);
			}
			if (done) return cut();
		}
	} catch {
		return cut();
	} finally {
		void lines.cancel().catch(() => undefined);
	}
}
