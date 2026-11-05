/**
 * Platform Seam Tests
 *
 * Bundles Vocab's values (`$lib/app`) and `#platform/*` seams through the
 * app's own Vite resolution, once as the web build and once as the desktop
 * build (`EPICENTER_DESKTOP=1`, `bun run build:native`), and reads every
 * module each pulls in, lazy chunks included. A seam or a capability whose
 * `tauri` key went missing breaks no build: it silently ships the browser
 * leaf. This names it.
 *
 * Key behaviors:
 * - The web build carries the browser sign-in, the account's copy of the
 *   repository, and this browser's connections, and no desktop folder
 * - The desktop build carries the window's folder, the shell's sign-in,
 *   and the keychain connections (`@epicenter/ai`'s desktop settings), and
 *   none of the web's browser sign-in or repository
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

const webLeaves = ['account.ts', 'components/OnlineChrome.svelte'];
const desktopLeaves = ['account.tauri.ts', 'components/DesktopChrome.svelte'];

test(
	'the web build carries the browser sign-in and the account’s copy, and no desktop folder',
	async () => {
		const modules = await bundle(false);
		for (const name of webLeaves)
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of desktopLeaves)
			expect(modules.some(leaf(name)), name).toBe(false);
		expect(modules.some(folderModule('home.ts'))).toBe(true);
		expect(modules.some(folderModule('remote/store.ts'))).toBe(true);
		expect(modules.some(folderModule('home.tauri.ts'))).toBe(false);
		expect(modules.some(folderModule('tauri.ts'))).toBe(false);
		expect(modules.some(packageModule('account/src/browser-oauth.ts'))).toBe(
			true,
		);
		expect(modules.some(packageModule('account/src/tauri.ts'))).toBe(false);
		expect(modules.some(packageModule('ai/src/tauri.ts'))).toBe(false);
		expect(modules.some(packageModule('ai/src/device-settings.ts'))).toBe(true);
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
		expect(modules.some(folderModule('home.tauri.ts'))).toBe(true);
		expect(modules.some(folderModule('epicenter-sync.ts'))).toBe(true);
		expect(modules.some(packageModule('account/src/tauri.ts'))).toBe(true);
		expect(modules.some(packageModule('ai/src/tauri.ts'))).toBe(true);
		expect(modules.some(packageModule('ai/src/device-settings.tauri.ts'))).toBe(
			true,
		);
		expect(modules.some(folderModule('home.ts'))).toBe(false);
		expect(modules.some(folderModule('remote/store.ts'))).toBe(false);
		expect(modules.some(folderModule('browser.ts'))).toBe(false);
		expect(modules.some(packageModule('account/src/browser-oauth.ts'))).toBe(
			false,
		);
	},
	BUNDLE_TIMEOUT,
);
