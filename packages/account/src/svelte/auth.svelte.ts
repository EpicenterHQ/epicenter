import { trackReads } from '@epicenter/svelte/tracked';
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
export type ReactiveAuthClient<TClient extends AuthClient = AuthClient> = Omit<
	TClient,
	'getState' | 'state'
> & { readonly state: AuthState } & Brand<'ReactiveAuthClient'>;

/**
 * Bridge an auth client's state into Svelte's graph.
 *
 * `from*` names the verb that builds the adapter. One function takes any
 * client: a client is composed somewhere that has no framework, and this
 * adapts one.
 *
 * Core clients expose `getState()` for explicit reads and `subscribe` for
 * change. This adapter exposes a reactive `state` property in its place and
 * copies the other property descriptors, so live values such as the desktop
 * deployment keep their getters. It is built on `trackReads` from
 * `@epicenter/svelte/tracked`, the helper under every capability's adapter:
 * the subscription starts only while something reads `state` in a tracking
 * context and stops when the last reader goes, and a read outside tracking
 * is a snapshot.
 */
export function fromAuth<TClient extends AuthClient>(
	authClient: TClient,
): ReactiveAuthClient<TClient> {
	const descriptors = Object.getOwnPropertyDescriptors(authClient);
	Reflect.deleteProperty(descriptors, 'getState');
	return trackReads(
		(listener) => authClient.subscribe(listener),
		{ state: () => authClient.getState() },
		Object.defineProperties({}, descriptors),
	) as unknown as ReactiveAuthClient<TClient>;
}
