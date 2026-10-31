/**
 * Bundle Tests
 *
 * Bundles the page's openers and state through the app's Vite resolution
 * and reads every module the bundle pulls in, lazy chunks included.
 *
 * Key behaviors:
 * - Vocab's browser build opens the browser device (OPFS) and the remote,
 *   and carries no desktop opener.
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
	'the browser build carries the browser device and the remote, and no desktop opener',
	async () => {
		const modules = await bundledModules(
			appDir,
			'src/lib/bundle.test-support.ts',
		);
		expect(modules.some(folderModule('browser.ts'))).toBe(true);
		expect(modules.some(folderModule('device/opfs-store.ts'))).toBe(true);
		expect(modules.some(folderModule('remote.ts'))).toBe(true);
		expect(modules.some(folderModule('tauri.ts'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);
