/**
 * How an app's UI asks `epicenter serve` to run its actions (ADR-0860,
 * ADR-0866). A UI is a web page built from an app's `ui/` into `ui/dist/`
 * and served at `/apps/<app>/`. A call is `POST /actions/<app>/<action>`
 * with the input as JSON (ADR-0967); the answer is JSON lines,
 * `{"update": value}` for each update the action sends and then
 * `{"answer": {data, error}}` (ADR-0930, ADR-0953).
 *
 * The client calls an action by its name in the app: `app.call('add', input)`
 * runs it now, and `app.action('add')` is the same call as a function, for a
 * query or a mutation to hold. Each call types its input and what it returns
 * in its JSON form, and resolves to
 * a Result: what the action returned, the action's own error, or one of the
 * platform's: `NotStarted` (it never began), `Threw` (it began and threw), or
 * `Unreachable` (the outcome is unknown). Error names do not say what
 * persisted.
 * A UI lists the actions it watches and makes with Wellcrafted (ADR-0661),
 * and the QueryClient its layout makes refreshes what it shows:
 *
 * ```ts
 * import { connect } from '@epicenter/app/client';
 * import { resultMutations, resultQueries } from 'wellcrafted/query';
 * import type tasks from '../../../epicenter.ts';
 *
 * const app = connect<typeof tasks>();
 * export const taskReads = resultQueries(['tasks'], {
 *   list: app.action('list'),
 *   get: app.action('get'),
 * });
 * export const taskWrites = resultMutations(['tasks'], { patch: app.action('patch') });
 *
 * const list = createQuery(() => taskReads.list());
 * const patchTask = createMutation(() => taskWrites.patch);
 * patchTask.mutate({ id, done: true });
 * await app.call('add', { title: 'Call the bank' });
 * ```
 *
 * The app is imported as a type, so the UI's bundle carries no app code.
 * `connect` reads the actions from what the app's function returns.
 */
import type { Err, Ok, Result } from 'wellcrafted/result';
import type { ActionUpdate } from './action.ts';
import { type Answer, readAnswer } from './answer.ts';
import {
	ActionError,
	type NotStarted,
	type Threw,
	type Unreachable,
} from './errors.ts';
import type { JsonValue } from './front-matter.ts';

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

/** What action `A` takes from a caller: `ActionInput<Actions['patch']>`, where `Actions` is `ReturnType<typeof app>['actions']`. */
export type ActionInput<A> = A extends (input: infer In) => unknown
	? In
	: never;

/** What action `A` returns to a client, in its JSON form: `ActionOutput<Actions['get']>`. */
type ReturnedBy<A> = A extends (input: never) => infer Out
	? Awaited<Out>
	: never;
export type ActionOutput<A> = JsonOf<
	Extract<Exclude<ReturnedBy<A>, Err<never>>, Ok<unknown>>['data']
>;
type ReturnedError<A> = JsonOf<
	Exclude<Extract<ReturnedBy<A>, Err<unknown>>['error'], null>
>;

/** How a page listens to an action that sends updates. */
type CallOptions<A> = {
	onUpdate?: (value: JsonOf<ActionUpdate<A>>) => unknown;
};

/**
 * One action of an app, as a page calls it: a function of its input. An
 * action that sends updates also takes `{ onUpdate }`, which receives each one
 * in order. One that sends none takes its input alone, unlike the library's
 * `Action`, which takes options on every action: a page hands a call to
 * helpers such as wellcrafted's `resultMutations`, which take a function of
 * one argument. The call resolves to what
 * the action returned, or exactly the errors it can: the ones the action
 * returns, and `NotStarted`, `Threw` and `Unreachable`, which only Epicenter
 * answers. A name the action cannot return is not in the union, so a page
 * that compares it gets a compile error. An update reports and is never the
 * answer; what `onUpdate` returns is not awaited, and what it throws is
 * reported to the page and does not end the call. The action runs to its end
 * on serve whether or not the page stays to hear it.
 */
export type ActionCall<A> = (
	...args: [
		...(Record<string, never> extends ActionInput<A>
			? [input?: ActionInput<A>]
			: [input: ActionInput<A>]),
		...([ActionUpdate<A>] extends [never] ? [] : [options?: CallOptions<A>]),
	]
) => Promise<
	Result<ActionOutput<A>, ReturnedError<A> | NotStarted | Threw | Unreachable>
>;

/** The client for actions `A`, an app's `actions`, each called by its name. */
export type AppClient<A> = {
	/** Call the action `name` now: `app.call('add', { title })`. */
	call<K extends keyof A & string>(
		name: K,
		...args: Parameters<ActionCall<A[K]>>
	): ReturnType<ActionCall<A[K]>>;
	/** The action `name` as a function, the same call each time: `app.action('add')`. */
	action<K extends keyof A & string>(name: K): ActionCall<A[K]>;
};

/** Tell the page about a listener's failure without ending the call. */
function report(cause: unknown) {
	const page = globalThis as { reportError?: (cause: unknown) => void };
	if (page.reportError) page.reportError(cause);
	else queueMicrotask(() => Promise.reject(cause));
}

/**
 * Call one action and read its answer (`answer.ts`). A call that reaches no
 * answer is `Unreachable`: the action may still be running or may have
 * finished, so the page rereads its records.
 */
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
				'Epicenter could not be reached, or the connection dropped; the action may have run',
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
 * A client for the app whose page this is. A page under `/apps/<app>/` uses
 * `app` without repeating its name; pass `{ app }` when the page does not
 * identify it. Without either name, `connect` throws. `url` defaults to this
 * origin's `/`, where `epicenter serve` answers the pages it serves: an
 * action is `POST <url>actions/<app>/<action>`.
 */
export function connect<App extends (given: never) => { actions: object }>({
	app,
	url = '/',
}: {
	app?: string;
	url?: string;
} = {}): AppClient<ReturnType<App>['actions']> {
	const name = app ?? appOfPage();
	const base = `${url.endsWith('/') ? url : `${url}/`}actions/${encodeURIComponent(name)}/`;
	const call = (
		action: string,
		input?: unknown,
		options?: { onUpdate?: (value: unknown) => unknown },
	) => post(`${base}${encodeURIComponent(action)}`, input, options?.onUpdate);
	// Each action's input and answer are typed by the app; on the wire every
	// call is the same request, so these untyped functions stand in for them.
	return {
		call,
		action: (action: string) => (input?: unknown, options?: object) =>
			call(action, input, options),
	} as unknown as AppClient<ReturnType<App>['actions']>;
}

/** The app whose `/apps/<app>/` serves this page. */
function appOfPage(): string {
	const page = globalThis as {
		document?: { baseURI: string };
		location?: { href: string };
	};
	const href = page.document?.baseURI ?? page.location?.href;
	const [, apps, segment] = href ? new URL(href).pathname.split('/') : [];
	if (apps !== 'apps' || !segment)
		throw new Error(
			'connect() needs a page served under /apps/<app>/ or an explicit { app }',
		);
	return decodeURIComponent(segment);
}
