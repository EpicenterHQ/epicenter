/**
 * Platform Seam Tests
 *
 * Bundles Capture's `#platform/*` seams through the app's own Vite
 * resolution, once as the web build and once as the desktop build
 * (`EPICENTER_DESKTOP=1`, `bun run build:native`), and reads every module
 * each pulls in. A seam whose `tauri` key went missing breaks no build: it
 * silently ships the browser leaf. This names it.
 *
 * Key behaviors:
 * - The web build carries the browser leaves: OPFS, sign-in, no desktop folder
 * - The desktop build carries the window's folder and none of the browser's
 *   device or sign-in
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const appDir = join(import.meta.dir, '..', '..');
const entry = 'src/lib/platform.test-support.ts';

const leaf = (name: string) => (path: string) =>
	path.endsWith(`apps/capture/src/lib/${name}`);
const folderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/folder/src/${name}`);
const authModule = (path: string) => path.includes('packages/auth/src/');

/** The modules a build of the seams pulls in, as the web or the desktop build. */
async function bundle(desktop: boolean) {
	const before = process.env.EPICENTER_DESKTOP;
	if (desktop) process.env.EPICENTER_DESKTOP = '1';
	else delete process.env.EPICENTER_DESKTOP;
	try {
		return await bundledModules(appDir, entry);
	} finally {
		if (before === undefined) delete process.env.EPICENTER_DESKTOP;
		else process.env.EPICENTER_DESKTOP = before;
	}
}

test(
	'the web build carries the browser leaves and no desktop folder',
	async () => {
		const modules = await bundle(false);
		for (const name of ['device.ts', 'folder.ts', 'auth.ts'])
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of ['device.tauri.ts', 'folder.tauri.ts', 'auth.tauri.ts'])
			expect(modules.some(leaf(name)), name).toBe(false);
		expect(modules.some(folderModule('browser.ts'))).toBe(true);
		expect(modules.some(folderModule('tauri.ts'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);

test(
	'the desktop build carries the window’s folder, and neither OPFS nor sign-in',
	async () => {
		const modules = await bundle(true);
		for (const name of ['device.tauri.ts', 'folder.tauri.ts', 'auth.tauri.ts'])
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of ['device.ts', 'folder.ts', 'auth.ts'])
			expect(modules.some(leaf(name)), name).toBe(false);
		expect(modules.some(folderModule('tauri.ts'))).toBe(true);
		expect(modules.some(folderModule('epicenter-sync.ts'))).toBe(true);
		expect(modules.some(folderModule('browser.ts'))).toBe(false);
		expect(modules.some(authModule)).toBe(false);
	},
	BUNDLE_TIMEOUT,
);
