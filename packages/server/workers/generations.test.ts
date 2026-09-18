/**
 * Current-library authorization and addressing through deployed Worker routes.
 * Personal actors stay isolated, Shared selects one destination, and callers
 * cannot override the actor or reach independently writable history endpoints.
 */
import { SELF } from 'cloudflare:test';
import { readCurrentDownload } from '@epicenter/sync/current-download';
import { CURRENT_ROUTE } from '@epicenter/sync/generations-route';
import { expect, test } from 'vitest';

const origin = 'http://example.com';
function setup() {
	const appId = `so.epicenter.library-${crypto.randomUUID()}`;
	const dataId = 'so.epicenter.storeprobe';
	const url = (library: 'personal' | 'shared') =>
		CURRENT_ROUTE.url(origin, appId, library, dataId);
	const request = (
		person: string,
		library: 'personal' | 'shared',
		seed: number,
		suffix = '',
	) =>
		SELF.fetch(url(library) + suffix, {
			method: 'POST',
			headers: { authorization: `Bearer device:${person}` },
			body: new Uint8Array([seed]),
		});
	return { request, url, dataId };
}

test('Personal selects the authenticated actor while Shared returns the same bytes to both actors', async () => {
	const { request } = setup();
	for (const [person, value] of [
		['alice', 11],
		['bob', 22],
	] as const) {
		const response = await request(person, 'personal', value);
		expect(response.status).toBe(200);
		expect((await readCurrentDownload(response)).snapshot.bytes).toEqual(
			new Uint8Array([value]),
		);
	}
	const shared = await request('alice', 'shared', 33);
	expect((await readCurrentDownload(shared)).snapshot.bytes).toEqual(
		new Uint8Array([33]),
	);
	const joined = await request('bob', 'shared', 44);
	expect((await readCurrentDownload(joined)).snapshot.bytes).toEqual(
		new Uint8Array([33]),
	);
	const personal = await request('bob', 'personal', 55);
	expect((await readCurrentDownload(personal)).snapshot.bytes).toEqual(
		new Uint8Array([22]),
	);
});

test('anonymous creation and caller-supplied Personal owners are refused', async () => {
	const { request, url } = setup();
	const anonymous = await SELF.fetch(url('shared'), {
		method: 'POST',
		body: new Uint8Array([1]),
	});
	expect(anonymous.status).toBe(401);
	for (const suffix of ['?owner=bob', '?principalId=bob']) {
		const response = await request('alice', 'personal', 1, suffix);
		expect(response.status).toBe(403);
	}
});

test('Shared libraries belonging to different applications remain isolated', async () => {
	const first = setup();
	const second = setup();
	for (const [fixture, value] of [
		[first, 7],
		[second, 8],
	] as const) {
		const response = await fixture.request('alice', 'shared', value);
		expect((await readCurrentDownload(response)).snapshot.bytes).toEqual(
			new Uint8Array([value]),
		);
	}
	const response = await first.request('bob', 'shared', 9);
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
