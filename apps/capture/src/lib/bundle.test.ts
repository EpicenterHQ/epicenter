/**
 * Bundle Tests
 *
 * Bundles the page's root and its store through the app's Vite resolution, as
 * each build resolves them, and reads every module the bundle pulls in.
 * The host build selects the Tauri entry. The portable build keeps the
 * runtime choice so the same bytes also open in a hosted window.
 *
 * Key behaviors:
 * - The host build carries the native folder engine and no browser
 *   engine, OPFS store, or Node or Bun module
 * - The published build carries both engines behind the runtime choice
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
	'the host build carries the native engine and no browser storage',
	async () => {
		const modules = await bundledModules(appDir, ENTRY, 'epicenter-host');
		expect(modules.some(folderModule('tauri.ts'))).toBe(true);
		expect(modules.some(folderModule('browser.ts'))).toBe(false);
		expect(modules.some((path) => path.endsWith('folder-app.svelte'))).toBe(
			false,
		);
		expect(modules.some((path) => path.endsWith('document-owner.ts'))).toBe(
			false,
		);
		expect(modules.filter((path) => /^(node|bun):/.test(path))).toEqual([]);
	},
	BUNDLE_TIMEOUT,
);

test(
	'the portable build carries both folder engines',
	async () => {
		const modules = await bundledModules(appDir, ENTRY, 'browser');
		expect(modules.some(folderModule('browser.ts'))).toBe(true);
		expect(modules.some(folderModule('browser/repository.ts'))).toBe(true);
		expect(modules.some(folderModule('index.ts'))).toBe(true);
		expect(modules.some(folderModule('tauri.ts'))).toBe(true);
		expect(modules.some((path) => path.endsWith('folder-app.svelte'))).toBe(
			false,
		);
		expect(modules.some((path) => path.endsWith('document-owner.ts'))).toBe(
			false,
		);
		expect(modules.filter((path) => /^(node|bun):/.test(path))).toEqual([]);
	},
	BUNDLE_TIMEOUT,
);
