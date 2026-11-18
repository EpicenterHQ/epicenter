/**
 * The web's first load holds no desktop module (ADR-0781).
 *
 * One build serves a browser tab and a Tauri window, so each capability
 * decides where the page runs with `isTauri()` and loads its desktop
 * implementation when it connects or first acts. A static import of one
 * breaks no build and no test: the web would only carry it. This builds
 * every page source of Whispering and reads what loads
 * before any `import()`.
 *
 * Key behaviors:
 * - Whispering's first load holds no Tauri plugin and none of the shell's
 *   API beyond `isTauri()`'s module, nor a package's desktop
 *   implementation. Its own `files/tauri.ts` loads with the page and loads
 *   the file system plugin when it first reads or writes.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { firstLoadModules } from '../packages/vite-config/src/module-graph.ts';

const root = join(import.meta.dir, '..');

/** A desktop module: the shell's API beyond `core`, a Tauri plugin, or a package's desktop implementation. */
const DESKTOP = [
	/\/node_modules\/@tauri-apps\/(?!api\/(core|external\/tslib\/tslib\.es6)\.js$)/,
	/\/packages\/[^/]+\/(src|guest-js)\/(.+\/)?([\w-]+\.)?(tauri|bindings\.gen)\.ts$/,
];

const desktopModules = (modules: readonly string[]) =>
	modules
		.filter((path) => DESKTOP.some((pattern) => pattern.test(path)))
		.map((path) => path.slice(path.indexOf(root) + root.length + 1));

test("Whispering's first load holds no desktop module", async () => {
	const modules = await firstLoadModules(root);
	// The page's own code is there, so the build read the app.
	expect(
		modules.some((path) => path.endsWith('apps/whispering/src/lib/app.ts')),
	).toBe(true);
	expect(desktopModules(modules)).toEqual([]);
}, 180_000);
