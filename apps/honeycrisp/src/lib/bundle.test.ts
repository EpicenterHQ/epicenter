/**
 * Bundle Tests
 *
 * Bundles the notes and editor modules through the app's Vite resolution, as
 * each build resolves them, and reads every module the bundle pulls in.
 *
 * Key behaviors:
 * - Neither build carries a Yjs, Node, or Bun module, or the directory
 *   folder and Git host that run on them
 * - The bundled host build carries the native folder engine and no browser
 *   engine or OPFS store; the browser build carries the browser engine
 *   and no native engine
 */
import { expect, test } from 'bun:test';
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

test.each(['epicenter-host', 'browser'] as const)(
	'the %s build carries no Yjs, Node, or Bun module',
	async (build) => {
		const modules = await bundledModules(
			appDir,
			'src/lib/bundle.test-support.ts',
			build,
		);
		expect(modules.filter((path) => FORBIDDEN.test(path))).toEqual([]);
		expect(modules.filter((path) => NODE.test(path))).toEqual([]);
	},
	BUNDLE_TIMEOUT,
);

/** A module of `@epicenter/folder`, by its path below its `src/`. */
const folderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/folder/src/${name}`);

test(
	'the bundled host build carries the native engine and no browser storage',
	async () => {
		const modules = await bundledModules(
			appDir,
			'src/lib/bundle.test-support.ts',
			'epicenter-host',
		);
		expect(modules.some(folderModule('native/tauri.ts'))).toBe(true);
		expect(modules.some(folderModule('browser-adapter.ts'))).toBe(false);
		expect(modules.some(folderModule('opfs-store.ts'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);

test(
	'the browser build carries the local folder and no native engine',
	async () => {
		const modules = await bundledModules(
			appDir,
			'src/lib/bundle.test-support.ts',
			'browser',
		);
		expect(modules.some(folderModule('browser.ts'))).toBe(true);
		expect(modules.some(folderModule('local-folder.ts'))).toBe(true);
		expect(modules.some(folderModule('native/tauri.ts'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);
