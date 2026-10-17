/**
 * Bundle Tests
 *
 * Bundles the notes and editor modules through the app's Vite resolution, as
 * each build resolves them, and reads every module the bundle pulls in.
 *
 * Key behaviors:
 * - Neither build carries a Yjs, Node, or Bun module, or the directory
 *   folder and Git host that run on them
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

test.each(['epicenter-host', 'browser'] as const)(
	'the %s build carries no Yjs, Node, or Bun module',
	async (build) => {
		const modules = await bundledModules(
			appDir,
			'src/lib/bundle.test-support.ts',
			build,
		);
		expect(modules.filter((path) => FORBIDDEN.test(path))).toEqual([]);
		expect(modules.filter((path) => NODE.test(path))).toEqual([]);
	},
	BUNDLE_TIMEOUT,
);
