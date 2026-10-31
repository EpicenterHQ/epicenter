/**
 * Platform Seam Tests
 *
 * Bundles Honeycrisp's `#platform/*` seams through the app's own Vite
 * resolution, once as the web build and once as the desktop build
 * (`EPICENTER_DESKTOP=1`, `bun run build:native`), and reads every module
 * each pulls in. A seam whose `tauri` key went missing breaks no build: it
 * silently ships the browser leaf. This names it.
 *
 * Key behaviors:
 * - The web build carries the online root: sign-in and the repository, no folder
 * - The desktop build carries the window's folder and none of the web's
 *   sign-in or repository
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
	path.endsWith(`apps/honeycrisp/src/lib/${name}`);
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

const webLeaves = [
	'root.ts',
	'auth.ts',
	'components/OnlineRoot.svelte',
	'components/OnlineChrome.svelte',
	'components/SignInCallback.svelte',
];
const desktopLeaves = [
	'root.tauri.ts',
	'folder.tauri.ts',
	'components/Startup.svelte',
	'components/DesktopRoot.svelte',
	'components/DesktopChrome.svelte',
	'components/DesktopCallback.svelte',
];

test(
	'the web build carries the online root and no desktop folder',
	async () => {
		const modules = await bundle(false);
		for (const name of webLeaves)
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of desktopLeaves)
			expect(modules.some(leaf(name)), name).toBe(false);
		expect(modules.some(folderModule('remote.ts'))).toBe(true);
		expect(modules.some(folderModule('tauri.ts'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);

test(
	'the desktop build carries the window’s folder, and neither sign-in nor the repository',
	async () => {
		const modules = await bundle(true);
		for (const name of desktopLeaves)
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of webLeaves)
			expect(modules.some(leaf(name)), name).toBe(false);
		expect(modules.some(folderModule('tauri.ts'))).toBe(true);
		expect(modules.some(folderModule('epicenter-sync.ts'))).toBe(true);
		expect(modules.some(folderModule('remote.ts'))).toBe(false);
		expect(modules.some(authModule)).toBe(false);
	},
	BUNDLE_TIMEOUT,
);
