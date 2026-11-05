/**
 * Tauri Store Tests
 *
 * `tauriStore` is one folder plugin command per method. These check what
 * crosses the bridge; `store.conformance.test.ts` and
 * `tauri-device.test.ts` run it over an emulated shell.
 *
 * Key behaviors:
 * - A listing passes the paths asked for and keeps the shell's versions and
 *   sizes; every call names the root by name
 * - A read names a note by the sha256 of its bytes and anything else by the
 *   shell's stamp
 * - A write sends its expectation in its own spelling (absent, a note's
 *   hash, or an attachment's stamp) and names what landed the same way
 * - A read the shell answers `NotFound` is gone
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { hashBytes } from '../hash.js';
import type { Version } from './store.js';

let putHeaders: Record<string, string> | undefined;
let readArgs: { path?: string; root?: string } | undefined;
let listed: { root?: string; under?: string[] } | undefined;

mock.module('@tauri-apps/api/core', () => ({
	transformCallback: () => 0,
	invoke: async (
		command: string,
		body?: { path?: string; root?: string; under?: string[] },
		options?: { headers?: Record<string, string> },
	) => {
		if (command === 'plugin:epicenter-folder|list_folder') {
			listed = body;
			return [{ path: 'notes/a.md', version: 'hash', size: 3 }];
		}
		if (command === 'plugin:epicenter-folder|read_folder_file') {
			readArgs = body;
			if (body?.path === 'notes/missing.md')
				throw { name: 'NotFound', path: body.path };
			return Uint8Array.from([
				...new TextEncoder().encode('v1:3:1:3:4'),
				0,
				...new TextEncoder().encode('old'),
			]).buffer;
		}
		if (command === 'plugin:epicenter-folder|put_folder_file') {
			putHeaders = options?.headers;
			return { landed: 'v1:1:2:3:4' };
		}
		throw new Error(`Unexpected command ${command}`);
	},
}));

const { tauriStore } = await import('./tauri-store.js');
const ROOT = 'Data';
const store = () => tauriStore({ root: ROOT, listen: () => () => {} });

afterEach(() => {
	putHeaders = undefined;
	readArgs = undefined;
	listed = undefined;
});

test('a listing keeps the shell versions, and each call names the root', async () => {
	expect(expectOk(await store().list(['notes']))).toEqual([
		{ path: 'notes/a.md', version: 'hash' as Version, size: 3 },
	]);
	expect(listed).toEqual({ root: ROOT, under: ['notes'] });
	const [note, audio, missing] = expectOk(
		await store().read(['notes/a.md', 'notes/a.webm', 'notes/missing.md']),
	);
	expect(readArgs).toEqual({ path: 'notes/missing.md', root: ROOT });
	expect(note).toEqual({
		path: 'notes/a.md',
		bytes: new TextEncoder().encode('old'),
		version: (await hashBytes(new TextEncoder().encode('old'))) as Version,
	});
	expect(audio).toMatchObject({ path: 'notes/a.webm', version: 'v1:3:1:3:4' });
	expect(missing).toEqual({ path: 'notes/missing.md', gone: true });
});

test('a write sends each expectation in its own spelling, and names what landed', async () => {
	expect(
		expectOk(await store().write('a.md', new Uint8Array([1]), 'absent')),
	).toBe((await hashBytes(new Uint8Array([1]))) as Version);
	expect(putHeaders?.expected).toBe('absent');
	expect(putHeaders?.path).toBe(encodeURIComponent('a.md'));
	expect(putHeaders?.root).toBe(encodeURIComponent(ROOT));
	expect(
		expectOk(await store().write('a.md', null, 'exact-hash' as Version)),
	).toBeNull();
	expect(putHeaders?.expected).toBe('sha256:exact-hash');
	expect(putHeaders?.remove).toBe('true');
	expect(
		expectOk(
			await store().write(
				'a.webm',
				new Uint8Array([2]),
				'v1:9:9:9:9' as Version,
			),
		),
	).toBe('v1:1:2:3:4' as Version);
	expect(putHeaders?.expected).toBe(
		`stamp:${encodeURIComponent('v1:9:9:9:9')}`,
	);
});
