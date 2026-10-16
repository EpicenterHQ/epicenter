/**
 * Platform Selection Tests
 *
 * A dropped seam leaf fails no build: resolution falls back to `default` and
 * the desktop page quietly opens a browser folder in OPFS. These tests
 * bundle through the app's Vite resolution config and name what broke.
 *
 * Key behaviors:
 * - The host leaf opens through the desktop folder adapter only: the browser
 *   leaf, the browser adapter and its OPFS store, any Git implementation,
 *   the directory opener, and every Node module are absent from its bundle
 * - The host leaf carries nothing of the host package
 * - The browser leaf carries the browser adapter and no desktop adapter and
 *   no generated native bindings
 * - Neither folder leaf loads the account recovery store
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const appDir = join(import.meta.dir, '..', '..');

const SEAM_ENTRY = 'src/lib/platform-selection.test-support.ts';

describe('#platform/folder', () => {
	test(
		'the host build opens through the desktop adapter and carries no browser folder',
		async () => {
			const modules = await bundledModules(
				appDir,
				SEAM_ENTRY,
				'epicenter-host',
			);
			for (const required of [
				'platform/folder.epicenter-host.ts',
				'folder/src/tauri.ts',
				'folder/src/tauri-adapter.ts',
				'folder/src/native/bindings.gen.ts',
			])
				expect(modules.filter((path) => path.endsWith(required))).toHaveLength(
					1,
				);
			// No browser folder and nothing that runs on Node. The page engine for
			// a granted directory, with its file storage and Git, is a chunk the
			// desktop adapter loads only when the shell grants a folder;
			// `packages/folder/evidence/bundles` checks that it stays lazy.
			expect(
				modules.filter((path) =>
					/platform\/folder\.browser\.ts$|folder\/src\/(browser|browser-adapter|bun|directory-node)\.ts$|folder\/src\/git\/(browser-|native-host)|^node:|^bun:/.test(
						path,
					),
				),
			).toEqual([]);
			expect(
				modules.filter((path) => /legacy\/|open-store\.ts$|@y[+/]/.test(path)),
			).toEqual([]);
			// Nothing of the host package: never the Bun host.
			expect(modules.filter((path) => /epicenter\/src\//.test(path))).toEqual(
				[],
			);
		},
		BUNDLE_TIMEOUT,
	);

	test(
		'the browser build opens through the browser adapter, with no desktop adapter',
		async () => {
			const modules = await bundledModules(appDir, SEAM_ENTRY, 'browser');
			for (const required of [
				'platform/folder.browser.ts',
				'folder/src/browser.ts',
				'folder/src/browser-adapter.ts',
				'folder/src/opfs-store.ts',
			])
				expect(modules.filter((path) => path.endsWith(required))).toHaveLength(
					1,
				);
			expect(
				modules.filter((path) =>
					/folder\/src\/browser-(store|migration)\.ts$|fake-indexeddb/.test(
						path,
					),
				),
			).toEqual([]);
			expect(
				modules.filter((path) =>
					// The browser adapter asks `isTauri()` so it can refuse there; that one
					// module of the Tauri API is its only use of it.
					/platform\/folder\.epicenter-host\.ts$|epicenter\/src\/|folder\/src\/(tauri|tauri-adapter|bun)\.ts$|folder\/src\/native\/|@tauri-apps\/api\/(event|webviewWindow)|^bun:/.test(
						path,
					),
				),
			).toEqual([]);
			expect(
				modules.filter((path) => /legacy\/|open-store\.ts$|@y[+/]/.test(path)),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);
});
