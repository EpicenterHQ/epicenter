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
import { resolveOAuthAudiences } from '@epicenter/definition/site';
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

	test('a loopback redirect on any port, the API alone, and no folders scope', () => {
		const expectedScopes = [
			'openid',
			'offline_access',
			'profile',
			'email',
			'ai',
		] as const;
		for (const client of natives) {
			expect(client.applicationType).toBe('native');
			expect(client.redirectUris).toEqual(['http://127.0.0.1/callback']);
			expect(client.resources).toEqual([resolveOAuthAudiences(PRODUCTION).api]);
			expect([...client.scopes].sort()).toEqual([...expectedScopes].sort());
		}
	});
});

test('browser clients redirect only to their own production and local callbacks', () => {
	const expected = [
		[
			'so.epicenter.todos',
			'https://todos.epicenter.so',
			'http://localhost:5186',
		],
		[
			'so.epicenter.whispering',
			'https://whispering.epicenter.so',
			'http://localhost:1420',
		],
		[
			'so.epicenter.capture',
			'https://capture.epicenter.so',
			'http://localhost:5179',
		],
		[
			'so.epicenter.vocab',
			'https://vocab.epicenter.so',
			'http://localhost:8888',
		],
		[
			'com.bradenwong.zhongwen',
			'https://zhongwen.bradenwong.com',
			'http://localhost:5207',
		],
	] as const;
	const productionClients = buildFirstPartyClients(PRODUCTION);
	const localClients = buildFirstPartyClients(LOCAL);
	expect(
		productionClients
			.filter((client) => client.applicationType === 'web')
			.map((client) => client.clientId),
	).toEqual(expected.map(([clientId]) => clientId));
	for (const [clientId, productionOrigin, localOrigin] of expected) {
		const callback = (origin: string) => `${origin}/auth/callback`;
		expect(
			productionClients.find((client) => client.clientId === clientId)
				?.redirectUris,
		).toEqual([callback(productionOrigin)]);
		expect(
			localClients.find((client) => client.clientId === clientId)?.redirectUris,
		).toEqual([callback(productionOrigin), callback(localOrigin)]);
	}
});
