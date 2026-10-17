/**
 * Platform Selection Tests
 *
 * Bundles the `#platform/auth` seam the way each build resolves it, with the
 * conditions `vite.config.ts` declares, and reads every module the bundle
 * pulls in. A dropped leaf fails no build: resolution falls back silently,
 * so the selection is proved here. The folder needs no seam: `<FolderApp>`
 * opens it with `@epicenter/folder`, which picks the host when it is called
 * and never opens browser storage in the desktop app (proved in
 * `packages/folder/src/entries.test.ts`).
 *
 * Key behaviors:
 * - The host build reaches the desktop broker account, and no redirect sign-in
 * - The browser build reaches redirect sign-in, and no desktop broker account
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	BUNDLE_TIMEOUT,
	bundledModules,
} from '@epicenter/vite-config/module-graph';

const appDir = join(import.meta.dir, '..', '..');

const SEAM_ENTRY = 'src/lib/platform-selection.test-support.ts';

describe('#platform/auth', () => {
	test(
		'the host build borrows the desktop account through the CLI, never redirect sign-in',
		async () => {
			const modules = await bundledModules(
				appDir,
				SEAM_ENTRY,
				'epicenter-host',
			);
			for (const module of [
				'platform/auth.epicenter-host.ts',
				'auth/src/desktop-account-auth.ts',
				'src/lib/remote.ts',
			])
				expect(modules.some((path) => path.endsWith(module))).toBe(true);
			expect(
				modules.filter((path) =>
					/platform\/auth\.browser\.ts$|auth\/src\/browser-oauth\.ts$/.test(
						path,
					),
				),
			).toEqual([]);
			// Nothing of the host's Bun entry reaches the window.
			expect(
				modules.filter((path) =>
					/apps\/epicenter\/src\/|^node:|^bun:/.test(path),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);

	test(
		'the browser build signs in by redirect, never through the desktop account',
		async () => {
			const modules = await bundledModules(appDir, SEAM_ENTRY, 'browser');
			for (const module of [
				'platform/auth.browser.ts',
				'auth/src/browser-oauth.ts',
				'src/lib/remote.ts',
			])
				expect(modules.some((path) => path.endsWith(module))).toBe(true);
			expect(
				modules.filter((path) =>
					/platform\/auth\.epicenter-host\.ts$|auth\/src\/desktop-account-auth\.ts$|apps\/epicenter\//.test(
						path,
					),
				),
			).toEqual([]);
		},
		BUNDLE_TIMEOUT,
	);
});
