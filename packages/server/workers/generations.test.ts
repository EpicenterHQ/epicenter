/**
 * Current data authorization and addressing through deployed Worker routes.
 * Personal actors stay isolated, unsupported scopes are refused, and callers
 * cannot override the actor or reach independently writable history endpoints.
 */
import { SELF } from 'cloudflare:test';
import { readCurrentDownload } from '@epicenter/sync/current-download';
import { CURRENT_ROUTE } from '@epicenter/sync/generations-route';
import { expect, test } from 'vitest';

const origin = 'http://example.com';
function setup() {
	const appId = `so.epicenter.scope-${crypto.randomUUID()}`;
	const dataId = 'so.epicenter.storeprobe';
	const url = () => CURRENT_ROUTE.url(origin, appId, 'personal', dataId);
	const request = (person: string, seed: number, suffix = '') =>
		SELF.fetch(url() + suffix, {
			method: 'POST',
			headers: { authorization: `Bearer device:${person}` },
			body: new Uint8Array([seed]),
		});
	return { request, url, dataId };
}

test('Personal selects the authenticated actor', async () => {
	const { request } = setup();
	for (const [person, value] of [
		['alice', 11],
		['bob', 22],
	] as const) {
		const response = await request(person, value);
		expect(response.status).toBe(200);
		expect((await readCurrentDownload(response)).snapshot.bytes).toEqual(
			new Uint8Array([value]),
		);
	}
	const personal = await request('bob', 55);
	expect((await readCurrentDownload(personal)).snapshot.bytes).toEqual(
		new Uint8Array([22]),
	);
});

test('anonymous creation and caller-supplied Personal owners are refused', async () => {
	const { request, url } = setup();
	const anonymous = await SELF.fetch(url(), {
		method: 'POST',
		body: new Uint8Array([1]),
	});
	expect(anonymous.status).toBe(401);
	for (const suffix of ['?owner=bob', '?principalId=bob']) {
		const response = await request('alice', 1, suffix);
		expect(response.status).toBe(403);
	}
});

test('Personal stores belonging to different applications remain isolated', async () => {
	const first = setup();
	const second = setup();
	for (const [fixture, value] of [
		[first, 7],
		[second, 8],
	] as const) {
		const response = await fixture.request('alice', value);
		expect((await readCurrentDownload(response)).snapshot.bytes).toEqual(
			new Uint8Array([value]),
		);
	}
	const response = await first.request('alice', 9);
	expect((await readCurrentDownload(response)).snapshot.bytes).toEqual(
		new Uint8Array([7]),
	);
});

test('old generation listing and import endpoints are not mounted', async () => {
	const { dataId } = setup();
	for (const method of ['GET', 'POST']) {
		const response = await SELF.fetch(
			`${origin}/api/data/v1/${dataId}/generations`,
			{
				method,
				headers: { authorization: 'Bearer device:alice' },
				...(method === 'POST' ? { body: new Uint8Array([1]) } : {}),
			},
		);
		expect(response.status).toBe(404);
	}
});

test('Shared current requests are refused for authenticated users', async () => {
	const { url } = setup();
	const response = await SELF.fetch(url().replace('/personal/', '/shared/'), {
		method: 'POST',
		headers: { authorization: 'Bearer device:alice' },
		body: new Uint8Array([1]),
	});
	expect(response.status).toBe(403);
});
