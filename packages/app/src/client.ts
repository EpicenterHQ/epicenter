/**
 * How an app's UI asks `epicenter serve` to run its actions (ADR-0860,
 * ADR-0866). A UI is a web page built from an app's `ui/` into `ui/dist/`
 * and served at `/<app>/`. Calls and runs.start use the same serve-owned
 * lifecycle at `POST /.runs/<app>/<action>/<id>` and stream events
 * (ADR-0879, ADR-0915). Observation can stop without cancelling the run.
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
import type { Result } from 'wellcrafted/result';
import type { ActionYield } from './action.ts';
import { ActionError } from './errors.ts';
import type { UploadedFile } from './field.ts';
import type { JsonValue } from './front-matter.ts';
import {
	createRun,
	runId,
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

export type ActionRun<A> = Run<JsonOf<ActionYield<A>>, ActionOutput<A>>;

declare const actionType: unique symbol;

/** Yielding calls may supply an `onYield` callback. */
type CallOptions<A> = [ActionYield<A>] extends [never]
	? []
	: [
			options?: {
				onYield?: (value: JsonOf<ActionYield<A>>) => unknown;
			},
		];

/**
 * The client for actions `A`: each action a function of its input, each
 * group under its word. An action that yields also takes `{ onYield }`,
 * which receives each value in order and may return a promise to wait for.
 * The call resolves to what the action returned or an action error. If
 * `onYield` throws or rejects, the call rejects with that error and stops
 * observing; the run continues on serve.
 * Run controls are separate: `runs.start(action, input)` keeps every action
 * name available at every depth.
 */
export type ActionCall<A> = ((
	...args: [
		...(Record<string, never> extends ActionInput<A>
			? [input?: RunInput<ActionInput<A>>]
			: [input: RunInput<ActionInput<A>>]),
		...CallOptions<A>,
	]
) => Promise<Result<ActionOutput<A>, ActionError>>) & {
	readonly [actionType]: A;
};

export type AppClient<A> = {
	readonly [K in keyof A]: A[K] extends (input: never) => unknown
		? ActionCall<A[K]>
		: AppClient<A[K]>;
};

type ActionAddress = { base: string; app: string; action: string };
const actionAddresses = new WeakMap<object, ActionAddress>();
function addressOf(action: object) {
	const address = actionAddresses.get(action);
	if (!address) throw new TypeError('Choose an action returned by connect()');
	return address;
}

/** Background execution is separate from the app's action names. */
export const runs = {
	start<A>(
		action: ActionCall<A>,
		...args: Record<string, never> extends ActionInput<A>
			? [input?: RunInput<ActionInput<A>>]
			: [input: RunInput<ActionInput<A>>]
	): ActionRun<A> {
		return createRun({
			...addressOf(action),
			id: runId(),
			input: (args[0] as Record<string, unknown> | undefined) ?? {},
			remember: true,
		}) as ActionRun<A>;
	},
	attach<A>(action: ActionCall<A>, id: string): ActionRun<A> {
		return createRun({
			...addressOf(action),
			id,
			remember: false,
		}) as ActionRun<A>;
	},
	pending<A>(action: ActionCall<A>): PendingRun[] {
		const address = addressOf(action);
		return pendingRuns({ app: address.app }).filter(
			(entry) => entry.action === address.action,
		);
	},
};

/**
 * A client for the app served at this page's first path segment. A page at
 * `/<app>/` uses `app` without repeating its name; pass `{ app }` when the
 * page does not identify it. Without either name, `connect` throws. `url`
 * defaults to this origin's `/`, where `epicenter serve` answers the UIs it
 * serves: an action is `POST <url>.runs/<app>/<words joined by .>/<id>`.
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
	const at = (words: string[]): unknown => {
		const action = new Proxy(() => {}, {
			get: (_, key) => {
				return typeof key === 'string' && key !== 'then'
					? at([...words, key])
					: undefined;
			},
			apply: async (_, __, [input, options]) => {
				if (words.length === 0)
					throw new Error(`Call one of ${name}'s actions, not the app`);
				if (options && 'signal' in options)
					return ActionError.Refused({
						message:
							'An action call takes no signal. Start it with runs.start(action, input) and stop it with run.cancel().',
					});
				return createRun({
					base,
					app: name,
					action: words.join('.'),
					id: runId(),
					input: input ?? {},
					remember: false,
				}).result({ onYield: options?.onYield });
			},
		});
		actionAddresses.set(action, { base, app: name, action: words.join('.') });
		return action;
	};
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
