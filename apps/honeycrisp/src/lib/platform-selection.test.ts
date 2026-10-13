/**
 * Platform Selection Tests
 *
 * Vite resolves the page seam with the aliases and conditions from the app
 * config. A desktop build must attach to the shell, never browser storage.
 *
 * Key behaviors:
 * - Neither page bundle contains a Yjs, Node, or Bun module
 * - The desktop page reaches its folder through the shell's folder owner
 *   only: no browser folder store and no Git implementation in the page
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const appDir = join(import.meta.dir, '..', '..');
/**
 * Each test runs a Vite production build of the app's resolution graph. It
 * takes under a second alone, but `bun run check` tests every package at
 * once, and on CI's 4-vCPU runner one build outlasted the default 5s.
 */
const BUNDLE_TIMEOUT = 30_000;

/** Every module a bundle of `entry` pulls in, as paths. Built in its own process. */
async function inputs(
	entry: string,
	platform: 'browser' | 'tauri',
): Promise<string[]> {
	const child = Bun.spawn(
		[
			process.execPath,
			join(appDir, 'scripts', 'module-graph.ts'),
			entry,
			platform,
		],
		{ cwd: appDir, stdout: 'pipe', stderr: 'pipe' },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`Bundling ${entry} failed:\n${stderr}`);
	return JSON.parse(stdout) as string[];
}

const FORBIDDEN =
	/(^|\/)(@y[+/]|yjs[\/@]|y-prosemirror[\/@]|y-protocols[\/@])|packages\/(auth|sync)\/src\//;
/** A Node or Bun built-in, or the directory folder that runs on them. */
const NODE =
	/^(node|bun):|folder\/src\/(bun|native-store)\.ts$|git\/native-backend\.ts$/;

describe('bundles', () => {
	test(
		'the desktop page reaches its folder through the shell only',
		async () => {
			const modules = await inputs(
				'src/lib/platform-selection.test-support.ts',
				'tauri',
			);
			expect(modules.filter((path) => FORBIDDEN.test(path))).toEqual([]);
			expect(modules.filter((path) => NODE.test(path))).toEqual([]);
			expect(
				modules.some((path) => path.endsWith('folder/src/tauri-adapter.ts')),
			).toBe(true);
			expect(
				modules.some((path) => path.endsWith('platform/shell.tauri.ts')),
			).toBe(true);
			// One set of bindings: the ones the folder package generated.
			expect(
				modules
					.filter((path) => path.endsWith('bindings.gen.ts'))
					.map((path) => path.slice(path.indexOf('packages/'))),
			).toEqual(['packages/folder/src/native/bindings.gen.ts']);
			// The folder contract came through the desktop entry, not the selector.
			expect(
				modules.filter((path) =>
					/folder\/src\/(index|browser)\.ts$/.test(path),
				),
			).toEqual([]);
			// No second store, and no Git implementation in the page.
			expect(
				modules.filter((path) =>
					/folder\/src\/(browser-adapter|opfs-store)\.ts$|folder\/src\/git\/(history|browser-backend)\.ts$/.test(
						path,
					),
				),
			).toEqual([]);
			expect(modules.filter((path) => path.includes('isomorphic-git'))).toEqual(
				[],
			);
		},
		BUNDLE_TIMEOUT,
	);

	test(
		'the browser page opens a browser folder without Yjs or a native path',
		async () => {
			const modules = await inputs(
				'src/lib/platform-selection.test-support.ts',
				'browser',
			);
			expect(modules.filter((path) => FORBIDDEN.test(path))).toEqual([]);
			expect(modules.filter((path) => NODE.test(path))).toEqual([]);
			expect(
				modules.some((path) => path.endsWith('folder/src/opfs-store.ts')),
			).toBe(true);
			expect(
				modules.filter((path) =>
					/folder\/src\/browser-(store|migration)\.ts$|fake-indexeddb/.test(
						path,
					),
				),
			).toEqual([]);
			// No desktop adapter, no bindings, and none of the shell's commands.
			expect(
				modules.filter((path) =>
					/folder\/src\/(index|tauri|tauri-adapter)\.ts$|bindings\.gen\.ts$|platform\/shell\.tauri\.ts$/.test(
						path,
					),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);
});
