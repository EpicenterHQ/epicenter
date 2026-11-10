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
 * const app = connect<typeof tasks>('tasks');
 * const rows = await app.tasks.list();
 * await app.tasks.set({ path: rows[0].path, done: true });
 * ```
 *
 * The client has the app's actions under the same words as the app: each
 * call checks its input and types what it returns, and resolves to what the
 * action returned or rejects with an `ActionError` when it threw or did not
 * run. The app is imported as a type, so the UI's bundle carries no app
 * code; this file imports nothing, so the bundle carries only it. An action
 * whose last word is `then` cannot be called from here, since awaiting an
 * object reads its `then`.
 */

/** Why a call did not return: the action threw, nothing ran, or the server did not answer. */
export class ActionError extends Error {
	override name = 'ActionError';
	constructor(
		message: string,
		/** `threw` when the action threw, `error` when nothing ran, `transport` when no answer came back. */
		readonly kind: 'threw' | 'error' | 'transport',
		/** The answer's whole object, when there was one: `{ threw }` or `{ error }`. */
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

/** The client for actions `A`: each action a function of its input, each group under its word. */
export type AppClient<A> = {
	readonly [K in keyof A]: A[K] extends (input: infer In) => infer Out
		? (
				...input: Record<string, never> extends In ? [input?: In] : [input: In]
			) => Promise<Awaited<Out>>
		: AppClient<A[K]>;
};

let nextId = 1;

/**
 * A client for app `app` on the server at `url`: by default this origin's
 * `/`, where `epicenter serve` answers the UIs it serves.
 */
export function connect<App extends { actions: object }>(
	app: string,
	{ url = '/' }: { url?: string } = {},
): AppClient<App['actions']> {
	const at = (words: string[]): unknown =>
		new Proxy(() => {}, {
			get: (_, key) =>
				typeof key === 'string' && key !== 'then'
					? at([...words, key])
					: undefined,
			apply: (_, __, [input]) => {
				if (words.length === 0)
					throw new Error(`Call one of ${app}'s actions, not the app`);
				return call(url, [app, ...words].join('_'), input ?? {});
			},
		});
	return at([]) as AppClient<App['actions']>;
}

/** Ask the server at `url` to run the MCP tool `name`. */
async function call(
	url: string,
	name: string,
	input: Record<string, unknown>,
): Promise<unknown> {
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
	if (!result.isError && 'returned' in answer) return answer.returned;
	const text =
		result.content?.find((part) => part.type === 'text')?.text ??
		JSON.stringify(answer);
	throw new ActionError(text, 'threw' in answer ? 'threw' : 'error', answer);
}
