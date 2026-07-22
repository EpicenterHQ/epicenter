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
import {
	normalizeWhisperingPath,
	whisperingPath,
} from '../src/lib/constants/urls';

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

	test('the browser and Epicenter builds own distinct base paths and outputs', () => {
		const config = read('svelte.config.js');
		const vite = read('vite.config.ts');
		expect(config).toContain("pages: '../epicenter/dist/whispering'");
		expect(config).toContain("paths: { base: '/apps/whispering' }");
		expect(vite).toContain("process.env.EPICENTER_SURFACE === '1'");
		expect(vite).not.toContain('TAURI_ENV_PLATFORM');
		expect(vite).not.toContain('TAURI_DEV_HOST');
		expect(read('src/lib/platform/base-path.browser.ts')).toContain(
			"WHISPERING_BASE_PATHNAME = ''",
		);
		expect(read('src/lib/platform/base-path.tauri.ts')).toContain(
			"WHISPERING_BASE_PATHNAME = '/apps/whispering'",
		);
		expect(whisperingPath('/')).toBe('/');
		expect(whisperingPath('/recording-overlay')).toBe('/recording-overlay');
		expect(normalizeWhisperingPath('/settings')).toBe('/settings');
	});

	test('native recording storage belongs entirely to the Epicenter host', () => {
		expect(existsSync(join(ROOT, 'src/lib/services/fs-paths.ts'))).toBe(false);
		const recorder = read('src/lib/services/recorder/index.tauri.ts');
		expect(recorder).not.toContain('appDataDir');
		expect(recorder).not.toContain('join(');
		expect(recorder).toContain("kind: 'native-capture'");
	});

	test('desktop auth uses the Bun authority instead of a window OAuth launcher', () => {
		const auth = read('src/lib/platform/auth.tauri.ts');
		const bootstrap = read('src/lib/platform/desktop-auth-bootstrap.tauri.ts');
		const instance = read('src/lib/platform/instance.tauri.ts');
		expect(auth).toContain('createDesktopBrokerAuth');
		expect(bootstrap).toContain('epicenter-auth-bootstrap');
		expect(instance).toContain('createDesktopInstanceSetting');
		expect(instance).not.toContain('createInstanceSetting');
		expect(auth).not.toContain('createHostedDeepLinkAuth');
		expect(auth).not.toContain('keyring');
	});
});
