/**
 * Hosted SPA identity tests.
 *
 * Whispering is one SPA with browser and Epicenter build environments. It keeps
 * its app routes and platform adapters, while Epicenter owns the native
 * desktop identity.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const REPO_ROOT = join(ROOT, '..', '..');
const read = (name: string) => readFileSync(join(ROOT, name), 'utf8');

describe('Epicenter-hosted Whispering identity', () => {
	test('the canonical package is the independently hostable SPA', () => {
		expect(JSON.parse(read('package.json')).name).toBe('@epicenter/whispering');
		expect(existsSync(join(ROOT, 'src-tauri'))).toBe(false);
		expect(existsSync(join(REPO_ROOT, 'apps/epicenter/whispering'))).toBe(
			false,
		);
		expect(existsSync(join(REPO_ROOT, 'apps/epicenter/src-tauri'))).toBe(true);
	});

	test('the dev tab and the Epicenter build own distinct base paths and outputs', () => {
		const config = read('svelte.config.js');
		const vite = read('vite.config.ts');
		expect(config).toContain("pages: '../epicenter/dist/whispering'");
		expect(config).toContain("paths: { base: '/apps/whispering' }");
		expect(vite).toContain("process.env.EPICENTER_HOST === '1'");
		expect(vite).not.toContain('TAURI_ENV_PLATFORM');
		expect(vite).not.toContain('TAURI_DEV_HOST');
		// Base path is not a seam (ADR-0347): SvelteKit's `base` carries the prefix
		// into every `resolve` call, so no leaf states it a second time.
		expect(
			existsSync(join(ROOT, 'src/lib/platform/base-path.browser.ts')),
		).toBe(false);
		expect(existsSync(join(ROOT, 'src/lib/constants/urls.ts'))).toBe(false);
	});

	test('the canonical SPA no longer documents the retired native identifier', () => {
		expect(read('src/lib/services/fs-paths.ts')).not.toContain(
			'so.epicenter.whispering',
		);
		expect(read('src/lib/services/fs-paths.ts')).toContain('so.epicenter');
	});

	test('desktop auth uses the Bun authority instead of a window OAuth launcher', () => {
		// The serve-time snapshot moved into `createDesktopBrokerAuth` as a
		// defaulted argument once `#platform/instance` went and left one reader,
		// so this leaf names the constructor and nothing else.
		const auth = read('src/lib/platform/auth.epicenter-host.ts');
		expect(auth).toContain('createDesktopBrokerAuth');
		expect(auth).not.toContain('createHostedDeepLinkAuth');
		expect(auth).not.toContain('keyring');
	});
});
