/**
 * How an app's UI asks `epicenter serve` to run its actions (ADR-0860,
 * ADR-0866). A UI is a web page built from an app's `ui/` into `ui/dist/`
 * and served at `/<app>/`; it runs an action at `POST /<app>/<action>` on the
 * same origin, and reads the response's JSON lines: each value the action
 * yields, then its answer (ADR-0879). Agents ask over MCP instead.
 *
 * The client has the app's actions under the same words as the app. Each
 * call checks its input, types what it returns in its JSON form, and resolves
 * to a Result: what the action returned, or an `ActionError` saying why not.
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
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ActionYield } from './action.ts';
import type { FileError } from './errors.ts';
import type { JsonValue } from './front-matter.ts';

/** The ways serve answers without a value, or does not answer. */
const CallError = defineErrors({
	/**
	 * The action ran and threw something other than a `FileError`. `thrown`
	 * is the tagged error it threw, kept whole, when it threw one.
	 */
	Threw: ({
		message,
		thrown,
	}: {
		message: string;
		thrown?: { name: string; message: string } & Record<string, unknown>;
	}) => ({ message, thrown }),
	/** Nothing ran: the action, its input, or the app was wrong. `next` says what to do instead, when serve knows. */
	Refused: ({ message, next }: { message: string; next?: string }) => ({
		message,
		next,
	}),
	/** No answer came back: serve could not be reached, or answered something other than an answer. */
	Unreachable: ({ message }: { message: string }) => ({ message }),
	/** The caller stopped the call with its `signal`. The action stopped at its next yield, and what it wrote is committed. */
	Stopped: ({ message }: { message: string }) => ({ message }),
});

/**
 * Why a call did not return, told apart by `name`:
 *
 * - `Changed`: what the call changes changed since it was read (a collection
 *   `edit` whose quoted text is gone). Show the latest rather than overwrite it.
 * - `Missing`: there is no file at the path asked for; it was deleted, here or elsewhere.
 * - `Threw`: the action threw anything else.
 * - `Refused`: nothing ran, because the call was wrong.
 * - `Unreachable`: serve did not answer.
 * - `Stopped`: the caller stopped a yielding call with its `signal`.
 */
export type ActionError = InferErrors<typeof CallError> | FileError;

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

/** What a call of action `A` may take after its input, when `A` yields: `onYield`, and a `signal` that stops it. */
type CallOptions<A> = [ActionYield<A>] extends [never]
	? []
	: [
			options?: {
				onYield?: (value: JsonOf<ActionYield<A>>) => void;
				signal?: AbortSignal;
			},
		];

/**
 * The client for actions `A`: each action a function of its input, each
 * group under its word. An action that yields also takes `{ onYield }`,
 * which receives each value as the action yields it, and `{ signal }`,
 * which stops it at its next yield; the call still resolves to what the
 * action returned, or `Stopped`.
 */
export type AppClient<A> = {
	readonly [K in keyof A]: A[K] extends (input: never) => unknown
		? (
				...args: [
					...(Record<string, never> extends ActionInput<A[K]>
						? [input?: ActionInput<A[K]>]
						: [input: ActionInput<A[K]>]),
					...CallOptions<A[K]>,
				]
			) => Promise<Result<ActionOutput<A[K]>, ActionError>>
		: AppClient<A[K]>;
};

/**
 * A client for the app served at this page's first path segment. A page at
 * `/<app>/` uses `app` without repeating its name; pass `{ app }` when the
 * page does not identify it. Without either name, `connect` throws. `url`
 * defaults to this origin's `/`, where `epicenter serve` answers the UIs it
 * serves: an action is `POST <url><app>/<words joined by .>`.
 */
export function connect<App extends { actions: object }>(
	{ app, url = '/' }: { app?: string; url?: string } = {},
): AppClient<App['actions']> {
	const name = app ?? appOfPage();
	const base = url.endsWith('/') ? url : `${url}/`;
	const at = (words: string[]): unknown =>
		new Proxy(() => {}, {
			get: (_, key) =>
				typeof key === 'string' && key !== 'then'
					? at([...words, key])
					: undefined,
			apply: async (_, __, [input, options]) => {
				if (words.length === 0)
					throw new Error(`Call one of ${name}'s actions, not the app`);
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
 * Each JSON value in a response of JSON lines, as its line arrives. Read with
 * `getReader`, since Safari cannot iterate a stream with `for await`.
 */
async function* jsonLines(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffered = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			buffered += decoder.decode(value, { stream: !done });
			let end = buffered.indexOf('\n');
			while (end >= 0) {
				const text = buffered.slice(0, end);
				buffered = buffered.slice(end + 1);
				if (text.trim()) yield JSON.parse(text) as unknown;
				end = buffered.indexOf('\n');
			}
			if (done) return;
		}
	} finally {
		reader.releaseLock();
	}
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
	}: { onYield?: (value: unknown) => void; signal?: AbortSignal } = {},
): Promise<Result<unknown, ActionError>> {
	let message: { answer?: unknown } = {};
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input),
			signal,
		});
		if (!response.ok || !response.body)
			return CallError.Unreachable({
				message: `Epicenter answered ${response.status} ${response.statusText}`,
			});
		for await (const line of jsonLines(response.body)) {
			const value = line as { yielded?: unknown; answer?: unknown };
			if ('yielded' in value) onYield?.(value.yielded);
			else if ('answer' in value) message = value;
		}
	} catch (cause) {
		if (signal?.aborted) return CallError.Stopped({ message: 'Stopped' });
		return CallError.Unreachable({
			message: `Could not reach Epicenter: ${String(cause)}`,
		});
	}
	if (!('answer' in message))
		return CallError.Unreachable({
			message: 'Epicenter stopped answering before the action finished',
		});
	const answer = (message.answer ?? {}) as {
		returned?: unknown;
		threw?: {
			message: string;
			thrown?: { name: string; message: string } & Record<string, unknown>;
		};
		error?: { message: string; next?: string };
	};
	if ('returned' in answer) return Ok(answer.returned);
	if (answer.threw) {
		const { thrown } = answer.threw;
		if (thrown?.name === 'Changed' || thrown?.name === 'Missing')
			return Err(thrown as FileError);
		return CallError.Threw(answer.threw);
	}
	if (answer.error)
		return CallError.Refused({
			message: answer.error.message,
			next: answer.error.next,
		});
	return CallError.Unreachable({
		message: `Epicenter answered without an answer: ${JSON.stringify(answer)}`,
	});
}
