/**
 * Bundle Tests
 *
 * Bundles the page's root and its store through the app's Vite resolution,
 * as each build resolves them, and reads every module the bundle pulls in.
 * `installedAppViteConfig` resolves `@epicenter/folder`, which `<FolderApp>`
 * opens with, to one entry per build; a dropped alias fails no build.
 *
 * Key behaviors:
 * - The installed build carries the desktop folder adapter, and no browser
 *   adapter, OPFS store, or Node or Bun module
 * - The browser build carries the browser adapter and no desktop adapter
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const appDir = join(import.meta.dir, '..', '..');
const ENTRY = 'src/lib/bundle.test-support.ts';

/** A module of `@epicenter/folder`, by its path below its `src/`. */
const folderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/folder/src/${name}`);

test(
	'the installed build carries the desktop adapter and no browser storage',
	async () => {
		const modules = await bundledModules(appDir, ENTRY, 'epicenter-host');
		expect(modules.some(folderModule('tauri-adapter.ts'))).toBe(true);
		expect(modules.some(folderModule('browser-adapter.ts'))).toBe(false);
		expect(modules.some(folderModule('opfs-store.ts'))).toBe(false);
		expect(modules.filter((path) => /^(node|bun):/.test(path))).toEqual([]);
	},
	BUNDLE_TIMEOUT,
);

test(
	'the browser build carries the browser adapter and no desktop adapter',
	async () => {
		const modules = await bundledModules(appDir, ENTRY, 'browser');
		expect(modules.some(folderModule('browser-adapter.ts'))).toBe(true);
		expect(modules.some(folderModule('tauri-adapter.ts'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);
