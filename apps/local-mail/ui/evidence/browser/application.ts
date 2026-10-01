import { defineStore } from '@epicenter/app';
import { openPersonal } from '@epicenter/app/open';
import { openSecrets } from '@epicenter/app/secrets';
import type { Account } from '@epicenter/auth';
import { mailDefinition } from '../../src/lib/data.js';
import { currentStoreResponse } from '../current-store.js';

/** Synthetic account; App, SQLite, persistence, query policy, and panel are production. */
export const account: Account = {
	authorityId: 'local-mail-evidence',
	principalId: 'synthetic-person' as Account['principalId'],
	baseURL: 'https://example.invalid',
	async fetch(input, init) {
		if (localStorage.getItem('evidence-offline') === 'true')
			throw new TypeError('Fixture is offline');
		return currentStoreResponse(new Request(input, init));
	},
	async openWebSocket() {
		throw new TypeError('Fixture has no cloud transport');
	},
	async getProfile() {
		throw new Error('Fixture has no profile');
	},
};
export const definition = defineStore({
	...mailDefinition,
	id: 'so.epicenter.local-mail-evidence',
});
export const opening = (async () => {
	const personal = await openPersonal(definition, { account });
	try {
		const secrets = await openSecrets({ id: definition.id });
		return {
			personal,
			sqlite: personal.sqlite,
			secrets,
			signal: personal.signal,
			async close() {
				await Promise.all([personal.close(), secrets.close()]);
			},
		};
	} catch (cause) {
		await personal.close();
		throw cause;
	}
})();
