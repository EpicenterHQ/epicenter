/**
 * Platform Seam Tests
 *
 * Bundles Whispering's `#platform/*` seams through the app's own Vite
 * resolution, once as the web build and once as the desktop build
 * (`EPICENTER_DESKTOP=1`, `bun run build:native`), and reads every module
 * each pulls in. A seam whose `tauri` key went missing breaks no build: it
 * silently ships the browser leaf. This names it.
 *
 * Key behaviors:
 * - The web build carries the local variant: this browser's storage, the
 *   WebView microphone and the browser's sign-in, and nothing of the desktop
 * - The desktop build carries the window's two roots, the shell's microphone,
 *   requests and local models, and sign-in through the shell, and none of the
 *   web's leaves
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const appDir = join(import.meta.dir, '..', '..', '..');
const entry = 'src/lib/platform/platform.test-support.ts';

const leaf = (name: string) => (path: string) =>
	path.endsWith(`apps/whispering/src/lib/${name}`);
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
	'platform/root.ts',
	'platform/variant.ts',
	'platform/auth.ts',
	'platform/browser.ts',
	'components/LocalStartup.svelte',
	'components/LocalChrome.svelte',
	'components/SignInCallback.svelte',
];
const desktopLeaves = [
	'platform/root.tauri.ts',
	'platform/variant.tauri.ts',
	'platform/auth.tauri.ts',
	'platform/services.tauri.ts',
	'platform/microphone.tauri.ts',
	'platform/fetch.tauri.ts',
	'platform/shortcut.tauri.ts',
	'components/DesktopStartup.svelte',
	'components/DesktopRoot.svelte',
	'components/DesktopChrome.svelte',
	'components/DesktopSettings.svelte',
	'components/DesktopCallback.svelte',
];
/** What only the desktop build may carry from the shared packages. */
const desktopPackages = [
	'folder/src/tauri.ts',
	'recorder/src/tauri.ts',
	'auth/src/tauri.ts',
	'tauri-plugin-epicenter-transcription/guest-js/bindings.gen.ts',
];

test(
	'the web build carries the local variant and nothing of the desktop',
	async () => {
		const modules = await bundle(false);
		for (const name of webLeaves)
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of desktopLeaves)
			expect(modules.some(leaf(name)), name).toBe(false);
		expect(modules.some(packageModule('folder/src/browser.ts'))).toBe(true);
		for (const name of desktopPackages)
			expect(modules.some(packageModule(name)), name).toBe(false);
	},
	BUNDLE_TIMEOUT,
);

test(
	'the desktop build carries the window’s roots, the shell’s capabilities, and none of the web’s leaves',
	async () => {
		const modules = await bundle(true);
		for (const name of desktopLeaves)
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of webLeaves)
			expect(modules.some(leaf(name)), name).toBe(false);
		for (const name of desktopPackages)
			expect(modules.some(packageModule(name)), name).toBe(true);
		expect(modules.some(packageModule('folder/src/browser.ts'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);
