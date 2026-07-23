import type {
	InstanceSetting,
	PersistedAuthStorage,
	SyncAuthClient,
} from '@epicenter/auth';
import { createTauriDeepLinkOAuthLauncher } from '@epicenter/auth/oauth-launchers/tauri';
import { createAppAuthClient } from './auth.svelte.js';

/** Options for {@link createHostedDeepLinkAuth}: only what varies per app. */
export type CreateHostedDeepLinkAuthOptions = {
	/** The app's persisted instance setting: hosted default or a self-host token. */
	instanceSetting: InstanceSetting;
	/** This app's hosted OAuth client id (used by both the client and the launcher). */
	clientId: string;
	/** This app's registered deep-link callback (e.g. `epicenter-whispering://auth/callback`). */
	redirectUri: string;
	/** The hosted API origin (e.g. `APP_URLS.API`): owns the issuer and the resource. */
	api: string;
	/**
	 * The persisted grant store, pre-resolved by the caller so this factory
	 * itself stays synchronous. Build this with `loadPersistedAuthStorage`
	 * (awaited before calling this factory) over the platform's credential
	 * store, for example the OS keyring on desktop.
	 */
	persistedAuthStorage: PersistedAuthStorage;
};

/**
 * Package the hosted deep-link OAuth convention every Tauri desktop app
 * repeats: a caller-supplied grant store, a deep-link launcher built from the
 * hosted constants (`${api}/auth` issuer, `api` as the resource), and the
 * persisted `Instance` fed to {@link createAppAuthClient}. Each app passes
 * only what varies: its persisted instance setting, OAuth client id,
 * registered redirect URI, hosted API origin, and credential-backed grant
 * store. The result is a reactive `SyncAuthClient`, ready for record attachment
 * and authenticated realtime transports.
 *
 * The launcher's PKCE transaction always lives in `localStorage`, never
 * `sessionStorage`: a deep-link callback can cold-start the app, which would
 * drop a `sessionStorage`-held transaction before it completes. That has no
 * override knob because no Tauri app has needed one.
 *
 * The grant store is required. A plain `localStorage` file is a bigger prize
 * than a five-minute PKCE transaction, so a Tauri app must choose a real
 * credential-backed store at its platform edge.
 *
 * Deep-link-only by construction: it owns no browser-redirect or extension
 * launcher and no self-host token branch. The self-host path still works
 * because `createAppAuthClient` reads it off the passed `instanceSetting` (a
 * token instance ignores the launcher); this factory only builds the
 * deep-link launcher the hosted branch needs. A Tauri app keeps this for its
 * desktop build and uses `createHostedBrowserRedirectAuth` for its web build
 * (ADR-0078).
 *
 * Separate subpath (`@epicenter/svelte/auth/tauri`) from the rest of this
 * package's auth exports: `@tauri-apps/*` are optional peer dependencies, so
 * only a Tauri app's own import graph pulls them in, not every web-only
 * consumer of `@epicenter/svelte/auth`.
 */
export function createHostedDeepLinkAuth({
	instanceSetting,
	clientId,
	redirectUri,
	api,
	persistedAuthStorage,
}: CreateHostedDeepLinkAuthOptions): SyncAuthClient {
	return createAppAuthClient(instanceSetting.read(), {
		clientId,
		persistedAuthStorage,
		launcher: createTauriDeepLinkOAuthLauncher({
			issuer: `${api}/auth`,
			clientId,
			resource: api,
			redirectUri,
			storage: window.localStorage,
		}),
	});
}
