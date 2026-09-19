/**
 * The real self-host Worker mounts Personal store routes with its
 * named-session resolver. Only the auth-owner binding is replaced by test
 * sessions; this verifies composition, not passkey enrollment or cryptography.
 */
/// <reference path="../../../apps/self-host/worker-configuration.d.ts" />
import { env } from 'cloudflare:test';
import { readCurrentDownload } from '@epicenter/sync/current-download';
import { CURRENT_ROUTE } from '@epicenter/sync/generations-route';
import { expect, test } from 'vitest';
import app from '../../../apps/self-host/worker/index.js';

test('named-session removal rejects further access while other users retain their Personal data', async () => {
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
	const request = (token: string, seed: number) =>
		app.fetch(
			new Request(CURRENT_ROUTE.url(origin, appId, 'personal', appId), {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
				body: new Uint8Array([seed]),
			}),
			bindings,
		);
	const unsupported = await app.fetch(
		new Request(
			CURRENT_ROUTE.url(origin, appId, 'personal', appId).replace(
				'/personal/',
				'/shared/',
			),
			{
				method: 'POST',
				headers: { authorization: 'Bearer bob-session' },
				body: new Uint8Array([1]),
			},
		),
		bindings,
	);
	expect(unsupported.status).toBe(403);
	const created = await request('alice-session', 42);
	expect(created.status).toBe(200);
	expect((await readCurrentDownload(created)).snapshot.bytes).toEqual(
		new Uint8Array([42]),
	);
	sessions.delete('alice-session');
	const refused = await request('alice-session', 99);
	expect(refused.status).toBe(401);
	await refused.arrayBuffer();
	const joined = await request('bob-session', 7);
	expect(joined.status).toBe(200);
	expect((await readCurrentDownload(joined)).snapshot.bytes).toEqual(
		new Uint8Array([7]),
	);
	const personal = await request('bob-session', 8);
	expect(personal.status).toBe(200);
	expect((await readCurrentDownload(personal)).snapshot.bytes).toEqual(
		new Uint8Array([7]),
	);
});
