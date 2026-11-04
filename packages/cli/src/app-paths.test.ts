/**
 * Where the CLI reads and writes, by the desktop shell's rule.
 *
 * Key behaviors:
 * - The stated environment selects the root
 * - Only the application data directory accepts an absolute override
 */
import { expect, test } from 'bun:test';
import { resolveAppPaths } from './app-paths.ts';

const home = '/home/me';

test("without overrides, the release app's directories", () => {
	expect(resolveAppPaths({}, home)).toEqual({
		dataDir: '/home/me/Library/Application Support/so.epicenter',
		folderDir: '/home/me/Epicenter',
		engine: '/home/me/.epicenter/bin/epicenter',
	});
});

test('development uses its own root and application data directory', () => {
	expect(
		resolveAppPaths({ EPICENTER_ENVIRONMENT: 'development' }, home),
	).toEqual({
		dataDir: '/home/me/Library/Application Support/so.epicenter.dev',
		folderDir: '/home/me/Epicenter Dev',
		engine: '/home/me/.epicenter-dev/bin/epicenter',
	});
	expect(resolveAppPaths({ EPICENTER_ENVIRONMENT: '' }, home).folderDir).toBe(
		'/home/me/Epicenter',
	);
	expect(
		resolveAppPaths({ EPICENTER_FOLDER_DIR: '/ignored' }, home).folderDir,
	).toBe('/home/me/Epicenter');
});

test('the application data override wins, and an empty one is unset', () => {
	expect(resolveAppPaths({ EPICENTER_DATA_DIR: '/d' }, home)).toEqual({
		dataDir: '/d',
		folderDir: '/home/me/Epicenter',
		engine: '/home/me/.epicenter/bin/epicenter',
	});
	expect(resolveAppPaths({ EPICENTER_DATA_DIR: '' }, home).dataDir).toBe(
		'/home/me/Library/Application Support/so.epicenter',
	);
});

test('a relative application data override and an unknown environment are refused', () => {
	expect(() =>
		resolveAppPaths({ EPICENTER_DATA_DIR: 'relative' }, home),
	).toThrow('EPICENTER_DATA_DIR must be an absolute path');
	expect(() =>
		resolveAppPaths({ EPICENTER_ENVIRONMENT: 'staging' }, home),
	).toThrow('Unknown EPICENTER_ENVIRONMENT');
});
