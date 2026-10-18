/**
 * Bundle Tests
 *
 * Bundles the page's root and its store through the app's Vite resolution
 * and reads every module the bundle pulls in, lazy chunks included.
 *
 * Key behaviors:
 * - Vocab has one build, a browser one, and no alias of `@epicenter/folder`,
 *   so it carries both folder adapters: `openFolder` chooses when it is
 *   called, and loads the desktop adapter only inside the desktop app
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const appDir = join(import.meta.dir, '..', '..');

/** A module of `@epicenter/folder`, by its path below its `src/`. */
const folderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/folder/src/${name}`);

test(
	'the browser build carries both adapters, chosen when the folder opens',
	async () => {
		const modules = await bundledModules(
			appDir,
			'src/lib/bundle.test-support.ts',
			'browser',
		);
		expect(modules.some(folderModule('index.ts'))).toBe(true);
		expect(modules.some(folderModule('browser-adapter.ts'))).toBe(true);
		expect(modules.some(folderModule('tauri-adapter.ts'))).toBe(true);
	},
	BUNDLE_TIMEOUT,
);
