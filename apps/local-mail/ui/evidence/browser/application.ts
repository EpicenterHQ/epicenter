import { defineApplication } from '@epicenter/app';
import type { Account } from '@epicenter/auth';
import { mailDefinition } from '../../src/lib/data.js';

/** Synthetic account; App, SQLite, persistence, query policy, and panel are production. */
export const account: Account = {
	authorityId: 'local-mail-evidence',
	principalId: 'synthetic-person' as Account['principalId'],
	baseURL: 'https://example.invalid',
	async fetch(input, init) {
		if (localStorage.getItem('evidence-offline') === 'true')
			throw new TypeError('Fixture is offline');
		return Response.json(
			String(input).endsWith('/generations') &&
				(!init?.method || init.method === 'GET')
				? { generations: [] }
				: { generation: 1, position: 0 },
		);
	},
	async openWebSocket() {
		throw new TypeError('Fixture has no cloud transport');
	},
	async getProfile() {
		throw new Error('Fixture has no profile');
	},
};
export const app = defineApplication({
	appId: 'so.epicenter.local-mail-evidence',
	definition: mailDefinition,
}).openPersonal(account);
