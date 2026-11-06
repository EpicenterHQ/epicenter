/**
 * Messages Platform Seam Tests
 *
 * Verifies that web and desktop builds select different startup roots.
 *
 * Key behaviors:
 * - The web build carries the demo-capable startup
 * - The desktop build carries only the local-program startup
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
	path.endsWith(`apps/messages/src/lib/${name}`);

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
	'the web build carries the demo startup, not the desktop root',
	async () => {
		const modules = await bundle(false);
		expect(modules.some(leaf('root.ts'))).toBe(true);
		expect(modules.some(leaf('Startup.svelte'))).toBe(true);
		expect(modules.some(leaf('root.tauri.ts'))).toBe(false);
		expect(modules.some(leaf('DesktopStartup.svelte'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);

test(
	'the desktop build carries the local-only startup, not the demo root',
	async () => {
		const modules = await bundle(true);
		expect(modules.some(leaf('root.tauri.ts'))).toBe(true);
		expect(modules.some(leaf('DesktopStartup.svelte'))).toBe(true);
		expect(modules.some(leaf('root.ts'))).toBe(false);
		expect(modules.some(leaf('Startup.svelte'))).toBe(false);
	},
	BUNDLE_TIMEOUT,
);
