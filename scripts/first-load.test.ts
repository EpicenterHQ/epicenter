/**
 * The web's first load holds no desktop module (ADR-0781).
 *
 * One build serves a browser tab and a Tauri window, so each capability
 * decides where the page runs with `isTauri()` and loads its desktop
 * implementation when it connects or first acts. A static import of one
 * breaks no build and no test: the web would only carry it. This builds
 * every page source of each app with a desktop window and reads what loads
 * before any `import()`.
 *
 * Key behaviors:
 * - No app's first load holds a Tauri plugin or the shell's API beyond
 *   `isTauri()`'s module, nor a package's desktop implementation
 * - The one desktop part a first load may carry is the account's: it reads
 *   who is signed in from a setting at once, and asks the shell only when
 *   the person acts
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { firstLoadModules } from '../packages/vite-config/src/module-graph.ts';

const root = join(import.meta.dir, '..');

/** A desktop module: the shell's API beyond `core`, a Tauri plugin, or a package's desktop implementation. */
const DESKTOP = [
	/\/node_modules\/@tauri-apps\/(?!api\/(core|external\/tslib\/tslib\.es6)\.js$)/,
	/\/packages\/[^/]+\/(src|guest-js)\/(.+\/)?([\w-]+\.)?(tauri|relay|data-folder|desktop-folder|tauri-store|bindings\.gen)\.ts$/,
	/\/packages\/folder\/src\/native\//,
];

/** The account's desktop part, which reads a setting synchronously (`createTauriAuth`). */
const SMALL_DESKTOP_PART = ['/packages/account/src/tauri.ts'];

const desktopModules = (modules: readonly string[]) =>
	modules
		.filter((path) => DESKTOP.some((pattern) => pattern.test(path)))
		.filter((path) => !SMALL_DESKTOP_PART.some((part) => path.endsWith(part)))
		.map((path) => path.slice(path.indexOf(root) + root.length + 1));

for (const app of ['todos', 'capture', 'honeycrisp', 'vocab', 'whispering'])
	test(`${app}'s first load holds no desktop module`, async () => {
		const modules = await firstLoadModules(join(root, 'apps', app));
		// The page's own code is there, so the build read the app.
		expect(
			modules.some((path) => path.endsWith(`apps/${app}/src/lib/app.ts`)),
		).toBe(true);
		expect(desktopModules(modules)).toEqual([]);
	}, 180_000);
