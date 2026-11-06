/**
 * Tauri Store Tests
 *
 * `tauriStore` is one folder plugin command per method. These check what
 * crosses the bridge; `store.conformance.test.ts` and
 * `tauri-device.test.ts` run it over an emulated shell.
 *
 * Key behaviors:
 * - A listing passes the paths asked for and keeps the shell's versions of
 *   notes and sizes; an attachment's stamp becomes its pointer's blob id,
 *   hashed once and then cached by that stamp; every call names the root
 * - A read names every file by the blob id `blobIdOf` gives its bytes
 * - A put sends its expectation in its own spelling (absent, a note's blob
 *   id, or an attachment's stamp, read and hashed again first) and names
 *   what landed by its blob id; a `stale` answer is `Moved` to what is there
 * - A read the shell answers `NotFound` is gone
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { blobIdOf } from '../hash.js';
import type { BlobId } from './store.js';

let putHeaders: Record<string, string> | undefined;
let readArgs: { path?: string; root?: string } | undefined;
let listed: { root?: string; under?: string[] } | undefined;
const reads: string[] = [];
let landing: { landed: string } | 'stale' = { landed: 'v1:1:2:3:4' };

mock.module('@tauri-apps/api/core', () => ({
	transformCallback: () => 0,
	invoke: async (
		command: string,
		body?: { path?: string; root?: string; under?: string[] },
		options?: { headers?: Record<string, string> },
	) => {
		if (command === 'plugin:epicenter-folder|list_folder') {
			listed = body;
			return [
				{ path: 'notes/a.md', version: 'f'.repeat(40), size: 3 },
				{ path: 'notes/a.webm', version: 'v1:3:1000000:3:4', size: 3 },
			];
		}
		if (command === 'plugin:epicenter-folder|read_folder_file') {
			readArgs = body;
			reads.push(body?.path ?? '');
			if (
				body?.path === 'notes/missing.md' ||
				body?.path === '.epicenter/hashes.json'
			)
				throw { name: 'NotFound', path: body.path };
			return Uint8Array.from([
				...new TextEncoder().encode('v1:3:1000000:3:4'),
				0,
				...new TextEncoder().encode('old'),
			]).buffer;
		}
		if (command === 'plugin:epicenter-folder|put_folder_file') {
			if (
				decodeURIComponent(options?.headers?.path ?? '') !==
				'.epicenter/hashes.json'
			)
				putHeaders = options?.headers;
			return landing;
		}
		throw new Error(`Unexpected command ${command}`);
	},
}));

const { tauriStore } = await import('./tauri-store.js');
const ROOT = 'Data';
const store = () => tauriStore({ root: ROOT, listen: () => () => {} });
const old = new TextEncoder().encode('old');

afterEach(() => {
	putHeaders = undefined;
	readArgs = undefined;
	listed = undefined;
	reads.length = 0;
	landing = { landed: 'v1:1:2:3:4' };
});

test('a listing keeps a note’s blob id, hashes an attachment once by its stamp, and names the root', async () => {
	const listing = store();
	const expected = [
		{ path: 'notes/a.md', version: 'f'.repeat(40) as BlobId, size: 3 },
		{
			path: 'notes/a.webm',
			version: await blobIdOf('notes/a.webm', old),
			size: 3,
		},
	];
	expect(expectOk(await listing.list(['notes']))).toEqual(expected);
	expect(listed).toEqual({ root: ROOT, under: ['notes'] });
	expect(reads).toEqual(['.epicenter/hashes.json', 'notes/a.webm']);
	reads.length = 0;
	expect(expectOk(await listing.list(['notes']))).toEqual(expected);
	expect(reads).toEqual([]);
});

test('a read names every file by its blob id', async () => {
	const [note, audio, missing] = expectOk(
		await store().read(['notes/a.md', 'notes/a.webm', 'notes/missing.md']),
	);
	expect(readArgs).toEqual({ path: 'notes/missing.md', root: ROOT });
	expect(note).toEqual({
		path: 'notes/a.md',
		bytes: old,
		version: await blobIdOf('notes/a.md', old),
	});
	expect(audio).toMatchObject({
		path: 'notes/a.webm',
		version: await blobIdOf('notes/a.webm', old),
	});
	expect(missing).toEqual({ path: 'notes/missing.md', gone: true });
});

test('a put sends each expectation in its own spelling, and names what landed by its blob id', async () => {
	expect(expectOk(await store().put('a.md', new Uint8Array([1]), null))).toBe(
		await blobIdOf('a.md', new Uint8Array([1])),
	);
	expect(putHeaders?.expected).toBe('absent');
	expect(putHeaders?.path).toBe(encodeURIComponent('a.md'));
	expect(putHeaders?.root).toBe(encodeURIComponent(ROOT));
	const exact = 'e'.repeat(40) as BlobId;
	expect(expectOk(await store().put('a.md', null, exact))).toBeNull();
	expect(decodeURIComponent(putHeaders?.expected ?? '')).toBe(`blob:${exact}`);
	expect(putHeaders?.remove).toBe('true');
	// An attachment is read and hashed again, and replaced only over its stamp.
	expect(
		expectOk(
			await store().put(
				'notes/a.webm',
				new Uint8Array([2]),
				await blobIdOf('notes/a.webm', old),
			),
		),
	).toBe(await blobIdOf('notes/a.webm', new Uint8Array([2])));
	expect(decodeURIComponent(putHeaders?.expected ?? '')).toBe(
		'stamp:v1:3:1000000:3:4',
	);
	// One that no longer holds what the writer expects has moved, without a write.
	putHeaders = undefined;
	const moved = expectErr(
		await store().put('notes/a.webm', new Uint8Array([2]), exact),
	);
	expect(moved).toMatchObject({
		name: 'Moved',
		now: await blobIdOf('notes/a.webm', old),
	});
	expect(putHeaders).toBeUndefined();
	// The shell's `stale` is `Moved` to what is there now.
	landing = 'stale';
	expect(
		expectErr(await store().put('notes/a.md', new Uint8Array([3]), exact)),
	).toMatchObject({ name: 'Moved', now: await blobIdOf('notes/a.md', old) });
});
