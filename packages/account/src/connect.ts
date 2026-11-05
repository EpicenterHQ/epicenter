/**
 * `connectAccount`: an app's sign-in with Epicenter, which this package
 * chooses when it runs (ADR-0781). The app lists nothing it uses the
 * account for: each capability it hands the account to says what it needs
 * when it is made (`need`), and sign-in asks for all of them (ADR-0792).
 * `home({ site, account })` needs the app's repository, `hosted(account)`
 * the AI gateway, and `openProfile(account)` the person's name and email.
 *
 * - In a browser the account is a browser OAuth client that asks for the
 *   audiences and scopes those needs add up to (`browserGrant`), read at
 *   each sign-in. `app.ts` makes every capability when it loads, so every
 *   need is known before anyone can sign in.
 * - In a Tauri window the app signs in through the shell
 *   (`createTauriAuth`, whose requests load the shell's relay when made),
 *   to sync its folder and to use hosted models (ADR-0785). The shell's
 *   sign-in asks for its own grant, so the needs are not sent from here.
 *
 * Nothing in an app waits on sign-in.
 */
import { resolveOAuthAudiences } from '@epicenter/definition/site';
import { isTauri } from '@tauri-apps/api/core';
import type { AuthClient } from './auth-contract.js';
import { epicenterCloud, selfHostedServer } from './auth-server.js';
import { createBrowserOAuth } from './browser-oauth.js';
import { createTauriAuth } from './tauri.js';

/**
 * What a capability needs the account to reach: the app's repository
 * (`repository`, which a Tauri window's folder syncs with), Epicenter's AI
 * gateway (`ai`), or who is signed in, by name and email (`profile`).
 */
export type AccountNeed = 'repository' | 'ai' | 'profile';

/** An app's account: a sign-in each capability that takes it says it needs. */
export type AppAccount = AuthClient & {
	/** Say, while the capability is made, that it needs `need`. */
	need(need: AccountNeed): void;
};

export type ConnectAccountOptions = {
	/** The app's browser OAuth client, e.g. `so.epicenter.todos` (`apps/api/worker/oauth-registrations.ts`). */
	clientId: string;
	/** Epicenter's API for this build: its local API in a dev build (`APP_URLS.API`). */
	api: string;
	/** A self-hosted server the build signs in to instead, when it names one (`SELF_HOST_ORIGIN`). */
	selfHosted?: string;
	/**
	 * Renew the browser's tokens on a timer, which leaves the page to do it.
	 * Off for an app whose work must not be cut off by a navigation, such as
	 * a recording. On by default.
	 */
	automaticRenewal?: boolean;
};

/**
 * This page's sign-in. Making it in a browser reads `localStorage` and,
 * with `automaticRenewal`, schedules renewals; in a Tauri window it reads
 * `account.json` once the settings connected.
 *
 * ```ts
 * const account = connectAccount({ clientId: 'so.epicenter.todos', api: APP_URLS.API, selfHosted: SELF_HOST_ORIGIN });
 * export const folder = openFolder(todos, home({ site: APPS.TODOS.url, account }));
 * ```
 */
export function connectAccount({
	clientId,
	api,
	selfHosted,
	automaticRenewal,
}: ConnectAccountOptions): AppAccount {
	if (isTauri()) return Object.assign(createTauriAuth(), { need() {} });
	const server = selfHosted
		? selfHostedServer(selfHosted)
		: epicenterCloud(api);
	const audiences = resolveOAuthAudiences(server.baseURL);
	const needs = new Set<AccountNeed>();
	const client = createBrowserOAuth({
		server,
		clientId,
		grant: () => browserGrant(needs, audiences),
		accountManagement: !selfHosted,
		automaticRenewal,
	});
	return Object.assign(client, {
		need: (need: AccountNeed) => void needs.add(need),
	});
}

/**
 * The audiences and scopes a browser sign-in asks for, by what the
 * capabilities given the account need. The first audience also answers the
 * server's own requests (userinfo), so the API comes first when anything
 * reaches it.
 */
function browserGrant(
	needs: ReadonlySet<AccountNeed>,
	audiences: { api: string; git: string },
): { resources: [string, ...string[]]; scope: string } {
	const reachesApi = needs.has('ai') || needs.has('profile');
	const [first, ...rest] = [
		...(reachesApi ? [audiences.api] : []),
		...(needs.has('repository') ? [audiences.git] : []),
	];
	if (first === undefined)
		throw new TypeError(
			'No capability was given the account, so it has nothing to sign in for.',
		);
	const scope = [
		'openid',
		...(needs.has('profile') ? ['profile', 'email'] : []),
		...(needs.has('ai') ? ['ai'] : []),
		...(needs.has('repository') ? ['folders:read', 'folders:write'] : []),
	].join(' ');
	return { resources: [first, ...rest], scope };
}

/**
 * The signed-in person's name and email, for an app that shows them. Made
 * in `app.ts` beside the account, it says the account needs the profile.
 */
export function openProfile(account: Pick<AppAccount, 'need' | 'getProfile'>) {
	account.need('profile');
	return { read: () => account.getProfile() };
}
