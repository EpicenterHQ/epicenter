/**
 * Bundle Tests
 *
 * Bundles the shell's catalog and every first-party app's module through the shell's Vite resolution, as its build resolves them,
 * and reads every module the bundle pulls in.
 *
 * Key behaviors:
 * - The build carries no Yjs, Node, or Bun module, or the directory folder
 *   and Git host that run on them
 * - It opens the repository's browser host and carries no folder engine;
 *   only the folder's pure path helpers remain
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const shellDir = join(import.meta.dir, '..', '..');
const ENTRY = 'src/lib/bundle.test-support.ts';

const FORBIDDEN =
	/(^|\/)(@y[+/]|yjs[/@]|y-prosemirror[/@]|y-protocols[/@])|packages\/(auth|sync)\/src\//;
/** A Node or Bun built-in, or the directory folder and Git host that run on them. */
const NODE =
	/^(node|bun):|folder\/src\/(bun|directory-node)\.ts$|git\/native-host\.ts$/;

test(
	'the build carries no Yjs, Node, or Bun module, and keeps files in the repository, not a folder',
	async () => {
		const modules = await bundledModules(shellDir, ENTRY, 'browser');
		expect(modules.filter((path) => FORBIDDEN.test(path))).toEqual([]);
		expect(modules.filter((path) => NODE.test(path))).toEqual([]);
		expect(
			modules.some((path) =>
				path.endsWith('packages/repository/src/hosts/browser/index.ts'),
			),
		).toBe(true);
		expect(
			modules.some((path) => path.endsWith('apps/todos/src/TodosApp.svelte')),
		).toBe(true);
		expect(
			modules.some((path) =>
				path.endsWith('apps/honeycrisp/src/components/HoneycrispApp.svelte'),
			),
		).toBe(true);
		expect(
			modules.some((path) => path.endsWith('apps/files/src/FilesApp.svelte')),
		).toBe(true);
		expect(
			modules.filter((path) =>
				/packages\/folder\/src\/(?!file-browser|paths)/.test(path),
			),
		).toEqual([]);
	},
	BUNDLE_TIMEOUT,
);
