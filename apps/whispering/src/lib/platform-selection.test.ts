/**
 * Platform Selection Tests
 *
 * Bundles the `#platform/services` seam, the `@epicenter/folder`
 * specifier, and the recording contract (`@epicenter/recorder`, the same file
 * in every build) the way each build resolves them, with the conditions and
 * aliases `vite.config.ts` declares, and reads every module the bundle pulls
 * in. A dropped leaf or alias fails no build: resolution falls back silently,
 * so the selection is proved here.
 *
 * Key behaviors:
 * - The browser build reaches the browser services, the WebView microphone,
 *   and the Folder's runtime choice, and no Bun or Node module or the shell's
 *   recorder.
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

const PAGE_FORBIDDEN =
	/packages\/folder\/src\/(bun|directory-node)\.ts$|^node:|^bun:/;

describe('#platform/services', () => {
	test(
		'the browser build resolves the browser services over the folder mirror’s IndexedDB entry',
		async () => {
			const modules = await bundledModules(appDir, SEAM_ENTRY, 'browser');

			expect(reaches(modules, 'lib/platform/browser.ts')).toBe(true);
			expect(reaches(modules, 'lib/platform/auth.ts')).toBe(true);
			expect(modules.some(folderModule('browser.ts'))).toBe(true);
			expect(modules.some(folderModule('browser/repository.ts'))).toBe(true);
			expect(modules.some(folderModule('index.ts'))).toBe(true);
			expect(modules.some(folderModule('tauri.ts'))).toBe(true);
			expect(modules.some(recorderModule('browser.ts'))).toBe(true);
			expect(reaches(modules, 'lib/webview-microphone.ts')).toBe(true);
			expect(
				modules.filter(
					(path) =>
						PAGE_FORBIDDEN.test(path) ||
						/packages\/recorder\/src\/tauri\.ts$/.test(path),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);
});

test('the browser folder refuses to open inside the desktop app', async () => {
	const { openFolder } = await import('@epicenter/folder/browser');
	// SAFETY: Tauri marks its pages with this flag; the test restores the global.
	const scope = globalThis as { isTauri?: boolean };
	scope.isTauri = true;
	try {
		const opened = await openFolder({ tables: {} });
		expect(opened.error?.name).toBe('InsideTauri');
	} finally {
		delete scope.isTauri;
	}
});
