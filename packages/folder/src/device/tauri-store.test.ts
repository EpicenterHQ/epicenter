/**
 * Tauri Store Tests
 *
 * `tauriStore` is one folder plugin command per method. These check what
 * crosses the bridge; `tauri-device.test.ts` runs the client over an
 * emulated shell.
 *
 * Key behaviors:
 * - A listing and a read keep the shell's stamps, and every call names the
 *   root by name
 * - A write sends its expectation in its own spelling: absent or a tagged
 *   hash
 * - A read the shell answers `NotFound` is no file
 */
import { afterEach, expect, mock, test } from 'bun:test';
import type { Version } from '@epicenter/definition/contract';
import { expectOk } from 'wellcrafted/testing';
import { hashBytes } from '../hash.js';

let putHeaders: Record<string, string> | undefined;
let readArgs: { path?: string; root?: string } | undefined;
let listedRoot: string | undefined;

mock.module('@tauri-apps/api/core', () => ({
	transformCallback: () => 0,
	invoke: async (
		command: string,
		body?: { path?: string; root?: string },
		options?: { headers?: Record<string, string> },
	) => {
		if (command === 'plugin:epicenter-folder|list_folder') {
			listedRoot = body?.root;
			return [{ path: 'notes/a.md', stamp: 'v1:3:1:3:4' }];
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
			return 'landed';
		}
		throw new Error(`Unexpected command ${command}`);
	},
}));

const { tauriStore } = await import('./tauri-store.js');
const ROOT = 'Data';
const store = () => tauriStore({ root: ROOT, watch: () => () => {} });

afterEach(() => {
	putHeaders = undefined;
	readArgs = undefined;
	listedRoot = undefined;
});

test('a listing and a read keep the shell stamps, and each names the root', async () => {
	expect(expectOk(await store().list())).toEqual([
		{ path: 'notes/a.md', stamp: 'v1:3:1:3:4' },
	]);
	expect(listedRoot).toBe(ROOT);
	const read = expectOk(await store().read('notes/a.md'));
	expect(readArgs).toEqual({ path: 'notes/a.md', root: ROOT });
	expect(read?.stamp).toBe('v1:3:1:3:4');
	expect(new TextDecoder().decode(read?.bytes)).toBe('old');
	expect(expectOk(await store().read('notes/missing.md'))).toBeNull();
});

test('a write sends each expectation in its own spelling: absent or a tagged version', async () => {
	expect(
		expectOk(await store().write('a.md', new Uint8Array([1]), 'absent')),
	).toEqual({ landed: (await hashBytes(new Uint8Array([1]))) as Version });
	expect(putHeaders?.expected).toBe('absent');
	expect(putHeaders?.path).toBe(encodeURIComponent('a.md'));
	expect(putHeaders?.root).toBe(encodeURIComponent(ROOT));
	expectOk(
		await store().write('a.md', null, {
			version: 'exact-hash' as Version,
		}),
	);
	expect(putHeaders?.expected).toBe('sha256:exact-hash');
	expect(putHeaders?.remove).toBe('true');
});
