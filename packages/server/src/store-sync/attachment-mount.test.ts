/**
 * Attachment admission uses the existing bearer and destination resolver.
 * Cloud refuses Shared and Local; instance Shared is explicit, and no supplied
 * owner can redirect Personal to another authority or the historical ledger.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { ATTACHMENT_ROUTE } from '@epicenter/sync/attachment-route';
import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';
import { OAuthError } from '../auth/oauth-errors.js';
import type { Env } from '../types.js';
import { mountStoreSyncApp } from './mount.js';

function setup(shared = false) {
	const app = new Hono<Env>();
	const names: string[] = [];
	mountStoreSyncApp(app, {
		shared,
		resolveBearerPrincipal: async (_context, token) =>
			token === 'alice'
				? Ok({ id: asPrincipalId('alice') })
				: OAuthError.InvalidToken(),
		resolveStore: () => ({
			authority(name) {
				names.push(name);
				return {
					async fetch(request) {
						return new Response(request.method, { status: 202 });
					},
				};
			},
			ledger() {
				throw new Error('Attachments must not open historical generations');
			},
		}),
	});
	const url = (library = 'personal') =>
		ATTACHMENT_ROUTE.url(
			'https://test',
			'so.epicenter.whispering',
			library,
			'so.epicenter.recordings',
			'recordings',
			'aaaaaaaaaaaaaaaaaaaaaaaa',
		);
	const headers = { authorization: 'Bearer alice' };
	return { app, names, url, headers };
}

test('every control method reaches the same authenticated current authority', async () => {
	const { app, names, url, headers } = setup();
	for (const method of ['GET', 'POST', 'PUT']) {
		const response = await app.request(url(), { method, headers });
		expect(response.status).toBe(202);
		expect(await response.text()).toBe(method);
	}
	expect(names).toEqual(
		Array(3).fill(
			'libraries/apps/so.epicenter.whispering/personal/alice/data/so.epicenter.recordings',
		),
	);
});

test('missing or invalid bearer and forged or unsupported destinations open no authority', async () => {
	const { app, names, url, headers } = setup();
	expect((await app.request(url())).status).toBe(401);
	expect(
		(await app.request(url(), { headers: { authorization: 'Bearer bad' } }))
			.status,
	).toBe(401);
	for (const target of [
		url('local'),
		url('shared'),
		url() + '?owner=bob',
		url() + '?principalId=bob',
	])
		expect((await app.request(target, { headers })).status).toBe(403);
	expect(names).toEqual([]);
});

test('Shared only opens when the deployment explicitly grants it', async () => {
	const { app, names, url, headers } = setup(true);
	expect((await app.request(url('shared'), { headers })).status).toBe(202);
	expect(names).toEqual([
		'libraries/apps/so.epicenter.whispering/shared/data/so.epicenter.recordings',
	]);
});
