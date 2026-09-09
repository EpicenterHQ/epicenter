/**
 * The real self-host Worker mounts Personal and Shared store routes with its
 * named-session resolver. Only the auth-owner binding is replaced by test
 * sessions; this verifies composition, not passkey enrollment or cryptography.
 */
/// <reference path="../../../apps/self-host/worker-configuration.d.ts" />
import { env } from 'cloudflare:test';
import { CURRENT_ROUTE } from '@epicenter/sync/generations-route';
import { expect, test } from 'vitest';
import app from '../../../apps/self-host/worker/index.js';

test('named-session removal rejects further access while another admitted user retains Shared data', async () => {
	const origin = 'https://instance.example.test';
	const sessions = new Map([
		['alice-session', { userId: 'alice' }],
		['bob-session', { userId: 'bob' }],
	]);
	const bindings = {
		...env,
		API_PUBLIC_ORIGIN: origin,
		TRUSTED_BROWSER_ORIGINS: '',
		SELF_HOST_AUTH: {
			idFromName: () => 'deployment',
			get: () => ({
				resolveSession: async (token: string) => sessions.get(token) ?? null,
			}),
		},
	} as unknown as Cloudflare.Env;
	const appId = `so.epicenter.instance-${crypto.randomUUID()}`;
	const request = (
		token: string,
		library: 'personal' | 'shared',
		seed: number,
	) =>
		app.fetch(
			new Request(CURRENT_ROUTE.url(origin, appId, library, appId), {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
				body: new Uint8Array([seed]),
			}),
			bindings,
		);
	const created = await request('alice-session', 'shared', 42);
	expect(created.status).toBe(200);
	expect(new Uint8Array(await created.arrayBuffer())).toEqual(
		new Uint8Array([42]),
	);
	sessions.delete('alice-session');
	const refused = await request('alice-session', 'shared', 99);
	expect(refused.status).toBe(401);
	await refused.arrayBuffer();
	const joined = await request('bob-session', 'shared', 7);
	expect(joined.status).toBe(200);
	expect(new Uint8Array(await joined.arrayBuffer())).toEqual(
		new Uint8Array([42]),
	);
	const personal = await request('bob-session', 'personal', 8);
	expect(personal.status).toBe(200);
	expect(new Uint8Array(await personal.arrayBuffer())).toEqual(
		new Uint8Array([8]),
	);
});
