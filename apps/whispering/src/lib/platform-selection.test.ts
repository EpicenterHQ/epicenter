/**
 * Platform Selection Tests
 *
 * Bundles the `#platform/workspace` seam and the bare `@epicenter/folder`
 * specifier the way each build resolves them, with the conditions and
 * aliases `vite.config.ts` declares, and reads every module the bundle pulls
 * in. A dropped leaf or alias fails no build: resolution falls back silently,
 * so the selection is proved here.
 *
 * Key behaviors:
 * - The host build reaches the desktop workspace, the desktop adapter, and
 *   the generated bindings, and no browser workspace, OPFS Git, or
 *   isomorphic-git
 * - The browser build reaches the browser workspace and isomorphic-git, and
 *   no desktop workspace, desktop adapter, or generated bindings
 * - Neither build reaches the automatic entry, which loads either adapter,
 *   or a Bun or Node module
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const appDir = join(import.meta.dir, '..', '..');

const SEAM_ENTRY = 'src/lib/platform-selection.test-support.ts';

/** Modules of `@epicenter/folder`, by their path below its `src/`. */
const folderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/folder/src/${name}`);
const reaches = (modules: string[], suffix: string) =>
	modules.some((path) => path.endsWith(suffix));

/** The automatic entry, which can load either adapter, and Bun or Node. */
const SHARED_FORBIDDEN =
	/packages\/folder\/src\/(index|bun|directory-node)\.ts$|^node:|^bun:/;

describe('#platform/workspace', () => {
	test(
		'the host build resolves the desktop workspace over the desktop adapter, never the browser workspace or its Git',
		async () => {
			const modules = await bundledModules(
				appDir,
				SEAM_ENTRY,
				'epicenter-host',
			);

			expect(reaches(modules, 'lib/workspace/desktop.ts')).toBe(true);
			expect(reaches(modules, 'lib/tauri/bindings.gen.ts')).toBe(true);
			expect(modules.some(folderModule('tauri.ts'))).toBe(true);
			expect(modules.some(folderModule('tauri-adapter.ts'))).toBe(true);
			expect(
				modules.filter(
					(path) =>
						SHARED_FORBIDDEN.test(path) ||
						/lib\/workspace\/browser\.ts$|packages\/folder\/src\/(browser|browser-adapter)\.ts$|packages\/folder\/src\/git\/(opfs-git|browser-backend)\.ts$|isomorphic-git/.test(
							path,
						),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);

	test(
		'the browser build resolves the browser workspace over OPFS, never the desktop workspace or adapter',
		async () => {
			const modules = await bundledModules(appDir, SEAM_ENTRY, 'browser');

			expect(reaches(modules, 'lib/workspace/browser.ts')).toBe(true);
			expect(modules.some(folderModule('browser.ts'))).toBe(true);
			expect(modules.some(folderModule('browser-adapter.ts'))).toBe(true);
			expect(modules.some((path) => path.includes('isomorphic-git'))).toBe(
				true,
			);
			expect(
				modules.filter(
					(path) =>
						SHARED_FORBIDDEN.test(path) ||
						/lib\/workspace\/desktop(-connections)?\.ts$|lib\/tauri\/bindings\.gen\.ts$|packages\/folder\/src\/(tauri|tauri-adapter|tauri-handed-folder)\.ts$|packages\/folder\/src\/native\//.test(
							path,
						),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);
});
