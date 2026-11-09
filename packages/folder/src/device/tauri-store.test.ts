/**
 * Tauri Store Tests
 *
 * `tauriStore` is one folder plugin command per method. These check what
 * crosses the bridge; `store.conformance.test.ts` and
 * `tauri-device.test.ts` run it over an emulated shell.
 *
 * Key behaviors:
 * - A listing passes the paths asked for and keeps the versions the shell
 *   hashed (`sha256:`) and sizes; a large file's stamp (`stamp:`) becomes
 *   its version, hashed once and then cached by that stamp in the cache it
 *   is given, never in the folder; every call names the root
 * - A read names every file by the version `versionOf` gives its bytes
 * - A put sends its expectation (absent, or `sha256:` and the version the
 *   shell hashes again) and names what landed by its version; a `stale`
 *   answer is `Moved` to what is there
 * - A read the shell answers `NotFound` is gone
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { versionOf } from '../hash.js';
import type { Version } from './store.js';

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
				{ path: 'notes/a.md', version: `sha256:${'f'.repeat(64)}`, size: 3 },
				{
					path: 'notes/a.webm',
					version: 'stamp:v1:3:1000000:3:4',
					size: 3,
				},
			];
		}
		if (command === 'plugin:epicenter-folder|read_folder_file') {
			readArgs = body;
			reads.push(body?.path ?? '');
			if (body?.path === 'notes/missing.md')
				throw { name: 'NotFound', path: body.path };
			return Uint8Array.from([
				...new TextEncoder().encode('v1:3:1000000:3:4'),
				0,
				...new TextEncoder().encode('old'),
			]).buffer;
		}
		if (command === 'plugin:epicenter-folder|put_folder_file') {
			putHeaders = options?.headers;
			return landing;
		}
		throw new Error(`Unexpected command ${command}`);
	},
}));

const { tauriStore } = await import('./tauri-store.js');
const ROOT = 'Data';
/** The hash cache the store keeps, outside the folder. */
let cached: Uint8Array | null = null;
const store = () =>
	tauriStore({
		root: ROOT,
		listen: () => () => {},
		hashes: {
			load: async () => cached,
			save: async (bytes) => {
				cached = bytes;
			},
		},
	});
const old = new TextEncoder().encode('old');

afterEach(() => {
	putHeaders = undefined;
	readArgs = undefined;
	listed = undefined;
	reads.length = 0;
	landing = { landed: 'v1:1:2:3:4' };
});

test('a listing keeps the versions the shell hashed, hashes a stamped file once, and names the root', async () => {
	const listing = store();
	const expected = [
		{ path: 'notes/a.md', version: 'f'.repeat(64) as Version, size: 3 },
		{
			path: 'notes/a.webm',
			version: await versionOf(old),
			size: 3,
		},
	];
	expect(expectOk(await listing.list(['notes']))).toEqual(expected);
	expect(listed).toEqual({ root: ROOT, under: ['notes'] });
	expect(reads).toEqual(['notes/a.webm']);
	expect(putHeaders).toBeUndefined();
	reads.length = 0;
	expect(expectOk(await listing.list(['notes']))).toEqual(expected);
	expect(reads).toEqual([]);
	// A new store over the same cache reads no attachment either.
	expect(expectOk(await store().list(['notes']))).toEqual(expected);
	expect(reads).toEqual([]);
	expect(
		Object.keys(
			JSON.parse(new TextDecoder().decode(cached ?? new Uint8Array())),
		),
	).toEqual(['notes/a.webm']);
});

test('a read names every file by its version', async () => {
	const [note, audio, missing] = expectOk(
		await store().read(['notes/a.md', 'notes/a.webm', 'notes/missing.md']),
	);
	expect(readArgs).toEqual({ path: 'notes/missing.md', root: ROOT });
	expect(note).toEqual({
		path: 'notes/a.md',
		bytes: old,
		version: await versionOf(old),
	});
	expect(audio).toMatchObject({
		path: 'notes/a.webm',
		version: await versionOf(old),
	});
	expect(missing).toEqual({ path: 'notes/missing.md', gone: true });
});

test('a put sends its expectation, and names what landed by its version', async () => {
	expect(expectOk(await store().put('a.md', new Uint8Array([1]), null))).toBe(
		await versionOf(new Uint8Array([1])),
	);
	expect(putHeaders?.expected).toBe('absent');
	expect(putHeaders?.path).toBe(encodeURIComponent('a.md'));
	expect(putHeaders?.root).toBe(encodeURIComponent(ROOT));
	const exact = 'e'.repeat(64) as Version;
	expect(expectOk(await store().put('a.md', null, exact))).toBeNull();
	expect(decodeURIComponent(putHeaders?.expected ?? '')).toBe(
		`sha256:${exact}`,
	);
	expect(putHeaders?.remove).toBe('true');
	// Any file, large or small, is replaced over its version.
	expect(
		expectOk(
			await store().put(
				'notes/a.webm',
				new Uint8Array([2]),
				await versionOf(old),
			),
		),
	).toBe(await versionOf(new Uint8Array([2])));
	expect(decodeURIComponent(putHeaders?.expected ?? '')).toBe(
		`sha256:${await versionOf(old)}`,
	);
	// The shell's `stale` is `Moved` to what is there now.
	landing = 'stale';
	expect(
		expectErr(await store().put('notes/a.md', new Uint8Array([3]), exact)),
	).toMatchObject({ name: 'Moved', now: await versionOf(old) });
});
