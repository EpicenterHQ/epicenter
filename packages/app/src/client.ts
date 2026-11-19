/**
 * How a page calls a home's actions through serve:
 *
 * ```ts
 * import { connect } from '@epicenter/app/client';
 * import type home from '../../../../epicenter.ts';
 *
 * const epicenter = connect<typeof home>();
 * const idea = await epicenter.flights.idea({ id: 'tokyo-spring' });
 * await epicenter.flights.daily({}, { onUpdate: (update) => show(update) });
 * ```
 *
 * The home is imported as a type, so the page's bundle carries no app code.
 * Each call posts its input to `/actions/<app>/<action>` and resolves to a
 * Result: what the action returned in its JSON form, the action's own error,
 * or one of the platform's: `NotStarted` (it never began), `Threw` (it began
 * and threw) or `Unreachable` (the outcome is unknown). An error does not
 * say what persisted; a page rereads its records to learn that.
 *
 * The client is a Proxy, and neither it nor an app on it answers `then`, so
 * `await connect()` is the client itself and never a call. An app or action
 * named `then` cannot be reached this way.
 */
import type { Err, Ok, Result } from 'wellcrafted/result';
import type { ActionUpdate } from './action.ts';
import { readAnswer } from './answer.ts';
import type { App, Epicenter } from './epicenter.ts';
import {
	ActionError,
	type NotStarted,
	type Threw,
	type Unreachable,
} from './errors.ts';
import type { JsonValue } from './front-matter.ts';
import type { Answer } from './result.ts';

export { partitionResults } from 'wellcrafted/result';
export type {
	ActionError,
	NotStarted,
	Threw,
	Unreachable,
} from './errors.ts';
export { timeId } from './time.ts';

/** `T` flattened into one object type. */
type Flat<T> = { [K in keyof T]: T[K] } & {};

/**
 * `T` as it arrives through JSON: `undefined` is `null`, and a property that
 * may be `undefined` may be absent.
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

/** What action `A` takes from a caller. */
export type ActionInput<A> = A extends (input: infer In) => unknown
	? In
	: never;

type ReturnedBy<A> = A extends (input: never) => infer Out
	? Awaited<Out>
	: never;

/** What action `A` returns to a page, in its JSON form. */
export type ActionOutput<A> = JsonOf<
	Extract<Exclude<ReturnedBy<A>, Err<never>>, Ok<unknown>>['data']
>;

type ReturnedError<A> = JsonOf<
	Exclude<Extract<ReturnedBy<A>, Err<unknown>>['error'], null>
>;

/** What a call of action `A` resolves to. */
type Answered<A> = Promise<
	Result<ActionOutput<A>, ReturnedError<A> | NotStarted | Threw | Unreachable>
>;

/** How a page listens to an action's updates. */
type CallOptions<A> = {
	onUpdate?: (value: JsonOf<ActionUpdate<A>>) => unknown;
};

/**
 * One action as a page calls it: a function of its input, and of
 * `{ onUpdate }` when the action sends updates. An action whose every key is
 * optional may be called with no input. Each case is a whole function type,
 * so a helper that takes a function of one argument, such as Wellcrafted's
 * `resultMutations`, accepts one that sends no updates.
 */
export type ActionCall<A> = [ActionUpdate<A>] extends [never]
	? Record<string, never> extends ActionInput<A>
		? (input?: ActionInput<A>) => Answered<A>
		: (input: ActionInput<A>) => Answered<A>
	: Record<string, never> extends ActionInput<A>
		? (input?: ActionInput<A>, options?: CallOptions<A>) => Answered<A>
		: (input: ActionInput<A>, options?: CallOptions<A>) => Answered<A>;

type AppsOf<H> = H extends Epicenter<infer TApps> ? TApps : never;

/** The client for the home `H`: each app, then each of its actions, by name. */
export type Client<H> = {
	readonly [A in keyof AppsOf<H>]: AppsOf<H>[A] extends App
		? {
				readonly [K in keyof AppsOf<H>[A]['actions']]: ActionCall<
					AppsOf<H>[A]['actions'][K]
				>;
			}
		: never;
};

/** Tell the page about a listener's failure without ending the call. */
function report(cause: unknown) {
	const page = globalThis as { reportError?: (cause: unknown) => void };
	if (page.reportError) page.reportError(cause);
	else queueMicrotask(() => Promise.reject(cause));
}

/** Call one action and read its answer. A call that reaches no answer is `Unreachable`. */
async function post(
	url: string,
	input: unknown,
	onUpdate?: (value: unknown) => unknown,
): Promise<Answer> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input ?? {}),
		});
	} catch {
		// A failed fetch looks the same whether the request never left or the
		// connection dropped after serve took it, so the outcome is unknown.
		return ActionError.Unreachable({
			message:
				'serve could not be reached, or the connection dropped; the action may have run',
		});
	}
	return readAnswer(response, (update) => {
		try {
			const heard = onUpdate?.(update);
			if (heard instanceof Promise) heard.catch(report);
		} catch (cause) {
			report(cause);
		}
	});
}

/**
 * A Proxy whose every string key but `then` is `make(key)`, made once per
 * key so the same name is the same value, and which has nothing else.
 */
function namesOf<T>(make: (name: string) => T) {
	const made = new Map<string, T>();
	return new Proxy(Object.create(null) as Record<string, T>, {
		get(_target, key) {
			if (typeof key !== 'string' || key === 'then') return undefined;
			if (!made.has(key)) made.set(key, make(key));
			return made.get(key);
		},
	});
}

/**
 * A client for the home whose `epicenter.ts` default export is `H`. `url` is
 * where serve answers, this origin's `/` by default: an action is
 * `POST <url>actions/<app>/<action>`.
 */
export function connect<H extends Epicenter>({
	url = '/',
}: {
	url?: string;
} = {}): Client<H> {
	const base = url.endsWith('/') ? url : `${url}/`;
	return namesOf((app) =>
		namesOf(
			(action) =>
				(
					input?: unknown,
					options?: { onUpdate?: (value: unknown) => unknown },
				) =>
					post(
						`${base}actions/${encodeURIComponent(app)}/${encodeURIComponent(action)}`,
						input,
						options?.onUpdate,
					),
		),
	) as unknown as Client<H>;
}
