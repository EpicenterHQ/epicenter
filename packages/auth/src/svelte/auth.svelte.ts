import { createSubscriber } from 'svelte/reactivity';
import type { Brand } from 'wellcrafted/brand';
import type { AuthClient, AuthState } from '../index.js';

/**
 * An auth client whose `state` tracks in Svelte.
 *
 * The brand marks the reads that track, and handing a raw core client to a
 * surface that needs them is a type error rather than a silently frozen
 * popover. Since the brand is a subtype, code that only reads once needs no
 * change.
 *
 * Application bootstrap reads the plain client once. This adapter belongs to
 * UI consumers that display changing identity or credential refusal; it does not
 * own application lifetime or select a replacement store.
 *
 * The parameter carries the wrapped client's own type through, because a
 * `CallbackAuthClient` that came out of here as a bare `AuthClient` would lose
 * `completeSignIn` in the type while keeping it at runtime, and the callback
 * route reads that member. It defaults to `AuthClient`, so every existing
 * annotation still means what it meant.
 */
export type ReactiveAuthClient<TClient extends AuthClient = AuthClient> =
	TClient & { readonly state: AuthState } & Brand<'ReactiveAuthClient'>;

/**
 * Bridge an auth client's state into Svelte's graph.
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
 * Core clients expose `getState()` for explicit reads. This adapter adds the
 * reactive `state` property and copies the client's methods and values.
 *
 * `createSubscriber` rather than a `$state.raw` shadow, and the difference is
 * not style. It is lazy: the subscription starts only while something is
 * actively reading inside a tracking context, and stops when the last reader
 * is destroyed. That is what lets one wrapped client serve both contracts at
 * once, because a boot-time read outside any effect subscribes to nothing and
 * simply calls `getState()`. A shadow would subscribe eagerly,
 * once per component instance, for that component's whole life.
 *
 */
export function fromAuth<TClient extends AuthClient>(
	authClient: TClient,
): ReactiveAuthClient<TClient> {
	const subscribeState = createSubscriber((update) =>
		authClient.onStateChange(update),
	);
	return {
		...authClient,
		get state() {
			subscribeState();
			return authClient.getState();
		},
	} as ReactiveAuthClient<TClient>;
}
