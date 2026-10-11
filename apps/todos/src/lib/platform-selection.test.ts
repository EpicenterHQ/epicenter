/**
 * Platform Selection Tests
 *
 * Bundles the `#platform/folder` seam the way each build resolves it, with
 * the conditions and aliases `vite.config.ts` declares, and reads every module
 * the bundle pulls in. A dropped leaf or alias fails no build: resolution
 * falls back silently, so the selection is proved here.
 *
 * Key behaviors:
 * - The host build reaches the desktop adapter and its generated bindings,
 *   and no OPFS storage, directory opener, or Git implementation
 * - The browser build reaches OPFS storage and isomorphic-git, and no
 *   desktop adapter or generated bindings
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
		'the host build resolves the desktop adapter without OPFS storage, a directory opener, or a Git implementation',
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
			// The close leaf reaches the host's published page side and this
			// window's Tauri API, never the host's Bun entry.
			expect(
				modules.some((path) =>
					path.endsWith('platform/close.epicenter-host.ts'),
				),
			).toBe(true);
			expect(
				modules.some((path) =>
					path.endsWith('apps/epicenter/src/page-close.ts'),
				),
			).toBe(true);
			expect(
				modules.some((path) => /@tauri-apps\/api\/.*webviewWindow/.test(path)),
			).toBe(true);
			expect(
				modules.filter(
					(path) =>
						/apps\/epicenter\/src\/(?!page-close\.ts$)/.test(path) ||
						/platform\/close\.browser\.ts$/.test(path),
				),
			).toEqual([]);
			expect(
				modules.filter(
					(path) =>
						SHARED_FORBIDDEN.test(path) ||
						/platform\/folder\.browser\.ts$|packages\/folder\/src\/(browser|browser-adapter|opfs-store|buffer-global|bun|native-store)\.ts$|packages\/folder\/src\/git\/(browser-backend|browser-fs|http|history|native-backend|native-checkpoint|runner)\.ts$|isomorphic-git|^node:|^bun:/.test(
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
			// The browser has no host close signal and reaches nothing of the host's.
			expect(
				modules.some((path) => path.endsWith('platform/close.browser.ts')),
			).toBe(true);
			expect(
				modules.filter((path) =>
					/apps\/epicenter\/|platform\/close\.epicenter-host\.ts$|@tauri-apps\/api\/.*webviewWindow/.test(
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
						/platform\/folder\.epicenter-host\.ts$|packages\/folder\/src\/(tauri|tauri-adapter|bun|native-store)\.ts$|packages\/folder\/src\/native\/|packages\/folder\/src\/git\/(native-backend|native-checkpoint)\.ts$|tauri-plugin-epicenter-folder|^bun:/.test(
							path,
						),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);
});
