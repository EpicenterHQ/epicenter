/**
 * Platform Selection Tests
 *
 * Bundles the `#platform/services` seam, the bare `@epicenter/folder`
 * specifier, and the recording contract (`@epicenter/recorder`, the same file
 * in every build) the way each build resolves them, with the conditions and
 * aliases `vite.config.ts` declares, and reads every module the bundle pulls
 * in. A dropped leaf or alias fails no build: resolution falls back silently,
 * so the selection is proved here.
 *
 * Key behaviors:
 * - The host build reaches the desktop services, the desktop adapter, the
 *   shell's recorder, and the generated bindings, and no browser services,
 *   OPFS Git, isomorphic-git, or code that opens a microphone in the WebView
 *   (`getUserMedia`, `enumerateDevices`, `MediaRecorder`, `AudioContext`)
 * - The browser build reaches the browser services, isomorphic-git, and the
 *   WebView microphone, and no desktop services, desktop adapter, shell
 *   recorder, or generated bindings
 * - Neither build reaches the folder's automatic entry, which loads either
 *   adapter, or a Bun or Node module
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const appDir = join(import.meta.dir, '..', '..');

const SEAM_ENTRY = 'src/lib/platform-selection.test-support.ts';

/** Modules of `@epicenter/recorder`, by their path below its `src/`. */
const recorderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/recorder/src/${name}`);

/** Modules of `@epicenter/folder`, by their path below its `src/`. */
const folderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/folder/src/${name}`);
const reaches = (modules: string[], suffix: string) =>
	modules.some((path) => path.endsWith(suffix));

/** The folder's automatic entry, which can load either adapter, and Bun or Node. */
const SHARED_FORBIDDEN =
	/packages\/folder\/src\/index\.ts$|packages\/folder\/src\/(bun|directory-node)\.ts$|^node:|^bun:/;

describe('#platform/services', () => {
	test(
		'the host build resolves the desktop services over the native folder',
		async () => {
			const modules = await bundledModules(
				appDir,
				SEAM_ENTRY,
				'epicenter-host',
			);

			expect(reaches(modules, 'lib/platform/desktop/services.ts')).toBe(true);
			expect(reaches(modules, 'lib/platform/desktop/auth.ts')).toBe(true);
			expect(reaches(modules, 'lib/tauri/bindings.gen.ts')).toBe(true);
			expect(modules.some(folderModule('tauri.ts'))).toBe(true);
			expect(modules.some(folderModule('native/tauri.ts'))).toBe(true);
			expect(modules.some(recorderModule('tauri.ts'))).toBe(true);
			expect(reaches(modules, 'lib/platform/desktop/microphone.ts')).toBe(true);
			expect(
				modules.filter(
					(path) =>
						SHARED_FORBIDDEN.test(path) ||
						/lib\/platform\/browser\.ts$|lib\/webview-microphone\.ts$|packages\/folder\/src\/(browser|browser-adapter)\.ts$|packages\/folder\/src\/git\/(opfs-git|browser-backend)\.ts$|packages\/recorder\/src\/(browser|microphone|vad-recorder)\.ts$|@ricky0123|isomorphic-git/.test(
							path,
						),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);

	test(
		'the browser build resolves the browser services over the IndexedDB repository',
		async () => {
			const modules = await bundledModules(appDir, SEAM_ENTRY, 'browser');

			expect(reaches(modules, 'lib/platform/browser.ts')).toBe(true);
			expect(reaches(modules, 'lib/platform/auth.ts')).toBe(true);
			expect(modules.some(folderModule('browser.ts'))).toBe(true);
			expect(modules.some(folderModule('local-folder.ts'))).toBe(true);
			expect(modules.some(folderModule('browser/repository.ts'))).toBe(true);
			expect(modules.some(recorderModule('browser.ts'))).toBe(true);
			expect(reaches(modules, 'lib/webview-microphone.ts')).toBe(true);
			expect(
				modules.filter(
					(path) =>
						SHARED_FORBIDDEN.test(path) ||
						/lib\/platform\/desktop\/|lib\/tauri\/bindings\.gen\.ts$|packages\/folder\/src\/(tauri|tauri-adapter|tauri-handed-folder)\.ts$|packages\/(folder|recorder)\/src\/native\/|packages\/recorder\/src\/tauri\.ts$/.test(
							path,
						),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);
});
