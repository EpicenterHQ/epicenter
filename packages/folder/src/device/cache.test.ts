/**
 * Device Cache Tests
 *
 * Once the server has a capture's audio, the device keeps those bytes under
 * `.epicenter/cache/` (decision 66), read only, so an app can play recent
 * recordings offline. A miss here is a cached file that is not the
 * repository's version, a note kept as a copy of the repository, a cache
 * that grows without end, or cached bytes that look like a capture and go
 * up again.
 *
 * Key behaviors:
 * - `finish` caches a file other than a note only where the reply shows its bytes at its path
 * - A read given the repository's version answers only with those bytes, and drops others
 * - Cached files are outside the contract: never listed by the device client, never adopted
 * - The cache holds at most `CACHE_LIMIT` files, the first by file name dropped first
 * - `clear` drops every cached file
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineContract, type Version } from '@epicenter/definition/contract';
import { conflictSibling } from '@epicenter/definition/merge';
import { expectOk } from 'wellcrafted/testing';
import {
	CACHE_LIMIT,
	cacheOf,
	openDevice,
	outboxOf,
} from '../node.js';
import { repositoryVersionOf } from './cache.js';

const recorder = defineContract({
	name: 'recorder',
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: { title: { type: 'string' } },
			required: ['title'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
	},
});

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function device() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-cache-'));
	folders.push(root);
	return openDevice(recorder, { path: root });
}

/**
 * Record capture `id` (a note and three bytes of audio), and acknowledge it
 * with the reply the server would give: the audio's pointer at its path, or
 * at `landedAt` when it landed elsewhere.
 */
async function uploaded(
	client: Awaited<ReturnType<typeof device>>,
	id: string,
	{ landedAt }: { landedAt?: string } = {},
) {
	const bytes = new Uint8Array([1, 2, 3, id.length]);
	const note = expectOk(await client.recordings.create({ id, title: id }));
	const audio = expectOk(await client.audio.create({ id, ext: 'webm', bytes }));
	const outbox = outboxOf(client);
	expectOk(
		await outbox.add({
			id,
			files: [
				{ collection: 'recordings', ...note },
				{ collection: 'audio', ...audio },
			],
		}),
	);
	const audioPath = `recordings/${id}.webm`;
	const pointer = repositoryVersionOf(audio.version, bytes.byteLength);
	expectOk(
		await outbox.acknowledge(
			id,
			{
				commit: 'c0ffee',
				paths: [`recordings/${id}.md`, landedAt ?? audioPath],
				blobs: {
					[`recordings/${id}.md`]: 'a'.repeat(40),
					[landedAt ?? audioPath]: pointer,
				},
			},
			{ [`recordings/${id}.md`]: note.version, [audioPath]: audio.version },
		),
	);
	expectOk(await outbox.finish(id));
	return { bytes, pointer };
}

test('finish caches the uploaded audio, not the note, outside the contract', async () => {
	const client = await device();
	const { bytes, pointer } = await uploaded(client, 'r1');
	const cache = cacheOf(client);
	expect(expectOk(await cache.list()).items).toEqual([
		{ collection: 'audio', id: 'r1', ext: 'webm' },
	]);
	expect(
		expectOk(await cache.read({ collection: 'audio', id: 'r1', ext: 'webm' }, { version: pointer }))
			?.bytes,
	).toEqual(bytes);
	// The device client and the outbox see none of it: nothing goes up again.
	expect(expectOk(await client.audio.list()).items).toEqual([]);
	expect(expectOk(await client.recordings.list()).items).toEqual([]);
	expect(expectOk(await outboxOf(client).list()).items).toEqual([]);
});

test('audio that landed as a conflict copy is not cached at its path', async () => {
	const client = await device();
	const sibling = conflictSibling('recordings/r1.webm', 'b'.repeat(64));
	await uploaded(client, 'r1', { landedAt: sibling });
	expect(expectOk(await cacheOf(client).list()).items).toEqual([]);
});

test("a read given another repository version answers null and drops the cached bytes", async () => {
	const client = await device();
	await uploaded(client, 'r1');
	const cache = cacheOf(client);
	const file = { collection: 'audio', id: 'r1', ext: 'webm' } as const;
	expect(
		expectOk(await cache.read(file, { version: 'c'.repeat(40) as Version })),
	).toBeNull();
	expect(expectOk(await cache.read(file))).toBeNull();
	expect(expectOk(await cache.list()).items).toEqual([]);
});

test(`the cache holds at most ${CACHE_LIMIT} files, dropping the first by name`, async () => {
	const client = await device();
	const ids = Array.from(
		{ length: CACHE_LIMIT + 2 },
		(_, n) => `r${n.toString().padStart(3, '0')}`,
	);
	for (const id of ids) await uploaded(client, id);
	const items = expectOk(await cacheOf(client).list()).items;
	expect(items.map((item) => (item as { id: string }).id)).toEqual(
		ids.slice(2),
	);
});

test('clear drops every cached file', async () => {
	const client = await device();
	await uploaded(client, 'r1');
	await uploaded(client, 'r2');
	const cache = cacheOf(client);
	expectOk(await cache.clear());
	expect(expectOk(await cache.list()).items).toEqual([]);
});
