/**
 * Platform Selection Tests
 *
 * Vite resolves the page seam with the aliases and conditions from the app
 * config. The installed build Epicenter serves must open the directory the
 * shell grants, never browser storage.
 *
 * Key behaviors:
 * - Neither page bundle contains a Yjs, Node, or Bun module
 * - The installed page reaches its folder through the shell's grant only: no
 *   browser folder store and no isomorphic-git in the page
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const appDir = join(import.meta.dir, '..', '..');

const FORBIDDEN =
	/(^|\/)(@y[+/]|yjs[/@]|y-prosemirror[/@]|y-protocols[/@])|packages\/(auth|sync)\/src\//;
/** A Node or Bun built-in, or the directory folder and Git host that run on them. */
const NODE =
	/^(node|bun):|folder\/src\/(bun|directory-node)\.ts$|git\/native-host\.ts$/;

describe('bundles', () => {
	test(
		'the installed page reaches its folder through the shell only',
		async () => {
			const modules = await bundledModules(
				appDir,
				'src/lib/platform-selection.test-support.ts',
				'epicenter-host',
			);
			expect(modules.filter((path) => FORBIDDEN.test(path))).toEqual([]);
			expect(modules.filter((path) => NODE.test(path))).toEqual([]);
			expect(
				modules.some((path) => path.endsWith('folder/src/tauri-adapter.ts')),
			).toBe(true);
			expect(
				modules.some((path) =>
					path.endsWith('platform/notes-host.epicenter-host.ts'),
				),
			).toBe(true);
			// Only the folder package's generated bindings: its plugin's and the
			// shell's history commands.
			expect(
				modules
					.filter((path) => path.endsWith('bindings.gen.ts'))
					.map((path) => path.slice(path.indexOf('packages/')))
					.sort(),
			).toEqual([
				'packages/folder/src/native/bindings.gen.ts',
				'packages/folder/src/shell/bindings.gen.ts',
			]);
			// The folder contract came through the desktop entry, not the selector.
			expect(
				modules.filter((path) =>
					/folder\/src\/(index|browser)\.ts$/.test(path),
				),
			).toEqual([]);
			// No browser folder. The page engine for a granted directory, with
			// its history, file storage, and isomorphic-git's object code, is a
			// chunk the desktop adapter loads only when the shell grants a folder;
			// `packages/folder/evidence/bundles` checks that it stays lazy.
			expect(
				modules.filter((path) =>
					/folder\/src\/browser-adapter\.ts$|folder\/src\/git\/browser-backend\.ts$/.test(
						path,
					),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);

	test(
		'the browser page opens a browser folder without Yjs or a native path',
		async () => {
			const modules = await bundledModules(
				appDir,
				'src/lib/platform-selection.test-support.ts',
				'browser',
			);
			expect(modules.filter((path) => FORBIDDEN.test(path))).toEqual([]);
			expect(modules.filter((path) => NODE.test(path))).toEqual([]);
			expect(
				modules.some((path) => path.endsWith('folder/src/opfs-store.ts')),
			).toBe(true);
			expect(
				modules.filter((path) =>
					/folder\/src\/browser-(store|migration)\.ts$|fake-indexeddb/.test(
						path,
					),
				),
			).toEqual([]);
			// No desktop adapter, no bindings, and not the installed leaf.
			expect(
				modules.filter((path) =>
					/folder\/src\/(index|tauri|tauri-adapter)\.ts$|bindings\.gen\.ts$|platform\/notes-host\.epicenter-host\.ts$/.test(
						path,
					),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);
});
