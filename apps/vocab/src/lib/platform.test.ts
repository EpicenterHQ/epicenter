/**
 * Platform Seam Tests
 *
 * Bundles Vocab's `#platform/*` seams through the app's own Vite resolution,
 * once as the web build and once as the desktop build (`EPICENTER_DESKTOP=1`,
 * `bun run build:native`), and reads every module each pulls in. A seam
 * whose `tauri` key went missing breaks no build: it silently ships the
 * browser leaf. This names it.
 *
 * Key behaviors:
 * - The web build carries the browser's sign-in and connections, and no
 *   desktop leaf
 * - The desktop build carries the shell's sign-in and keychain connections,
 *   and no browser leaf (`@epicenter/auth`'s barrel is in both, for its
 *   shared types and errors)
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
	path.endsWith(`apps/vocab/src/lib/platform/${name}`);

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

const BROWSER = ['auth.browser.ts', 'connections.browser.ts'];
const DESKTOP = ['auth.tauri.ts', 'connections.tauri.ts'];

test(
	'the web build carries the browser leaves and no desktop leaf',
	async () => {
		const modules = await bundle(false);
		for (const name of BROWSER)
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of DESKTOP)
			expect(modules.some(leaf(name)), name).toBe(false);
	},
	BUNDLE_TIMEOUT,
);

test(
	'the desktop build carries the shell’s sign-in and keychain, and no browser leaf',
	async () => {
		const modules = await bundle(true);
		for (const name of DESKTOP)
			expect(modules.some(leaf(name)), name).toBe(true);
		for (const name of BROWSER)
			expect(modules.some(leaf(name)), name).toBe(false);
	},
	BUNDLE_TIMEOUT,
);
