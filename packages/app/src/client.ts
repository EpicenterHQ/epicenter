/**
 * How an app's UI asks `epicenter serve` to run its actions (ADR-0860,
 * ADR-0866). A UI is a web page built from an app's `ui/` into `ui/dist/`
 * and served at `/<app>/`. A call is `POST /<app>/<action>` with the input as
 * JSON; the answer is JSON lines, `{"update": value}` for each update the
 * action sends and then `{"answer": ...}` (ADR-0879).
 *
 * The client has the app's actions under the same words as the app. Each
 * call checks its input, types what it returns in its JSON form, and resolves
 * to a Result: what the action returned, or a shared `ActionError` saying why
 * work failed. Error names do not say what persisted.
 * A UI lists the actions it watches and makes with Wellcrafted (ADR-0661),
 * and the QueryClient its layout makes refreshes what it shows:
 *
 * ```ts
 * import { connect } from '@epicenter/app/client';
 * import { resultMutations, resultQueries } from 'wellcrafted/query';
 * import type tasks from '../../../epicenter.ts';
 *
 * const app = connect<typeof tasks>();
 * export const taskReads = resultQueries(['tasks'], { list: app.list, get: app.get });
 * export const taskWrites = resultMutations(['tasks'], { set: app.set });
 *
 * const list = createQuery(() => taskReads.list());
 * const setTask = createMutation(() => taskWrites.set);
 * setTask.mutate({ id, done: true });
 * ```
 *
 * The app is imported as a type, so the UI's bundle carries no app code.
 */
import { type Err, Ok, type Result } from 'wellcrafted/result';
import type { ActionUpdate } from './action.ts';
import { isActionResult, type PublicError } from './action-result.ts';
import { ActionError, isActionError } from './errors.ts';
import type { JsonValue } from './front-matter.ts';

export { partitionResults } from 'wellcrafted/result';
export type { ActionError } from './errors.ts';

/** `T` flattened into one object type. */
type Flat<T> = { [K in keyof T]: T[K] } & {};

/**
 * `T` as it arrives through JSON: `undefined` is `null`, and a property that
 * may be `undefined` may be absent. `defineAction` refuses any other value
 * JSON does not carry, such as a `Date`.
 */
type JsonOf<T> = unknown extends T
	? T
	: [T] extends [JsonValue]
		? T
		: T extends undefined | void
			? null
			: T extends string | number | boolean | null
				? T
				: T extends readonly unknown[]
					? { [K in keyof T]: JsonOf<T[K]> }
					: Flat<
							{
								[K in keyof T as undefined extends T[K] ? never : K]: JsonOf<
									T[K]
								>;
							} & {
								[K in keyof T as undefined extends T[K] ? K : never]?: JsonOf<
									Exclude<T[K], undefined>
								>;
							}
						>;

/** What action `A` takes from a caller: `ActionInput<typeof app.actions.set>`. */
export type ActionInput<A> = A extends (input: infer In) => unknown
	? In
	: never;

/** What action `A` returns to a client, in its JSON form: `ActionOutput<typeof app.actions.get>`. */
type ReturnedBy<A> = A extends (input: never) => infer Out
	? Awaited<Out>
	: never;
export type ActionOutput<A> = JsonOf<
	Extract<Exclude<ReturnedBy<A>, Err<never>>, Ok<unknown>>['data']
>;
type ReturnedError<A> = JsonOf<
	Exclude<Extract<ReturnedBy<A>, Err<unknown>>['error'], null>
>;

/** A call of an action that sends updates may listen with `onUpdate`. */
type CallOptions<A> = [ActionUpdate<A>] extends [never]
	? []
	: [
			options?: {
				onUpdate?: (value: JsonOf<ActionUpdate<A>>) => unknown;
			},
		];

/**
 * The client for actions `A`: each action a function of its input, each
 * group under its word. An action that sends updates also takes
 * `{ onUpdate }`, which receives each one in order. The call resolves to what
 * the action returned or an action error. An update reports and is never the
 * answer; what `onUpdate` returns is not awaited, and what it throws is
 * reported to the page and does not end the call. The action runs to its end
 * on serve whether or not the page stays to hear it.
 */
export type ActionCall<A> = (
	...args: [
		...(Record<string, never> extends ActionInput<A>
			? [input?: ActionInput<A>]
			: [input: ActionInput<A>]),
		...CallOptions<A>,
	]
) => Promise<Result<ActionOutput<A>, ActionError | ReturnedError<A>>>;

export type AppClient<A> = {
	readonly [K in keyof A]: A[K] extends (input: never) => unknown
		? ActionCall<A[K]>
		: AppClient<A[K]>;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const invalid = () =>
	ActionError.Unreachable({ message: 'Epicenter sent an invalid answer' });

/** Serve's answer as the Result a page reads: what the action returned, or why not. */
function answered(answer: unknown): Result<unknown, PublicError> {
	if (
		!isObject(answer) ||
		Object.keys(answer).length !== 2 ||
		!Object.hasOwn(answer, 'data') ||
		!Object.hasOwn(answer, 'error')
	)
		return invalid();
	const failure = answer.error;
	if (failure === null) return Ok(answer.data);
	if (answer.data !== null || !isObject(failure)) return invalid();
	const { kind, reason, message, thrown } = failure;
	const tagged = (value: unknown): value is PublicError =>
		isObject(value) &&
		typeof value.name === 'string' &&
		typeof value.message === 'string';
	if (kind === 'returned') {
		const result = { data: null, error: reason };
		return isActionResult(result) && result.error !== null ? result : invalid();
	}
	if (kind === 'fault') {
		if (
			typeof message !== 'string' ||
			(thrown !== undefined && !tagged(thrown))
		)
			return invalid();
		return ActionError.Threw({
			message,
			thrown: thrown as Record<string, unknown> & PublicError,
		});
	}
	if (kind !== 'refused' || !tagged(reason)) return invalid();
	const { next } = reason as { next?: unknown };
	if (
		(next !== undefined && typeof next !== 'string') ||
		((reason as { namespace?: unknown }).namespace ===
			'epicenter/action-error' &&
			!isActionError(reason))
	)
		return invalid();
	return ActionError.Refused({ message: reason.message, next });
}

/** Tell the page about a listener's failure without ending the call. */
function report(cause: unknown) {
	const page = globalThis as { reportError?: (cause: unknown) => void };
	if (page.reportError) page.reportError(cause);
	else queueMicrotask(() => Promise.reject(cause));
}

/**
 * Call one action and read its JSON lines. A stream that ends with no answer
 * was cut off: the action may still be running or may have finished, so the
 * page rereads its records.
 */
async function call(
	url: string,
	input: unknown,
	onUpdate?: (value: unknown) => unknown,
): Promise<Result<unknown, PublicError>> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input ?? {}),
		});
	} catch {
		return ActionError.Unreachable({
			message: 'Epicenter could not be reached; the action did not start',
		});
	}
	if (!response.ok) {
		const body: unknown = await response.json().catch(() => undefined);
		const refusal = answered(body);
		return refusal.error !== null && refusal.error.name === 'Refused'
			? refusal
			: ActionError.Refused({
					message: `Epicenter answered ${response.status} ${response.statusText}`,
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
				if (Object.hasOwn(line, 'answer')) return answered(line.answer);
				if (!Object.hasOwn(line, 'update')) return invalid();
				try {
					const heard = onUpdate?.(line.update);
					if (heard instanceof Promise) heard.catch(report);
				} catch (cause) {
					report(cause);
				}
			}
			if (done) return cut();
		}
	} catch {
		return cut();
	} finally {
		void lines.cancel().catch(() => undefined);
	}
}

/**
 * A client for the app served at this page's first path segment. A page at
 * `/<app>/` uses `app` without repeating its name; pass `{ app }` when the
 * page does not identify it. Without either name, `connect` throws. `url`
 * defaults to this origin's `/`, where `epicenter serve` answers the UIs it
 * serves: an action is `POST <url><app>/<words joined by .>`.
 */
export function connect<App extends { actions: object }>({
	app,
	url = '/',
}: {
	app?: string;
	url?: string;
} = {}): AppClient<App['actions']> {
	const name = app ?? appOfPage();
	const base = url.endsWith('/') ? url : `${url}/`;
	const at = (words: string[]): unknown =>
		new Proxy(() => {}, {
			get: (_, key) =>
				typeof key === 'string' && key !== 'then'
					? at([...words, key])
					: undefined,
			apply: (_, __, [input, options]) => {
				if (words.length === 0)
					throw new Error(`Call one of ${name}'s actions, not the app`);
				return call(
					`${base}${encodeURIComponent(name)}/${words.map(encodeURIComponent).join('.')}`,
					input,
					options?.onUpdate,
				);
			},
		});
	return at([]) as AppClient<App['actions']>;
}

/** The app whose `/<app>/` serves this page. */
function appOfPage(): string {
	const page = globalThis as {
		document?: { baseURI: string };
		location?: { href: string };
	};
	const href = page.document?.baseURI ?? page.location?.href;
	const segment = href && new URL(href).pathname.split('/')[1];
	if (!segment)
		throw new Error(
			'connect() needs a UI served at /<app>/ or an explicit { app }',
		);
	return segment;
}
