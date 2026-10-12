/**
 * Platform Selection Tests
 *
 * A dropped seam leaf fails no build: resolution falls back to `default` and
 * the desktop page quietly opens a browser folder in OPFS. These tests
 * bundle through the app's Vite resolution config and name what broke.
 *
 * Key behaviors:
 * - The host leaf opens through the desktop folder adapter only: the browser
 *   leaf, the browser adapter and its OPFS store, any Git implementation,
 *   the directory opener, and every Node module are absent from its bundle
 * - The host leaf carries, of the host package, only its page side of the
 *   close flush
 * - The browser leaf carries the browser adapter and no desktop adapter, no
 *   generated native bindings, and no host signals
 * - Neither folder leaf loads the account recovery store
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

/** Every module that reaches a bundle of `entry`, as paths. Built in its own process. */
async function inputs(
	entry: string,
	platform: 'browser' | 'epicenter-host',
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

const SEAM_ENTRY = 'src/lib/platform-selection.test-support.ts';

describe('#platform/folder', () => {
	test(
		'the host build opens through the desktop adapter and carries nothing that stores a folder',
		async () => {
			const modules = await inputs(SEAM_ENTRY, 'epicenter-host');
			for (const required of [
				'platform/folder.epicenter-host.ts',
				'epicenter/src/host-stopped.ts',
				'folder/src/tauri.ts',
				'folder/src/tauri-adapter.ts',
				'folder/src/native/bindings.gen.ts',
			])
				expect(modules.filter((path) => path.endsWith(required))).toHaveLength(
					1,
				);
			expect(
				modules.filter((path) =>
					/platform\/folder\.browser\.ts$|folder\/src\/(browser|browser-adapter|opfs-store|bun|native-store)\.ts$|folder\/src\/git\/(browser|native)-|isomorphic-git|^node:|^bun:/.test(
						path,
					),
				),
			).toEqual([]);
			expect(
				modules.filter((path) => /legacy\/|open-store\.ts$|@y[+/]/.test(path)),
			).toEqual([]);
			// Of the host package, only its page side of the host-stopped signal:
			// never the Bun host.
			expect(
				modules.filter(
					(path) =>
						/epicenter\/src\//.test(path) &&
						!/epicenter\/src\/host-stopped\.ts$/.test(path),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);

	test(
		'the browser build opens through the browser adapter, with no desktop adapter and no host signals',
		async () => {
			const modules = await inputs(SEAM_ENTRY, 'browser');
			for (const required of [
				'platform/folder.browser.ts',
				'folder/src/browser.ts',
				'folder/src/browser-adapter.ts',
				'folder/src/opfs-store.ts',
			])
				expect(modules.filter((path) => path.endsWith(required))).toHaveLength(
					1,
				);
			expect(
				modules.filter((path) =>
					/folder\/src\/browser-(store|migration)\.ts$|fake-indexeddb/.test(
						path,
					),
				),
			).toEqual([]);
			expect(
				modules.filter((path) =>
					// The browser adapter asks `isTauri()` so it can refuse there; that one
					// module of the Tauri API is its only use of it.
					/platform\/folder\.epicenter-host\.ts$|epicenter\/src\/|folder\/src\/(tauri|tauri-adapter|bun|native-store)\.ts$|folder\/src\/native\/|@tauri-apps\/api\/(event|webviewWindow)|^bun:/.test(
						path,
					),
				),
			).toEqual([]);
			expect(
				modules.filter((path) => /legacy\/|open-store\.ts$|@y[+/]/.test(path)),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);
});
