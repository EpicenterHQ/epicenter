/**
 * Standalone CLI production defaults and app-owned directory boundaries.
 * Tests cover platform variable selection, explicit overrides, and path escapes.
 * Desktop paths are selected natively and arrive through the sidecar boot frame.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	appDataDir,
	type DataRootSystem,
	EPICENTER_BUNDLE_IDENTIFIER,
	epicenterDataRoot,
	isAppId,
	partitionDir,
} from './app-data.js';

const system = (overrides: Partial<DataRootSystem> = {}): DataRootSystem => ({
	env: {},
	platform: 'linux',
	homeDir: '/home/person',
	...overrides,
});

test('macOS resolves under Application Support', () => {
	expect(
		epicenterDataRoot(system({ platform: 'darwin', homeDir: '/Users/person' })),
	).toBe('/Users/person/Library/Application Support/so.epicenter');
});

test('Linux honours an absolute XDG_DATA_HOME', () => {
	expect(
		epicenterDataRoot(system({ env: { XDG_DATA_HOME: '/data/share' } })),
	).toBe('/data/share/so.epicenter');
});

test('Linux ignores a relative XDG_DATA_HOME, as dirs does', () => {
	// Both apps honour this today, so a CLI run from two working directories
	// sees two roots while the desktop host sees a third.
	expect(
		epicenterDataRoot(system({ env: { XDG_DATA_HOME: 'relative/share' } })),
	).toBe('/home/person/.local/share/so.epicenter');
});

test('Linux falls back to ~/.local/share', () => {
	expect(epicenterDataRoot(system())).toBe(
		'/home/person/.local/share/so.epicenter',
	);
});

test('other Unix platforms follow the Linux rules', () => {
	expect(epicenterDataRoot(system({ platform: 'freebsd' }))).toBe(
		'/home/person/.local/share/so.epicenter',
	);
});

test('Windows resolves under LOCALAPPDATA even when roaming and XDG paths exist', () => {
	expect(
		epicenterDataRoot(
			system({
				platform: 'win32',
				env: {
					APPDATA: 'C:\\Users\\person\\AppData\\Roaming',
					LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local',
					XDG_DATA_HOME: '/ignored',
				},
			}),
		),
	).toBe(join('C:\\Users\\person\\AppData\\Local', 'so.epicenter'));
});

test('Windows refuses missing or empty LOCALAPPDATA even when APPDATA exists', () => {
	for (const localAppData of [undefined, '']) {
		expect(() =>
			epicenterDataRoot(
				system({
					platform: 'win32',
					env: { LOCALAPPDATA: localAppData, APPDATA: '/roaming' },
				}),
			),
		).toThrow(/LOCALAPPDATA/);
	}
});

test('EPICENTER_DATA_DIR wins on every platform', () => {
	for (const platform of ['darwin', 'linux', 'win32']) {
		expect(
			epicenterDataRoot(
				system({
					platform,
					env: {
						EPICENTER_DATA_DIR: '/tmp/epicenter-test',
						APPDATA: 'C:\\Users\\person\\AppData\\Roaming',
						XDG_DATA_HOME: '/data/share',
					},
				}),
			),
		).toBe('/tmp/epicenter-test');
	}
});

test('an empty EPICENTER_DATA_DIR counts as unset', () => {
	expect(epicenterDataRoot(system({ env: { EPICENTER_DATA_DIR: '' } }))).toBe(
		'/home/person/.local/share/so.epicenter',
	);
});

test('a relative EPICENTER_DATA_DIR is refused, not resolved', () => {
	// Same drift a relative XDG_DATA_HOME is ignored for: two working directories
	// would be two roots, and the desktop host a third.
	expect(() =>
		epicenterDataRoot(system({ env: { EPICENTER_DATA_DIR: 'tmp/data' } })),
	).toThrow(/absolute/);
});

test('the bundle identifier equals the desktop bundle it has to match', () => {
	// A drift here is a host and a CLI writing to two different mailboxes, and
	// nothing else in either process would notice.
	const conf: unknown = JSON.parse(
		readFileSync(
			join(
				import.meta.dir,
				'..',
				'..',
				'..',
				'apps',
				'epicenter',
				'src-tauri',
				'tauri.conf.json',
			),
			'utf8',
		),
	);
	expect((conf as { identifier: string }).identifier).toBe(
		EPICENTER_BUNDLE_IDENTIFIER,
	);
});

test('an app directory sits under apps/', () => {
	expect(appDataDir('/root', 'so.epicenter.local-mail')).toBe(
		'/root/apps/so.epicenter.local-mail',
	);
	expect(appDataDir('/root', 'so.epicenter.local-books')).toBe(
		'/root/apps/so.epicenter.local-books',
	);
});

test('a bare folder name is not an app id', () => {
	// The id space is closed to one grammar (ADR-0204): an app declares one
	// reverse-domain identifier and that identifier names its directory. This
	// used to assert the opposite, citing ADR-0179's admitted-folder clause,
	// which ADR-0204 withdrew and ADR-0227 then emptied by refusing the
	// installed-app plane outright.
	expect(isAppId('field-notes')).toBe(false);
	expect(() => appDataDir('/root', 'field-notes')).toThrow(/app id/);
});

test('an app id that is not one lowercase segment is refused', () => {
	for (const id of [
		'',
		'.',
		'..',
		'a/b',
		'a\\b',
		'../escape',
		'/absolute',
		'Local-Mail',
		'local_mail',
		'local mail',
	]) {
		expect(isAppId(id)).toBe(false);
		expect(() => appDataDir('/root', id)).toThrow(/app id/);
	}
});

test('a partition sits under the app-chosen kind directory', () => {
	const mail = appDataDir('/root', 'so.epicenter.local-mail');
	expect(partitionDir(mail, 'accounts', '104217392837465102938')).toBe(
		'/root/apps/so.epicenter.local-mail/accounts/104217392837465102938',
	);
	const books = appDataDir('/root', 'so.epicenter.local-books');
	expect(partitionDir(books, 'companies', '9130354674627613')).toBe(
		'/root/apps/so.epicenter.local-books/companies/9130354674627613',
	);
});

test('a partition id that is not one path segment is refused', () => {
	for (const id of ['', '.', '..', 'a/b', 'a\\b', '../escape', '/absolute']) {
		expect(() => partitionDir('/app', 'accounts', id)).toThrow(/partition id/);
	}
});

test('a partition kind that is not one path segment is refused', () => {
	for (const kind of ['', '.', '..', 'a/b', 'a\\b']) {
		expect(() => partitionDir('/app', kind, 'valid')).toThrow(/partition kind/);
	}
});

test('an email is one segment, which is what Local Mail names a partition today', () => {
	// The guard has to pass an email until the `sub` wave lands, because that is
	// what Local Mail still partitions by; only that wave changes the segment.
	expect(partitionDir('/app', 'accounts', 'person@example.com')).toBe(
		'/app/accounts/person@example.com',
	);
});
