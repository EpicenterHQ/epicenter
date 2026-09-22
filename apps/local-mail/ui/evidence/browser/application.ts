import { defineApp } from '@epicenter/app';
import { openPersonal } from '@epicenter/app/open';
import { openSqlite } from '@epicenter/app/sqlite';
import { openSecrets } from '@epicenter/app/secrets';
import type { Account } from '@epicenter/auth';
import { mailDefinition } from '../../src/lib/data.js';
import { currentLibraryResponse } from '../current-library.js';

/** Synthetic account; App, SQLite, persistence, query policy, and panel are production. */
export const account: Account = {
	authorityId: 'local-mail-evidence',
	principalId: 'synthetic-person' as Account['principalId'],
	baseURL: 'https://example.invalid',
	async fetch(input, init) {
		if (localStorage.getItem('evidence-offline') === 'true')
			throw new TypeError('Fixture is offline');
		return currentLibraryResponse(new Request(input, init));
	},
	async openWebSocket() {
		throw new TypeError('Fixture has no cloud transport');
	},
	async getProfile() {
		throw new Error('Fixture has no profile');
	},
};
export const definition = defineApp({
	...mailDefinition,
	id: 'so.epicenter.local-mail-evidence',
});
export const opening = (async () => {
	const personal = await openPersonal(definition, { account });
	try {
		const sqlite = await openSqlite({ id: definition.id });
		try {
			const secrets = await openSecrets({ id: definition.id });
			return {
				personal,
				sqlite,
				secrets,
				signal: personal.signal,
				async close() {
					await Promise.all([
						personal.close(),
						sqlite.close(),
						secrets.close(),
					]);
				},
			};
		} catch (cause) {
			await sqlite.close();
			throw cause;
		}
	} catch (cause) {
		await personal.close();
		throw cause;
	}
})();
