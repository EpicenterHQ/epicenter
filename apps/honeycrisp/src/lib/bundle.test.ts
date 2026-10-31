/**
 * Bundle Tests
 *
 * Bundles the notes and editor modules through the app's Vite resolution, as
 * the browser build resolves them, and reads every module the bundle pulls in.
 *
 * Key behaviors:
 * - The browser build carries no Yjs, Node, or Bun module, or the directory
 *   folder and Git host that run on them
 * - It carries both folder engines behind one runtime choice
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const appDir = join(import.meta.dir, '..', '..');

const FORBIDDEN =
	/(^|\/)(@y[+/]|yjs[/@]|y-prosemirror[/@]|y-protocols[/@])|packages\/(auth|sync)\/src\//;
/** A Node or Bun built-in, or the directory folder and Git host that run on them. */
const NODE =
	/^(node|bun):|folder\/src\/(bun|directory-node)\.ts$|git\/native-host\.ts$/;

test(
	'the browser build carries no Yjs, Node, or Bun module',
	async () => {
		const modules = await bundledModules(
			appDir,
			'src/lib/bundle.test-support.ts',
		);
		expect(modules.filter((path) => FORBIDDEN.test(path))).toEqual([]);
		expect(modules.filter((path) => NODE.test(path))).toEqual([]);
	},
	BUNDLE_TIMEOUT,
);

/** A module of `@epicenter/folder`, by its path below its `src/`. */
const folderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/folder/src/${name}`);

test(
	'the published build carries the runtime choice and both folder engines',
	async () => {
		const modules = await bundledModules(
			appDir,
			'src/lib/bundle.test-support.ts',
		);
		expect(modules.some(folderModule('browser.ts'))).toBe(true);
		expect(modules.some(folderModule('browser/repository.ts'))).toBe(true);
		expect(modules.some(folderModule('index.ts'))).toBe(true);
		expect(modules.some(folderModule('tauri.ts'))).toBe(true);
	},
	BUNDLE_TIMEOUT,
);
