/**
 * Platform Seam Tests
 *
 * Bundles Vocab's `#platform/*` seams through the app's own Vite
 * resolution, once as the web build and once as the desktop build
 * (`EPICENTER_DESKTOP=1`, `bun run build:native`), and reads every module
 * each pulls in, lazy chunks included. A seam whose `tauri` key went
 * missing breaks no build: it silently ships the browser leaf. This names
 * it.
 *
 * Key behaviors:
 * - The web build carries the online root: the browser sign-in, the
 *   repository, and this browser's connections; no browser device (OPFS),
 *   since nothing is kept in the browser, and no desktop folder
 * - The desktop build carries the window's folder, the shell's sign-in,
 *   and the keychain connections, and none of the web's browser sign-in or
 *   repository
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
	path.endsWith(`apps/vocab/src/lib/${name}`);
const folderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/folder/src/${name}`);
const packageModule = (name: string) => (path: string) =>
	path.endsWith(`packages/${name}`);

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

const webLeaves = [
	'root.ts',
	'auth.ts',
	'connections.ts',
	'components/OnlineRoot.svelte',
	'components/Online.svelte',
	'components/OnlineChrome.svelte',
	'components/SignInCallback.svelte',
];
const desktopLeaves = [
	'root.tauri.ts',
	'auth.tauri.ts',
	'connections.tauri.ts',
	'folder.tauri.ts',
	'components/Startup.svelte',
	'components/DesktopRoot.svelte',
	'components/DesktopChrome.svelte',
	'components/DesktopCallback.svelte',
];

test(
	'the web build carries the online root, and no browser device or desktop folder',
	async () => {
		const modules = await bundle(false);
		for (const name of webLeaves)
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of desktopLeaves)
			expect(modules.some(leaf(name)), name).toBe(false);
		expect(modules.some(folderModule('remote.ts'))).toBe(true);
		expect(modules.some(folderModule('browser.ts'))).toBe(false);
		expect(modules.some(folderModule('device/opfs-store.ts'))).toBe(false);
		expect(modules.some(folderModule('tauri.ts'))).toBe(false);
		expect(modules.some(packageModule('auth/src/tauri.ts'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);

test(
	'the desktop build carries the window’s folder, the shell’s sign-in and the keychain, and none of the web’s',
	async () => {
		const modules = await bundle(true);
		for (const name of desktopLeaves)
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of webLeaves)
			expect(modules.some(leaf(name)), name).toBe(false);
		expect(modules.some(folderModule('tauri.ts'))).toBe(true);
		expect(modules.some(folderModule('epicenter-sync.ts'))).toBe(true);
		expect(modules.some(packageModule('auth/src/tauri.ts'))).toBe(true);
		expect(modules.some(folderModule('remote.ts'))).toBe(false);
		expect(modules.some(folderModule('browser.ts'))).toBe(false);
		expect(modules.some(packageModule('auth/src/browser-oauth.ts'))).toBe(
			false,
		);
	},
	BUNDLE_TIMEOUT,
);
