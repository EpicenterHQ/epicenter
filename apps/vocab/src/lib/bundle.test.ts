/**
 * Bundle Tests
 *
 * Bundles the page's root and its store through the app's Vite resolution
 * and reads every module the bundle pulls in, lazy chunks included.
 *
 * Key behaviors:
 * - Vocab's browser build opens the browser folder mirror and carries no
 *   native engine.
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
	'the browser build carries the local engine and no native engine',
	async () => {
		const modules = await bundledModules(
			appDir,
			'src/lib/bundle.test-support.ts',
			'browser',
		);
		expect(modules.some(folderModule('browser.ts'))).toBe(true);
		expect(modules.some(folderModule('browser/repository.ts'))).toBe(true);
		expect(modules.some(folderModule('tauri.ts'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);
