import { createSubscriber } from 'svelte/reactivity';
import type { Brand } from 'wellcrafted/brand';
import type { AuthClient, AuthState } from '../index.js';

/**
 * An auth client whose `state` tracks in Svelte.
 *
 * The brand marks the reads that track, and handing a raw core client to a
 * surface that needs them is a type error rather than a silently frozen
 * popover. The core client's `getState()` is replaced by the `state` getter;
 * all other members carry through.
 *
 * Application bootstrap can read `state` during component setup to capture an
 * Account once. The getter tracks only in a Svelte reactive context. This
 * adapter does not own application lifetime or select a replacement store.
 *
 * The parameter carries the wrapped client's own type through, so a
 * `CallbackAuthClient` keeps `completeSignIn` for its callback route.
 */
export type ReactiveAuthClient<TClient extends AuthClient = AuthClient> =
	Omit<TClient, 'getState' | 'state'> & { readonly state: AuthState } &
	Brand<'ReactiveAuthClient'>;

/**
 * Bridge an auth client's state into Svelte's graph.
 *
 * `from*` names the verb that builds the adapter. It was `reactive`, which read
 * as a property of the thing rather than as the verb that builds one.
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
 * Core clients expose `getState()` for explicit reads. This adapter exposes a
 * reactive `state` property in its place and copies the other property
 * descriptors, so live values such as the desktop deployment keep their getters.
 *
 * `createSubscriber` rather than a `$state.raw` shadow, and the difference is
 * not style. It is lazy: the subscription starts only while something is
 * actively reading inside a tracking context, and stops when the last reader
 * is destroyed. A read of `state` outside tracking returns a snapshot without
 * subscribing. A shadow would subscribe eagerly, once per component instance,
 * for that component's whole life.
 *
 */
export function fromAuth<TClient extends AuthClient>(
	authClient: TClient,
): ReactiveAuthClient<TClient> {
	const subscribeState = createSubscriber((update) =>
		authClient.onStateChange(update),
	);
	const descriptors = Object.getOwnPropertyDescriptors(authClient);
	Reflect.deleteProperty(descriptors, 'getState');
	return Object.defineProperties({}, {
		...descriptors,
		state: {
			enumerable: true,
			get() {
				subscribeState();
				return authClient.getState();
			},
		},
	}) as ReactiveAuthClient<TClient>;
}
