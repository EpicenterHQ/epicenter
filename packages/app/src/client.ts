/**
 * How an app's UI asks `epicenter serve` to run its actions (ADR-0860,
 * ADR-0866). A UI is a web page built from an app's `ui/` into `ui/dist/`
 * and served at `/<app>/`; it runs an action at `POST /<app>/<action>` on the
 * same origin, and reads the response's JSON lines: each value the action
 * yields, then its answer (ADR-0879). Agents ask over MCP instead.
 *
 * The client has the app's actions under the same words as the app. Each
 * call checks its input, types what it returns in its JSON form, and resolves
 * to a Result: what the action returned, or a shared `ActionError` saying why
 * work failed. Error names do not say what persisted; the wire envelope
 * records whether the action ran.
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
 * setTask.mutate({ path, done: true });
 * ```
 *
 * The app is imported as a type, so the UI's bundle carries no app code.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ActionYield } from './action.ts';
import { ActionError, isActionError } from './errors.ts';
import type { UploadedFile } from './field.ts';
import type { JsonValue } from './front-matter.ts';
import {
	createRunMethods,
	type PendingRun,
	pendingRuns,
	type Run,
	type RunEvent,
} from './run-client.ts';

export type { ActionError } from './errors.ts';
export { type PendingRun, pendingRuns, type Run, type RunEvent };

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
export type ActionOutput<A> = A extends (input: never) => infer Out
	? JsonOf<Awaited<Out>>
	: never;

/** Browser files replace the host's uploaded file handles, including optional files. */
type BrowserInput<T> = T extends UploadedFile ? Blob : T;
type RunInput<In> = { [K in keyof In]: BrowserInput<In[K]> };

type RunMethods<A> = {
	start(
		...args: Record<string, never> extends ActionInput<A>
			? [input?: RunInput<ActionInput<A>>]
			: [input: RunInput<ActionInput<A>>]
	): Run<JsonOf<ActionYield<A>>, ActionOutput<A>>;
	attach(id: string): Run<JsonOf<ActionYield<A>>, ActionOutput<A>>;
	pending(): PendingRun[];
};

/** What a call of action `A` may take after its input, when `A` yields: `onYield`, and a `signal` that stops it. */
type CallOptions<A> = [ActionYield<A>] extends [never]
	? []
	: [
			options?: {
				onYield?: (value: JsonOf<ActionYield<A>>) => unknown;
				signal?: AbortSignal;
			},
		];

/**
 * The client for actions `A`: each action a function of its input, each
 * group under its word. An action that yields also takes `{ onYield }`,
 * which receives each value in order and may return a promise to wait for,
 * and `{ signal }`, which stops it at its next yield. The call resolves to what the
 * action returned, or `Stopped`. If `onYield` throws or rejects, the call
 * rejects with that error and stops reading the response.
 * Below the top level, `start`, `attach`, and `pending` are run methods of
 * the action at that path. An action or group member with one of those names
 * under a group is unreachable through connect(). A top-level action named
 * `start` remains reachable.
 */
export type AppClient<A> = {
	readonly [K in keyof A]: A[K] extends (input: never) => unknown
		? ((
				...args: [
					...(Record<string, never> extends ActionInput<A[K]>
						? [input?: ActionInput<A[K]>]
						: [input: ActionInput<A[K]>]),
					...CallOptions<A[K]>,
				]
			) => Promise<Result<ActionOutput<A[K]>, ActionError>>) &
				RunMethods<A[K]>
		: AppClient<A[K]>;
};

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
			get: (_, key) => {
				if (
					words.length > 0 &&
					(key === 'start' || key === 'attach' || key === 'pending')
				)
					return createRunMethods({
						base,
						app: name,
						action: words.join('.'),
						answered,
					})[key];
				return typeof key === 'string' && key !== 'then'
					? at([...words, key])
					: undefined;
			},
			apply: async (_, __, [input, options]) => {
				if (words.length === 0)
					throw new Error(`Call one of ${name}'s actions, not the app`);
				if (
					input &&
					Object.values(input).some((value) => value instanceof Blob)
				)
					return ActionError.Refused({
						message: 'This action takes a file; start it with .start(input)',
					});
				return call(
					`${base}${encodeURIComponent(name)}/${words.join('.')}`,
					input ?? {},
					options,
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

/**
 * Own the request and its JSON lines, translating transport and decoding
 * failures into `Unreachable` or `Stopped`. Code consuming a yield runs
 * outside this catch.
 * Read with `getReader`, since Safari cannot iterate a stream with `for await`.
 */
async function* responseLines(url: string, body: string, signal?: AbortSignal) {
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			signal,
		});
		const reader = response.body?.getReader();
		try {
			if (!response.ok || !reader) {
				yield ActionError.Unreachable({
					message: `Epicenter answered ${response.status} ${response.statusText}`,
				});
				return;
			}
			const decoder = new TextDecoder();
			let buffered = '';
			for (;;) {
				const { done, value } = await reader.read();
				buffered += decoder.decode(value, { stream: !done });
				let end = buffered.indexOf('\n');
				while (end >= 0) {
					const text = buffered.slice(0, end);
					buffered = buffered.slice(end + 1);
					if (text.trim()) yield Ok(JSON.parse(text) as unknown);
					end = buffered.indexOf('\n');
				}
				if (done) return;
			}
		} finally {
			if (reader) {
				// Abandoning the response stops its producer. Cleanup must neither
				// delay the outcome nor replace it if the connection already failed.
				void reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		}
	} catch (cause) {
		yield signal?.aborted
			? ActionError.Stopped({ message: 'Stopped' })
			: ActionError.Unreachable({
					message: `Could not read Epicenter's answer: ${String(cause)}`,
				});
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaggedError(
	value: unknown,
): value is { name: string; message: string } & Record<string, unknown> {
	return (
		isObject(value) &&
		typeof value.name === 'string' &&
		typeof value.message === 'string'
	);
}

/** Validate serve's terminal answer; the action owns the shape of its returned value. */
function answered(answer: unknown): Result<unknown, ActionError> {
	const invalid = () =>
		ActionError.Unreachable({ message: 'Epicenter sent an invalid answer' });
	if (!isObject(answer)) return invalid();
	if (
		['returned', 'threw', 'error'].filter((key) => Object.hasOwn(answer, key))
			.length !== 1
	)
		return invalid();
	if ('returned' in answer) return Ok(answer.returned);
	if ('threw' in answer) {
		const failure = answer.threw;
		if (!isObject(failure) || typeof failure.message !== 'string')
			return invalid();
		const { thrown } = failure;
		if (thrown !== undefined && !isTaggedError(thrown)) return invalid();
		return isActionError(thrown)
			? Err(thrown)
			: ActionError.Threw({ message: failure.message, thrown });
	}
	const failure = answer.error;
	if (
		!isObject(failure) ||
		typeof failure.message !== 'string' ||
		(failure.next !== undefined && typeof failure.next !== 'string')
	)
		return invalid();
	return ActionError.Refused({ message: failure.message, next: failure.next });
}

/**
 * Ask serve to run the action at `url` (`POST /<app>/<action>`), giving each
 * value it yields to `onYield`, and return what it returned. Aborting
 * `signal` stops reading, which stops the action at its next yield.
 */
async function call(
	url: string,
	input: Record<string, unknown>,
	{
		onYield,
		signal,
	}: { onYield?: (value: unknown) => unknown; signal?: AbortSignal } = {},
): Promise<Result<unknown, ActionError>> {
	const body = JSON.stringify(input);
	for await (const line of responseLines(url, body, signal)) {
		if (line.error !== null) return line;
		const frame = line.data;
		if (
			!isObject(frame) ||
			Object.hasOwn(frame, 'yielded') === Object.hasOwn(frame, 'answer')
		)
			return ActionError.Unreachable({
				message: 'Epicenter sent an invalid response line',
			});
		if ('answer' in frame) return answered(frame.answer);
		await onYield?.(frame.yielded);
	}
	return ActionError.Unreachable({
		message: 'Epicenter stopped answering before the action finished',
	});
}
