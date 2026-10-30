/**
 * Where the CLI reads and writes, by the desktop shell's rule.
 *
 * Key behaviors:
 * - An absolute override wins, and an empty one is unset
 * - Without overrides, the release app's directories
 * - A relative override is refused
 */
import { expect, test } from 'bun:test';
import { resolveAppPaths } from './app-paths.ts';

const home = '/home/me';

test("without overrides, the release app's directories", () => {
	expect(resolveAppPaths({}, home)).toEqual({
		dataDir: '/home/me/Library/Application Support/so.epicenter',
		folderDir: '/home/me/Epicenter',
		commandLink: '/home/me/.local/bin/epicenter',
	});
});

test('an absolute override wins, and an empty one is unset', () => {
	expect(
		resolveAppPaths(
			{ EPICENTER_DATA_DIR: '/d', EPICENTER_FOLDER_DIR: '/f' },
			home,
		),
	).toEqual({
		dataDir: '/d',
		folderDir: '/f',
		commandLink: '/home/me/.local/bin/epicenter',
	});
	expect(resolveAppPaths({ EPICENTER_DATA_DIR: '' }, home).dataDir).toBe(
		'/home/me/Library/Application Support/so.epicenter',
	);
});

test('a relative override is refused', () => {
	expect(() =>
		resolveAppPaths({ EPICENTER_FOLDER_DIR: 'relative' }, home),
	).toThrow('EPICENTER_FOLDER_DIR must be an absolute path');
});
