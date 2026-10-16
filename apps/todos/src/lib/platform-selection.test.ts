/**
 * Platform Selection Tests
 *
 * Bundles the `#platform/*` seams the way each build resolves them, with
 * the conditions and aliases `vite.config.ts` declares, and reads every module
 * the bundle pulls in. A dropped leaf or alias fails no build: resolution
 * falls back silently, so the selection is proved here.
 *
 * Key behaviors:
 * - The host build reaches the desktop adapter and its generated bindings,
 *   and no OPFS storage, directory opener, or Git implementation
 * - The host build reaches the desktop broker account, and no redirect sign-in
 * - The browser build reaches OPFS storage and isomorphic-git, and no
 *   desktop adapter or generated bindings
 * - The browser build reaches redirect sign-in, and no desktop broker account
 * - Neither build reaches the automatic entry, which loads either adapter,
 *   or `@epicenter/app`
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const appDir = join(import.meta.dir, '..', '..');

const SEAM_ENTRY = 'src/lib/platform-selection.test-support.ts';

/** Modules of `@epicenter/folder`, by their path below its `src/`. */
const folderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/folder/src/${name}`);

/** The automatic entry, which can load either adapter, and anything of App's. */
const SHARED_FORBIDDEN = /packages\/folder\/src\/index\.ts$|packages\/app\//;

describe('#platform/folder', () => {
	test(
		'the host build resolves the desktop adapter and the directory folder over the granted directory, never the browser folder or a Bun or Node module',
		async () => {
			const modules = await bundledModules(
				appDir,
				SEAM_ENTRY,
				'epicenter-host',
			);

			expect(
				modules.some((path) =>
					path.endsWith('platform/folder.epicenter-host.ts'),
				),
			).toBe(true);
			expect(modules.some(folderModule('tauri.ts'))).toBe(true);
			expect(modules.some(folderModule('tauri-adapter.ts'))).toBe(true);
			expect(modules.some(folderModule('native/bindings.gen.ts'))).toBe(true);
			// Todos is a page-engine folder: the shell grants its directory and
			// the page reads and writes there itself. Its history runs in the
			// `epicenter` CLI (ADR-0559), so no Git engine reaches the window.
			for (const engine of [
				'tauri-directory.ts',
				'directory-adapter.ts',
				'directory-handle.ts',
				'directory-tauri.ts',
				'tauri-history.ts',
				'history-wire.ts',
			])
				expect(modules.some(folderModule(engine))).toBe(true);
			for (const engine of [
				'git/native-backend.ts',
				'git/history.ts',
				'git/objects.ts',
				'history-command.ts',
			])
				expect(modules.some(folderModule(engine))).toBe(false);
			// It reads through the folder plugin's commands, not the fs plugin.
			expect(modules.some((path) => /@tauri-apps\/plugin-fs/.test(path))).toBe(
				false,
			);
			// Nothing of the host's Bun entry reaches the window.
			expect(
				modules.filter((path) => /apps\/epicenter\/src\//.test(path)),
			).toEqual([]);
			expect(
				modules.filter(
					(path) =>
						SHARED_FORBIDDEN.test(path) ||
						/platform\/folder\.browser\.ts$|packages\/folder\/src\/(browser|browser-adapter|bun|directory-node)\.ts$|packages\/folder\/src\/git\/(opfs-git|native-host)\.ts$|^node:|^bun:/.test(
							path,
						),
				),
			).toEqual([]);
			// The desktop window borrows Settings' account through the CLI.
			for (const module of [
				'platform/auth.epicenter-host.ts',
				'auth/src/desktop-account-auth.ts',
				'src/lib/remote.ts',
			])
				expect(modules.some((path) => path.endsWith(module))).toBe(true);
			expect(
				modules.filter((path) =>
					/platform\/auth\.browser\.ts$|auth\/src\/browser-oauth\.ts$/.test(
						path,
					),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);

	test(
		'the browser build resolves the OPFS adapter without the desktop adapter or its bindings',
		async () => {
			const modules = await bundledModules(appDir, SEAM_ENTRY, 'browser');

			expect(
				modules.some((path) => path.endsWith('platform/folder.browser.ts')),
			).toBe(true);
			expect(modules.some(folderModule('browser.ts'))).toBe(true);
			expect(modules.some(folderModule('browser-adapter.ts'))).toBe(true);
			expect(modules.some(folderModule('opfs-store.ts'))).toBe(true);
			expect(modules.some((path) => path.includes('isomorphic-git'))).toBe(
				true,
			);
			// The browser reaches nothing of the host's.
			expect(modules.filter((path) => /apps\/epicenter\//.test(path))).toEqual(
				[],
			);
			expect(
				modules.filter((path) =>
					/folder\/src\/browser-(store|migration)\.ts$|fake-indexeddb/.test(
						path,
					),
				),
			).toEqual([]);
			expect(
				modules.filter(
					(path) =>
						SHARED_FORBIDDEN.test(path) ||
						/platform\/folder\.epicenter-host\.ts$|packages\/folder\/src\/(tauri|tauri-adapter|bun)\.ts$|packages\/folder\/src\/native\/|packages\/folder\/src\/git\/(native-backend|native-checkpoint)\.ts$|tauri-plugin-epicenter-folder|^bun:/.test(
							path,
						),
				),
			).toEqual([]);
			// Redirect sign-in is the browser's.
			for (const module of [
				'platform/auth.browser.ts',
				'auth/src/browser-oauth.ts',
				'src/lib/remote.ts',
			])
				expect(modules.some((path) => path.endsWith(module))).toBe(true);
			expect(
				modules.filter((path) =>
					/platform\/auth\.epicenter-host\.ts$|auth\/src\/desktop-account-auth\.ts$/.test(
						path,
					),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);
});
