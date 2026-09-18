import { defineApplication } from '@epicenter/app';
import { createDeparture } from '@epicenter/app-shell/departure';
import { authStartup } from '#platform/auth';
import { mailDefinition } from './data.js';
import { mail } from './mail.js';

// Only the mounted primary route imports this module. The document captures
// its Account once; callback and preload routes never acquire a library.
const auth = authStartup.auth;
const state = auth?.state;
export const account =
	!state || state.status === 'signed-out' ? null : state.account;
export const app =
	account === null || new URLSearchParams(location.search).has('connect')
		? null
		: defineApplication({
				appId: 'so.epicenter.local-mail',
				definition: mailDefinition,
			}).open(account);

export const departure = createDeparture({
	libraryReplaced: app?.libraryReplaced,
	canRetryClose: () => app?.canRetryClose ?? false,
	reload: () => location.reload(),
	auth: app && auth ? auth : undefined,
	account,
	async close() {
		await mail.close();
		await app?.close();
	},
});
