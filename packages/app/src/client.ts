/**
 * How an app's UI asks `epicenter serve` to run its actions (ADR-0860,
 * ADR-0866). A UI is a web page built from an app's `ui/` into `ui/dist/`
 * and served at `/<app>/`; it asks over MCP like any agent, at the same
 * origin's `/`.
 *
 * The client has the app's actions under the same words as the app. Each
 * call checks its input, types what it returns in its JSON form, and resolves
 * to a Result: what the action returned, or an `ActionError` saying why not.
 * A view lists the actions it watches and makes with Wellcrafted
 * (ADR-0661), and the layout's `createQueryClient` refreshes what it shows:
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
 *
 * An action whose `run` yields (ADR-0879) takes `{ onYield }` after its input;
 * each value it yields reaches `onYield` as it runs, and the call resolves
 * with the same Result as without it:
 *
 * ```ts
 * const said = await vocab.chat.say({ message }, { onYield: (token) => (draft += token) });
 * ```
 */
import { MutationCache, QueryClient } from '@tanstack/query-core';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ActionYield } from './action.ts';
import type { FileError } from './errors.ts';
import type { JsonValue } from './front-matter.ts';

/** The `_meta` key a call sets to `true` to be sent its action's yields as it runs. */
export const YIELDS_META = 'epicenter/yields';

/** The `_meta` key of a progress notification that holds one value the action yielded. */
export const YIELD_META = 'epicenter/yield';

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

/** What a call of action `A` may take after its input: `onYield`, when `A` yields. */
type CallOptions<A> = [ActionYield<A>] extends [never]
	? []
	: [options?: { onYield?: (value: JsonOf<ActionYield<A>>) => void }];

/** The client for actions `A`: each action a function of its input, each group under its word. */
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

let nextId = 1;

/**
 * A client for the app served at this page's first path segment. A page at
 * `/<app>/` uses `app` without repeating its name; pass `{ app }` when the
 * page does not identify it. Without either name, `connect` throws. `url`
 * defaults to this origin's `/`, where `epicenter serve` answers the UIs it
 * serves.
 */
export function connect<App extends { actions: object }>(
	{ app, url = '/' }: { app?: string; url?: string } = {},
): AppClient<App['actions']> {
	const name = app ?? appOfPage();
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
					url,
					[name, ...words].join('_'),
					input ?? {},
					options?.onYield,
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
 * The QueryClient for an app's view, made once where the view starts. Every
 * write refreshes every read the view shows, and the write is done only once
 * they are. Reads also refresh when the view is shown again (its tab or app
 * comes back), so what an agent or another device changed appears when you
 * look. Nothing refreshes on a timer. A read that fails is not retried; the
 * next refresh asks again.
 */
export function createQueryClient(): QueryClient {
	const client: QueryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
		mutationCache: new MutationCache({
			onSettled: () => client.invalidateQueries(),
		}),
	});
	return client;
}

/**
 * Ask the server at `url` to run the MCP tool `name`, and return what its
 * action returned. With `onYield`, the call asks for the action's yields:
 * serve answers with an event stream, a progress notification per yield and
 * the result last, and `onYield` gets each yield in order.
 */
async function call(
	url: string,
	name: string,
	input: Record<string, unknown>,
	onYield?: (value: unknown) => void,
): Promise<Result<unknown, ActionError>> {
	const id = nextId++;
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id,
				method: 'tools/call',
				params: {
					name,
					arguments: input,
					...(onYield && {
						_meta: { progressToken: id, [YIELDS_META]: true },
					}),
				},
			}),
		});
	} catch (cause) {
		return CallError.Unreachable({
			message: `Could not reach Epicenter: ${String(cause)}`,
		});
	}
	if (!response.ok)
		return CallError.Unreachable({
			message: `Epicenter answered ${response.status} ${response.statusText}`,
		});
	let message: Reply | undefined;
	try {
		message = response.headers
			.get('content-type')
			?.startsWith('text/event-stream')
			? await readEvents(response, id, onYield)
			: ((await response.json()) as Reply);
	} catch (cause) {
		return CallError.Unreachable({
			message: `Epicenter stopped answering: ${String(cause)}`,
		});
	}
	if (!message)
		return CallError.Unreachable({
			message: 'Epicenter stopped answering before the action returned',
		});
	if (message.error)
		return CallError.Unreachable({ message: message.error.message });
	const answer = (message.result?.structuredContent ?? {}) as {
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

/** A JSON-RPC message serve sends back: the call's response, or a notification while it runs. */
type Reply = {
	id?: number;
	method?: string;
	params?: { _meta?: Record<string, unknown> };
	result?: { structuredContent?: Record<string, unknown> };
	error?: { message: string };
};

/**
 * Read serve's event stream for call `id`: give each yield in a progress
 * notification to `onYield`, in order, and return the response, or nothing
 * when the stream ends first. Each event's data is one JSON-RPC message.
 */
async function readEvents(
	response: Response,
	id: number,
	onYield?: (value: unknown) => void,
): Promise<Reply | undefined> {
	if (!response.body) return undefined;
	// A reader, not `for await`, which Safari's streams lack.
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		let end = buffer.indexOf('\n\n');
		while (end !== -1) {
			const data = buffer
				.slice(0, end)
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
				.join('\n');
			buffer = buffer.slice(end + 2);
			end = buffer.indexOf('\n\n');
			if (!data) continue;
			const message = JSON.parse(data) as Reply;
			if (message.id === id) {
				void reader.cancel();
				return message;
			}
			const meta = message.params?._meta;
			if (message.method === 'notifications/progress' && meta && YIELD_META in meta)
				onYield?.(meta[YIELD_META]);
		}
		if (done) return undefined;
	}
}
