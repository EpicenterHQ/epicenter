/**
 * Tauri Store Tests
 *
 * `tauriStore` is one folder plugin command per method. These check what
 * crosses the bridge; `tauri-device.test.ts` runs the client over an
 * emulated shell.
 *
 * Key behaviors:
 * - A listing and a read keep the shell's stamps, below `inside`
 * - A write sends its expectation in its own spelling: absent, any, or a
 *   tagged hash
 * - A read the shell answers `NotFound` is no file
 */
import { afterEach, expect, mock, test } from 'bun:test';
import type { Version } from '@epicenter/definition/contract';
import { expectOk } from 'wellcrafted/testing';

let putHeaders: Record<string, string> | undefined;
let readPath: string | undefined;

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	transformCallback: () => 0,
	invoke: async (
		command: string,
		body?: { path?: string },
		options?: { headers?: Record<string, string> },
	) => {
		if (command === 'plugin:epicenter-folder|list_folder')
			return [
				{ path: 'notes/a.md', stamp: 'v1:3:1:3:4' },
				{ path: 'other.md', stamp: 'v1:9:1:3:4' },
			];
		if (command === 'plugin:epicenter-folder|read_folder_file') {
			readPath = body?.path;
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
			return { kind: 'landed', stamp: 'v1:1:2:3:4' };
		}
		throw new Error(`Unexpected command ${command}`);
	},
}));

const { tauriStore } = await import('./tauri-store.js');
const store = () => tauriStore({ inside: 'notes', watch: () => () => {} });

afterEach(() => {
	putHeaders = undefined;
	readPath = undefined;
});

test('a listing and a read keep the shell stamps, below inside', async () => {
	expect(expectOk(await store().list())).toEqual([
		{ path: 'a.md', stamp: 'v1:3:1:3:4' },
	]);
	const read = expectOk(await store().read('a.md'));
	expect(readPath).toBe('notes/a.md');
	expect(read?.stamp).toBe('v1:3:1:3:4');
	expect(new TextDecoder().decode(read?.bytes)).toBe('old');
	expect(expectOk(await store().read('missing.md'))).toBeNull();
});

test('a write sends each expectation in its own spelling: absent, any, or a tagged hash', async () => {
	expect(
		expectOk(await store().write('a.md', new Uint8Array([1]), 'absent')),
	).toBe('landed');
	expect(putHeaders?.expected).toBe('absent');
	expect(putHeaders?.path).toBe(encodeURIComponent('notes/a.md'));
	expectOk(
		await store().write('a.md', null, {
			sha256: 'exact-hash' as Version,
		}),
	);
	expect(putHeaders?.expected).toBe('sha256:exact-hash');
	expect(putHeaders?.remove).toBe('true');
	expectOk(await store().write('a.md', new Uint8Array([1]), 'any'));
	expect(putHeaders?.expected).toBe('any');
});
