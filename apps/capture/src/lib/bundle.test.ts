/**
 * Bundle Tests
 *
 * Bundles the page's root and its store through the app's Vite resolution, as
 * the browser build resolves them, and reads every module the bundle pulls in.
 *
 * Key behaviors:
 * - The browser build carries `@epicenter/folder`'s runtime choice and no
 *   Node or Bun module
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
	'the portable build carries both folder engines',
	async () => {
		const modules = await bundledModules(appDir, ENTRY);
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
