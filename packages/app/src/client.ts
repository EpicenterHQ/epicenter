/**
 * How an app's UI asks `epicenter serve` to run its actions (ADR-0860,
 * ADR-0866). A UI is a web page built from an app's `ui/` into `.cache/ui/`
 * and served at `/<app>/`; it asks over MCP like any agent, at the same
 * origin's `/`.
 *
 * ```ts
 * import { connect } from '@epicenter/app/client';
 * import type tasks from '../../epicenter.ts';
 *
 * const app = connect<typeof tasks>('tasks', {
 *   onUncommitted: ({ action, reason, sync }) =>
 *     toast(`${action} ran, but is not in the app's history: ${reason}. Run ${sync}`),
 * });
 * const [first] = await app.list();
 * if (first) await app.set({ path: first.path, done: true });
 * ```
 *
 * The client has the app's actions under the same words as the app: each
 * call checks its input and types what it returns in its JSON form, and
 * resolves to what the action returned or rejects with an `ActionError` when
 * it threw or did not run. An action that returned but whose changes could
 * not be committed still resolves; `onUncommitted` hears of it. The app is
 * imported as a type, and this file imports only types, so the UI's bundle
 * carries no app code.
 */
import type { JsonValue } from './front-matter.ts';

/** Why a call did not return: the action threw, nothing ran, or the server did not answer. */
export class ActionError extends Error {
	override name = 'ActionError';
	constructor(
		message: string,
		/** `threw` when the action threw, `error` when nothing ran, `transport` when no answer came back. */
		readonly kind: 'threw' | 'error' | 'transport',
		/** The answer's whole object, when there was one: `{ error }`, or `{ threw }` with `committed` or `uncommitted` when the action wrote before it threw. */
		readonly answer?: unknown,
	) {
		super(message);
	}
}

/**
 * Whether a call was refused because the text it quoted changed since it was
 * read: a collection's `edit` throws `{ name: 'Changed' }` then, and a UI says
 * so and reloads rather than overwriting the other change.
 */
export function changedElsewhere(error: unknown): boolean {
	const answer = error instanceof ActionError ? error.answer : undefined;
	const thrown = (answer as { threw?: { thrown?: { name?: unknown } } })?.threw
		?.thrown;
	return thrown?.name === 'Changed';
}

/** `T` flattened into one object type. */
type Flat<T> = { [K in keyof T]: T[K] } & {};

/**
 * `T` as it arrives through JSON: `undefined` is `null`, a property that may
 * be `undefined` may be absent, and a value with `toJSON` is what that
 * returns, as a `Date` is a string.
 */
type JsonOf<T> = unknown extends T
	? T
	: [T] extends [JsonValue]
		? T
		: T extends undefined | void
			? null
			: T extends string | number | boolean | null
				? T
				: T extends { toJSON(): infer J }
					? JsonOf<J>
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

/** The client for actions `A`: each action a function of its input, each group under its word. */
export type AppClient<A> = {
	readonly [K in keyof A]: A[K] extends (input: never) => unknown
		? (
				...input: Record<string, never> extends ActionInput<A[K]>
					? [input?: ActionInput<A[K]>]
					: [input: ActionInput<A[K]>]
			) => Promise<ActionOutput<A[K]>>
		: AppClient<A[K]>;
};

/** What `onUncommitted` hears: an action that returned, but whose changes are not in the app's history. */
type Uncommitted = {
	/** The action's words, one space apart: `set`, `words add`. */
	action: string;
	/** What it returned, which the call also resolves to. */
	returned: unknown;
	/** Why its changes were not committed. */
	reason: string;
	/** The command that commits them: `epicenter sync <app>`. */
	sync: string;
};

let nextId = 1;

/**
 * A client for app `app` on the server at `url`: by default this origin's
 * `/`, where `epicenter serve` answers the UIs it serves. `onUncommitted` is
 * called, before the call resolves, for each call whose action returned but
 * whose changes could not be committed, so the UI can say so rather than
 * report them saved.
 */
export function connect<App extends { actions: object }>(
	app: string,
	{
		url = '/',
		onUncommitted,
	}: { url?: string; onUncommitted: (uncommitted: Uncommitted) => void },
): AppClient<App['actions']> {
	const at = (words: string[]): unknown =>
		new Proxy(() => {}, {
			get: (_, key) =>
				typeof key === 'string' && key !== 'then'
					? at([...words, key])
					: undefined,
			apply: async (_, __, [input]) => {
				if (words.length === 0)
					throw new Error(`Call one of ${app}'s actions, not the app`);
				const answer = await call(url, [app, ...words].join('_'), input ?? {});
				if (answer.uncommitted)
					onUncommitted({
						action: words.join(' '),
						returned: answer.returned,
						reason: answer.uncommitted.message,
						sync: answer.uncommitted.next,
					});
				return answer.returned;
			},
		});
	return at([]) as AppClient<App['actions']>;
}

/** Ask the server at `url` to run the MCP tool `name`, and return the answer of an action that returned. */
async function call(
	url: string,
	name: string,
	input: Record<string, unknown>,
): Promise<{
	returned: unknown;
	uncommitted?: { message: string; next: string };
}> {
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
				id: nextId++,
				method: 'tools/call',
				params: { name, arguments: input },
			}),
		});
	} catch (cause) {
		throw new ActionError(
			`Could not reach Epicenter: ${String(cause)}`,
			'transport',
		);
	}
	if (!response.ok)
		throw new ActionError(
			`Epicenter answered ${response.status} ${response.statusText}`,
			'transport',
		);
	const message = (await response.json()) as {
		result?: {
			isError?: boolean;
			content?: { type: string; text?: string }[];
			structuredContent?: Record<string, unknown>;
		};
		error?: { message: string };
	};
	if (message.error)
		throw new ActionError(message.error.message, 'transport', message);
	const result = message.result ?? {};
	const answer = result.structuredContent ?? {};
	if (!result.isError && 'returned' in answer)
		return answer as Awaited<ReturnType<typeof call>>;
	const text =
		result.content?.find((part) => part.type === 'text')?.text ??
		JSON.stringify(answer);
	throw new ActionError(text, 'threw' in answer ? 'threw' : 'error', answer);
}
