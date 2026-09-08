import { createSubscriber } from 'svelte/reactivity';
import type { Brand } from 'wellcrafted/brand';
import type { AuthClient } from '../index.js';

/**
 * An auth client whose `state` and `connection.status` track in Svelte.
 *
 * The brand marks the reads that track, and handing a raw core client to a
 * surface that needs them is a type error rather than a silently frozen
 * popover. Since the brand is a subtype, code that only reads once needs no
 * change.
 *
 * A boot node wants the tracking one (ADR-0350). Its `auth.state` read is what
 * replaced the reload gate: a sign-out flips its `{#if}`, a different Account object
 * remounts its `{#key}`, and `signed-in` degrading to `reauth-required` moves
 * neither, so a person keeps working while sync reports the refusal.
 *
 * The parameter carries the wrapped client's own type through, because a
 * `CallbackAuthClient` that came out of here as a bare `AuthClient` would lose
 * `completeSignIn` in the type while keeping it at runtime, and the callback
 * route reads that member. It defaults to `AuthClient`, so every existing
 * annotation still means what it meant.
 */
export type ReactiveAuthClient<TClient extends AuthClient = AuthClient> =
	TClient & Brand<'ReactiveAuthClient'>;

/**
 * Bridge an auth client's two external facts into Svelte's graph.
 *
 * `from*` because that is what every Svelte adapter in this repository is
 * called: `fromData` wraps a store. It was
 * `reactive` while it was the only one, which read as a property of the thing
 * rather than as the verb that builds one.
 *
 * The whole of what this module does, and the whole of what it should: a
 * client is composed somewhere that has no framework, and this adapts one.
 * There used to be three exported constructors here, one per composition an
 * app happened to use, each of which was a core constructor with this call
 * wrapped around it. That made the framework wrapper the door to conventions
 * that have nothing to do with a framework, so `@epicenter/auth` could not
 * hand a plain page the hosted browser convention and a Svelte app could not
 * wrap a client this module had not anticipated. One function takes any of
 * them.
 *
 * It spreads the client once and re-declares two getters, so a client whose
 * OTHER members are live getters loses them. Every client in this package
 * states the rest as values, which is what makes the spread safe.
 *
 * `createSubscriber` rather than a `$state.raw` shadow, and the difference is
 * not style. It is lazy: the subscription starts only while something is
 * actively reading inside a tracking context, and stops when the last reader
 * is destroyed. That is what lets one wrapped client serve both contracts at
 * once, because a boot-time read outside any effect subscribes to nothing and
 * simply falls through to the live getter. A shadow would subscribe eagerly,
 * once per component instance, for that component's whole life.
 *
 * Both facts are wrapped uniformly even though not every client can change
 * either one. The hosted session clients report a
 * constant `connected` with an `onChange` that never fires, and the desktop
 * broker also publishes credential refusal and retirement. Uniformity is the point: the brand
 * promises that reads track IF the underlying client ever changes, which is a
 * promise every client can keep.
 */
export function fromAuth<TClient extends AuthClient>(
	authClient: TClient,
): ReactiveAuthClient<TClient> {
	const subscribeState = createSubscriber((update) =>
		authClient.onStateChange(update),
	);
	const connection = authClient.connection;
	const subscribeConnection = createSubscriber((update) =>
		connection.onChange(update),
	);
	return {
		...authClient,
		get state() {
			subscribeState();
			return authClient.state;
		},
		connection: {
			...connection,
			get status() {
				subscribeConnection();
				return connection.status;
			},
		},
	} as ReactiveAuthClient<TClient>;
}
