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
 * Result: what the action returned, the action's own error,
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
import type { NotStarted, Threw, Unreachable } from './answer.ts';
import { actionPath, postAction } from './call.ts';
import type { Epicenter } from './epicenter.ts';

export type {
	ActionError,
	NotStarted,
	Threw,
	Unreachable,
} from './answer.ts';
export { timeId } from './time.ts';

/** What action `A` takes from a caller. */
export type ActionInput<A> = A extends (input: infer In) => unknown
	? In
	: never;

type ReturnedBy<A> = A extends (input: never) => infer Out
	? Awaited<Out>
	: never;

/** What action `A` returns to a page: what its `run` returned. */
export type ActionOutput<A> = Extract<
	Exclude<ReturnedBy<A>, Err<never>>,
	Ok<unknown>
>['data'];

type ReturnedError<A> = Exclude<
	Extract<ReturnedBy<A>, Err<unknown>>['error'],
	null
>;

/** What a call of action `A` resolves to. */
type Answered<A> = Promise<
	Result<ActionOutput<A>, ReturnedError<A> | NotStarted | Threw | Unreachable>
>;

/** How a page listens to an action's updates. */
type CallOptions<A> = {
	onUpdate?: (value: ActionUpdate<A>) => unknown;
};

/** An action's input argument, which may be left out when every key is optional. */
type InputArg<A> =
	Record<string, never> extends ActionInput<A>
		? [input?: ActionInput<A>]
		: [input: ActionInput<A>];

/** `{ onUpdate }`, for an action that sends updates. */
type OptionsArg<A> = [ActionUpdate<A>] extends [never]
	? []
	: [options?: CallOptions<A>];

/**
 * One action as a page calls it: a function of its input, and of
 * `{ onUpdate }` when the action sends updates. One that sends none takes
 * one argument, so a helper that takes a function of one argument, such as
 * Wellcrafted's `resultMutations`, accepts it.
 */
export type ActionCall<A> = (
	...args: [...InputArg<A>, ...OptionsArg<A>]
) => Answered<A>;

type AppsOf<H> = H extends Epicenter<infer TApps> ? TApps : never;

/** The client for the home `H`: each app, then each of its actions, by name. */
export type Client<H> = {
	readonly [A in keyof AppsOf<H>]: {
		readonly [K in keyof AppsOf<H>[A]['actions']]: ActionCall<
			AppsOf<H>[A]['actions'][K]
		>;
	};
};

/**
 * A Proxy whose every string key but `then` is `make(key)`, made once per
 * key so the same name is the same value, and which has nothing else.
 */
function lazyKeys<T>(make: (name: string) => T) {
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
	const base = url.replace(/\/$/, '');
	return lazyKeys((app) =>
		lazyKeys(
			(action) =>
				(
					input?: unknown,
					options?: { onUpdate?: (value: unknown) => unknown },
				) =>
					postAction(
						`${base}${actionPath(app, action)}`,
						JSON.stringify(input ?? {}),
						{ onUpdate: options?.onUpdate },
					),
		),
	) as unknown as Client<H>;
}
