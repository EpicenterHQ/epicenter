/**
 * Auth state for the tab manager Chrome extension.
 *
 * Exports the persisted auth cell loader, the instance setting loader, and the
 * OAuth sign-in launcher. The auth client itself is created after both async
 * cells have loaded, in `../session.svelte`.
 *
 * @see {@link ../session.svelte} auth, workspace, and identity wiring
 */

import { loadInstanceSetting, loadPersistedAuthStorage } from '@epicenter/auth';
import { createExtensionOAuthLauncher } from '@epicenter/auth/oauth-launchers';
import { EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { storage } from '@wxt-dev/storage';
import { browser } from 'wxt/browser';

/**
 * Persisted auth cell in `chrome.storage.local`.
 *
 * The serialized cell is owned by `@epicenter/auth`; this module only supplies
 * async read/write over an opaque string. Older builds persisted a bundled
 * shape under `local:auth.session`; the new key resets cleanly, and a corrupt
 * or legacy cell validates to null, forcing a one-time sign-in. Workspace
 * IndexedDB data is keyed by userId and survives the reset.
 *
 * `loadPersistedAuthStorage` resolves once chrome.storage has been read;
 * `../session.svelte` awaits it before constructing the auth client.
 */
const authCell = storage.defineItem<string>('local:auth.persisted');

export const persistedAuthStoragePromise = loadPersistedAuthStorage({
	read: () => authCell.getValue(),
	write: (serialized) =>
		serialized === null
			? authCell.removeValue()
			: authCell.setValue(serialized),
});

/**
 * Persisted instance setting in `chrome.storage.local`: which Epicenter star
 * this install talks to (ADR-0069/0070). The hosted default uses OAuth; a
 * self-hoster pastes the token their box minted (ADR-0071). `chrome.storage` is
 * async, so the snapshot is pre-loaded here and awaited in `../session.svelte`
 * alongside the auth cell, mirroring `persistedAuthStoragePromise`.
 */
const instanceCell = storage.defineItem<string>('local:instance');

export const instanceSettingPromise = loadInstanceSetting({
	defaultBaseURL: APP_URLS.API,
	read: () => instanceCell.getValue(),
	write: (serialized) =>
		serialized === null
			? instanceCell.removeValue()
			: instanceCell.setValue(serialized),
});

export const oauthLauncher = createExtensionOAuthLauncher({
	issuer: `${APP_URLS.API}/auth`,
	clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
	redirectUri: browser.identity.getRedirectURL(),
	resource: APP_URLS.API,
	storage: {
		async getItem(key) {
			const result = await browser.storage.session.get(key);
			const value = result[key];
			return typeof value === 'string' ? value : null;
		},
		async setItem(key, value) {
			await browser.storage.session.set({ [key]: value });
		},
		async removeItem(key) {
			await browser.storage.session.remove(key);
		},
	},
	async launchWebAuthFlow(url) {
		const responseUrl = await browser.identity.launchWebAuthFlow({
			url,
			interactive: true,
		});
		if (!responseUrl) throw new Error('No response from Epicenter sign-in.');
		return responseUrl;
	},
});
