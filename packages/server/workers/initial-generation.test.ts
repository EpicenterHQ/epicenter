/**
 * Atomic current-library creation in workerd: competing callers receive the
 * canonical snapshot, eviction preserves it, and invalid creation publishes none.
 * Historical generations are refused without adoption or deletion.
 */
import {
	env,
	evictDurableObject,
	runInDurableObject,
	SELF,
} from 'cloudflare:test';
import { decodeFrame, type Frame } from '@epicenter/data/sync';
import { asPrincipalId } from '@epicenter/principal';
import { readCurrentDownload } from '@epicenter/sync/current-download';
import {
	CURRENT_GENERATION_HEADER,
	CURRENT_ROUTE,
	LOG_POSITION_HEADER,
} from '@epicenter/sync/generations-route';
import { expect, test } from 'vitest';
import { expectOk } from 'wellcrafted/testing';
import { libraryStoragePrefix } from '../src/library.js';
import type { GenerationsLedger } from '../src/store-sync/generations.js';

declare global {
	namespace Cloudflare {
		interface Env {
			GENERATIONS_LEDGER: DurableObjectNamespace<GenerationsLedger>;
		}
	}
}
const appId = 'so.epicenter.initialprobe';
const dataId = appId;
function request(person: string, bytes: Uint8Array) {
	return SELF.fetch(
		CURRENT_ROUTE.url('https://example.com', appId, 'personal', dataId),
		{
			method: 'POST',
			headers: { authorization: `Bearer device:${person}` },
			body: new Uint8Array(bytes).buffer,
		},
	);
}
function authority(person: string) {
	return env.STORE_AUTHORITY.get(
		env.STORE_AUTHORITY.idFromName(
			`${libraryStoragePrefix(appId, 'personal', asPrincipalId(person))}/data/${dataId}`,
		),
	);
}

test('competing seeds return one canonical snapshot and retain it after eviction', async () => {
	const person = crypto.randomUUID();
	const seeds = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
	const responses = await Promise.all(
		seeds.map((seed) => request(person, seed)),
	);
	for (const response of responses) {
		expect(response.status).toBe(200);
		expect(response.headers.get(CURRENT_GENERATION_HEADER)).toBe('1');
		expect(response.headers.get(LOG_POSITION_HEADER)).toBe('1');
	}
	const bodies = await Promise.all(
		responses.map(
			async (response) => (await readCurrentDownload(response)).snapshot.bytes,
		),
	);
	expect(bodies[0]).toEqual(bodies[1]);
	expect(seeds).toContainEqual(bodies[0]);
	await evictDurableObject(authority(person));
	const reopened = await request(person, new Uint8Array([99]));
	expect(reopened.headers.get(CURRENT_GENERATION_HEADER)).toBe('1');
	expect((await readCurrentDownload(reopened)).snapshot.bytes).toEqual(
		bodies[0],
	);
});

test('an empty initializer leaves no current generation and retry succeeds after eviction', async () => {
	const person = crypto.randomUUID();
	const refused = await request(person, new Uint8Array());
	expect(refused.status).toBe(400);
	await refused.arrayBuffer();
	expect(
		await runInDurableObject(authority(person), (_instance, state) =>
			state.storage.sql
				.exec('SELECT generation FROM _current_generation')
				.toArray(),
		),
	).toEqual([]);
	await evictDurableObject(authority(person));
	const response = await request(person, new Uint8Array([8]));
	expect(response.headers.get(CURRENT_GENERATION_HEADER)).toBe('1');
	expect((await readCurrentDownload(response)).snapshot.bytes).toEqual(
		new Uint8Array([8]),
	);
});

test('oversized streamed initialization leaves no current generation', async () => {
	const person = crypto.randomUUID();
	const response = await request(person, new Uint8Array(16 * 1024 * 1024 + 1));
	expect(response.status).toBe(413);
	await response.arrayBuffer();
	expect(
		await runInDurableObject(authority(person), (_instance, state) =>
			state.storage.sql
				.exec('SELECT generation FROM _current_generation')
				.toArray(),
		),
	).toEqual([]);
});

test('historical admitted generations refuse fresh Personal startup without changing history', async () => {
	const person = crypto.randomUUID();
	const ledger = env.GENERATIONS_LEDGER.get(
		env.GENERATIONS_LEDGER.idFromName(`principals/${person}/data/${dataId}`),
	);
	const generation = await ledger.allocate();
	await ledger.admit(generation);
	const response = await request(person, new Uint8Array([9]));
	expect(response.status).toBe(409);
	expect(await response.text()).toContain('migration');
	expect(await ledger.list()).toEqual([generation]);
});

test('the mounted socket refuses an uninitialized generation without creating a library', async () => {
	const person = crypto.randomUUID();
	const response = await SELF.fetch(
		`https://example.com/api/store/v1/sync?appId=${appId}&library=personal&dataId=${dataId}&generation=77`,
		{
			headers: {
				authorization: `Bearer device:${person}`,
				Upgrade: 'websocket',
			},
		},
	);
	expect(response.status).toBe(101);
	const socket = response.webSocket!;
	const frames: Frame[] = [];
	const closed = new Promise<void>((resolve) => {
		socket.addEventListener('close', () => {
			socket.close();
			resolve();
		});
	});
	socket.addEventListener('message', (event) => {
		frames.push(
			expectOk(decodeFrame(new Uint8Array(event.data as ArrayBuffer))),
		);
	});
	socket.accept();
	await closed;
	expect(frames).toEqual([{ kind: 'retired' }]);
	expect(
		await runInDurableObject(authority(person), (_instance, state) =>
			state.storage.sql
				.exec('SELECT generation FROM _current_generation')
				.toArray(),
		),
	).toEqual([]);
});
