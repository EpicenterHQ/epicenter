import { defineApp } from '@epicenter/app';
import { openApp } from '@epicenter/app/open';
import type { Account } from '@epicenter/auth';
import { mailDefinition } from '../../src/lib/data.js';
import { currentLibraryResponse } from '../current-library.js';

/** Synthetic account; App, SQLite, persistence, query policy, and panel are production. */
export const account: Account = {
	supportsShared: false,
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
export const app = openApp(
	defineApp({
		...mailDefinition,
		id: 'so.epicenter.local-mail-evidence',
	}),
	{ account },
);
