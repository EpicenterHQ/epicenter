/**
 * Platform Selection Tests
 *
 * Bundles the `#platform/*` seams the way each build resolves them, with
 * the conditions and aliases `vite.config.ts` declares, and reads every module
 * the bundle pulls in. A dropped leaf or alias fails no build: resolution
 * falls back silently, so the selection is proved here.
 *
 * Key behaviors:
 * - The host build reaches the desktop adapter and its generated bindings,
 *   and no OPFS storage, directory opener, or Git implementation
 * - The host build reaches the desktop broker account, and no redirect sign-in
 * - The browser build reaches OPFS storage and isomorphic-git, and no
 *   desktop adapter or generated bindings
 * - The browser build reaches redirect sign-in, and no desktop broker account
 * - Neither build reaches the automatic entry, which loads either adapter,
 *   or `@epicenter/app`
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

/** Every module a build of `entry` pulls in, as paths. Built in its own process. */
async function inputs(
	entry: string,
	build: 'browser' | 'epicenter-host',
): Promise<string[]> {
	const child = Bun.spawn(
		[
			process.execPath,
			join(appDir, 'scripts', 'module-graph.ts'),
			entry,
			build,
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

/** Modules of `@epicenter/folder`, by their path below its `src/`. */
const folderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/folder/src/${name}`);

/** The automatic entry, which can load either adapter, and anything of App's. */
const SHARED_FORBIDDEN = /packages\/folder\/src\/index\.ts$|packages\/app\//;

describe('#platform/folder', () => {
	test(
		'the host build resolves the desktop adapter and the directory folder over the granted directory, never the browser folder or a Bun or Node module',
		async () => {
			const modules = await inputs(SEAM_ENTRY, 'epicenter-host');

			expect(
				modules.some((path) =>
					path.endsWith('platform/folder.epicenter-host.ts'),
				),
			).toBe(true);
			expect(modules.some(folderModule('tauri.ts'))).toBe(true);
			expect(modules.some(folderModule('tauri-adapter.ts'))).toBe(true);
			expect(modules.some(folderModule('native/bindings.gen.ts'))).toBe(true);
			// Todos is a page-engine folder: the shell grants its directory and
			// the page reads, writes, and records history there itself.
			for (const engine of [
				'tauri-directory.ts',
				'directory-adapter.ts',
				'directory-handle.ts',
				'directory-tauri.ts',
				'tauri-git.ts',
				'git/native-backend.ts',
				'git/history.ts',
			])
				expect(modules.some(folderModule(engine))).toBe(true);
			// It reads through the folder plugin's commands, not the fs plugin.
			expect(modules.some((path) => /@tauri-apps\/plugin-fs/.test(path))).toBe(
				false,
			);
			// The departure leaf reaches the host's published wire, its window
			// port, and this window's Tauri API, never the host's Bun entry.
			expect(
				modules.some((path) =>
					path.endsWith('platform/departure.epicenter-host.ts'),
				),
			).toBe(true);
			for (const published of ['departure-wire.ts', 'departure-window.ts'])
				expect(
					modules.some((path) =>
						path.endsWith(`apps/epicenter/src/${published}`),
					),
				).toBe(true);
			expect(
				modules.some((path) => /@tauri-apps\/api\/.*webviewWindow/.test(path)),
			).toBe(true);
			expect(
				modules.filter(
					(path) =>
						/apps\/epicenter\/src\/(?!departure-(wire|window)\.ts$)/.test(
							path,
						) || /platform\/departure\.browser\.ts$/.test(path),
				),
			).toEqual([]);
			expect(
				modules.filter(
					(path) =>
						SHARED_FORBIDDEN.test(path) ||
						/platform\/folder\.browser\.ts$|packages\/folder\/src\/(browser|browser-adapter|bun|directory-node)\.ts$|packages\/folder\/src\/git\/(opfs-git|native-host)\.ts$|^node:|^bun:/.test(
							path,
						),
				),
			).toEqual([]);
			// The desktop window borrows Home's account through the host.
			for (const module of [
				'platform/auth.epicenter-host.ts',
				'auth/src/desktop-broker-auth.ts',
				'src/lib/git-access.ts',
			])
				expect(modules.some((path) => path.endsWith(module))).toBe(true);
			expect(
				modules.filter((path) =>
					/platform\/auth\.browser\.ts$|auth\/src\/browser-redirect-auth\.ts$/.test(
						path,
					),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);

	test(
		'the browser build resolves the OPFS adapter without the desktop adapter or its bindings',
		async () => {
			const modules = await inputs(SEAM_ENTRY, 'browser');

			expect(
				modules.some((path) => path.endsWith('platform/folder.browser.ts')),
			).toBe(true);
			expect(modules.some(folderModule('browser.ts'))).toBe(true);
			expect(modules.some(folderModule('browser-adapter.ts'))).toBe(true);
			expect(modules.some(folderModule('opfs-store.ts'))).toBe(true);
			expect(modules.some((path) => path.includes('isomorphic-git'))).toBe(
				true,
			);
			// The browser has no departure port and reaches nothing of the host's.
			expect(
				modules.some((path) => path.endsWith('platform/departure.browser.ts')),
			).toBe(true);
			expect(
				modules.filter((path) =>
					/apps\/epicenter\/|platform\/departure\.epicenter-host\.ts$|@tauri-apps\/api\/.*webviewWindow/.test(
						path,
					),
				),
			).toEqual([]);
			expect(
				modules.filter((path) =>
					/folder\/src\/browser-(store|migration)\.ts$|fake-indexeddb/.test(
						path,
					),
				),
			).toEqual([]);
			expect(
				modules.filter(
					(path) =>
						SHARED_FORBIDDEN.test(path) ||
						/platform\/folder\.epicenter-host\.ts$|packages\/folder\/src\/(tauri|tauri-adapter|bun)\.ts$|packages\/folder\/src\/native\/|packages\/folder\/src\/git\/(native-backend|native-checkpoint)\.ts$|tauri-plugin-epicenter-folder|^bun:/.test(
							path,
						),
				),
			).toEqual([]);
			// Redirect sign-in is the browser's.
			for (const module of [
				'platform/auth.browser.ts',
				'auth/src/browser-redirect-auth.ts',
				'src/lib/git-access.ts',
			])
				expect(modules.some((path) => path.endsWith(module))).toBe(true);
			expect(
				modules.filter((path) =>
					/platform\/auth\.epicenter-host\.ts$|auth\/src\/desktop-broker-auth\.ts$/.test(
						path,
					),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);
});
