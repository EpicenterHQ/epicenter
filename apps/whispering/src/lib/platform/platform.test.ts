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
 *   browser's recorder and sign-in, and nothing of the desktop
 * - The desktop build carries the data folder, the shell's microphone,
 *   requests and local models, the global shortcut, and sign-in through the
 *   shell, and none of the web's leaves
 * - Only the web build has a service worker (decision 85): the desktop
 *   build's names an entry that does not exist, so Kit builds and registers
 *   none
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
	'platform/account.ts',
	'platform/components.ts',
	'platform/computer.ts',
	'platform/variant.ts',
	'components/LocalChrome.svelte',
	'components/SignInCallback.svelte',
];
const desktopLeaves = [
	'platform/account.tauri.ts',
	'platform/components.tauri.ts',
	'platform/computer.tauri.ts',
	'platform/variant.tauri.ts',
	'platform/shortcut.tauri.ts',
	'components/DesktopChrome.svelte',
	'components/DesktopSettings.svelte',
	'components/DesktopCallback.svelte',
];
/** What only the desktop build may carry from the shared packages. */
const desktopPackages = [
	'folder/src/home.tauri.ts',
	'recorder/src/tauri.ts',
	'account/src/tauri.ts',
	'ai/src/tauri.ts',
	'transcription/guest-js/local-speech.ts',
	'transcription/guest-js/bindings.gen.ts',
	'ai/src/device-settings.tauri.ts',
	'local/src/tauri.ts',
];
/** What only the web build may carry from the shared packages: the leaves the `tauri` condition replaces. */
const webPackages = [
	'ai/src/device-settings.ts',
	'local/src/browser.ts',
	'folder/src/home.ts',
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
		for (const name of webPackages)
			expect(modules.some(packageModule(name)), name).toBe(true);
		for (const name of desktopPackages)
			expect(modules.some(packageModule(name)), name).toBe(false);
	},
	BUNDLE_TIMEOUT,
);

test(
	'the desktop build carries the data folder, the shell’s capabilities, and none of the web’s leaves',
	async () => {
		const modules = await bundle(true);
		for (const name of desktopLeaves)
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of webLeaves)
			expect(modules.some(leaf(name)), name).toBe(false);
		for (const name of desktopPackages)
			expect(modules.some(packageModule(name)), name).toBe(true);
		for (const name of [
			...webPackages,
			'transcription/guest-js/local-speech.web.ts',
		])
			expect(modules.some(packageModule(name)), name).toBe(false);
		expect(modules.some(packageModule('folder/src/browser.ts'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);

test('only the web build has a service worker', async () => {
	for (const desktop of [false, true]) {
		const before = process.env.EPICENTER_DESKTOP;
		if (desktop) process.env.EPICENTER_DESKTOP = '1';
		else delete process.env.EPICENTER_DESKTOP;
		try {
			const { default: config } = await import(
				`${join(appDir, 'svelte.config.js')}?desktop=${desktop}`
			);
			const entry: string = config.kit.files.serviceWorker;
			expect(await Bun.file(join(appDir, `${entry}.js`)).exists()).toBe(
				!desktop,
			);
		} finally {
			if (before === undefined) delete process.env.EPICENTER_DESKTOP;
			else process.env.EPICENTER_DESKTOP = before;
		}
	}
});
