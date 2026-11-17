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
	const natives = buildFirstPartyClients(PRODUCTION, {
		hostedHomes: true,
	}).filter(({ clientId }) => clientId.endsWith('.native'));

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
			'so.epicenter.home',
			'https://epicenter-tasks-workers-prototype.epicenter.workers.dev',
			'http://localhost:8799',
		],
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
	const productionClients = buildFirstPartyClients(PRODUCTION, {
		hostedHomes: true,
	});
	const localClients = buildFirstPartyClients(LOCAL, { hostedHomes: true });
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

test('hosted clients reach only homes and the agent cannot mint refresh credentials or manage grants', () => {
	const clients = buildFirstPartyClients(PRODUCTION, { hostedHomes: true });
	const home = clients.find((c) => c.clientId === 'so.epicenter.home')!;
	const agent = clients.find((c) => c.clientId === 'so.epicenter.home.agent')!;
	expect(home.resources).toEqual([PRODUCTION + '/homes']);
	expect(agent.resources).toEqual(home.resources);
	expect(agent.grantTypes).toEqual([
		'urn:ietf:params:oauth:grant-type:device_code',
	]);
	expect(agent.scopes).toEqual([
		'home:read',
		'home:source',
		'home:build',
		'home:run',
	]);
	expect(agent.skipConsent).toBe(false);
	expect(
		clients
			.filter((c) => !c.clientId.startsWith('so.epicenter.home'))
			.every(
				(c) =>
					!c.scopes.some((s) => s.startsWith('home:')) &&
					!c.resources.includes(PRODUCTION + '/homes'),
			),
	).toBe(true);
});

test('the Bun deployment keeps its existing client and resource registrations', () => {
	expect(
		buildFirstPartyClients(PRODUCTION).some((c) =>
			c.clientId.startsWith('so.epicenter.home'),
		),
	).toBe(false);
});
