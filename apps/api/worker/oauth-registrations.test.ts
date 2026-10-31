/**
 * OAuth Registration Tests
 *
 * The deployment's first-party clients (`oauth-registrations.ts`), as rows
 * the authorization server matches sign-ins against.
 *
 * Key behaviors:
 * - Each standalone desktop app that signs in is one native client,
 *   `so.epicenter.<app>.native`, with a loopback redirect and the API alone
 * - A client lists every redirect it uses; a local deployment's browser
 *   clients carry both the production and the local origin
 */
import { describe, expect, test } from 'bun:test';
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import { buildFirstPartyClients } from './oauth-registrations.js';

const PRODUCTION = 'https://api.epicenter.so';
const LOCAL = 'http://localhost:8787';

describe('native clients', () => {
	const natives = buildFirstPartyClients(PRODUCTION).filter(({ clientId }) =>
		clientId.endsWith('.native'),
	);

	test('one per desktop app that signs in, named so.epicenter.<app>.native', () => {
		expect(natives.map(({ clientId }) => clientId)).toEqual([
			'so.epicenter.whispering.native',
			'so.epicenter.vocab.native',
		]);
		for (const { clientId } of natives)
			expect(clientId).toMatch(/^so\.epicenter\.[a-z]+\.native$/);
	});

	test('a loopback redirect on any port, the API alone, and no Git scope', () => {
		for (const client of natives) {
			expect(client.applicationType).toBe('native');
			expect(client.redirectUris).toEqual(['http://127.0.0.1/callback']);
			expect(client.resources).toEqual([resolveOAuthAudiences(PRODUCTION).api]);
			expect(client.scopes).toContain('offline_access');
			expect(client.scopes).not.toContain('folders:read');
			expect(client.scopes).not.toContain('folders:write');
		}
	});
});

test('a client lists every redirect it uses', () => {
	const todos = buildFirstPartyClients(LOCAL).find(
		({ clientId }) => clientId === 'so.epicenter.todos',
	);
	expect(todos?.redirectUris.length).toBe(2);
	for (const uri of todos?.redirectUris ?? [])
		expect(uri.endsWith('/auth/callback')).toBe(true);
});
