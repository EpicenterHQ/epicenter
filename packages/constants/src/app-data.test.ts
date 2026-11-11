/**
 * The app-data root, an app's directory, and a validated partition (ADR-0201).
 *
 * The platform table is the load-bearing part. A host resolving the root through
 * Tauri and a CLI resolving it here have to name one directory, so each row
 * below is transcribed from the source the desktop actually runs
 * (`tauri-2.11.5/src/path/desktop.rs:247` joins `dirs::data_dir()` with the
 * bundle identifier; `dirs-6.0.0/src/{mac,lin,win}.rs` resolve `data_dir()`).
 * Ambient inputs are passed as a value so every row runs on one machine.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	appDataDir,
	type DataRootSystem,
	EPICENTER_BUNDLE_IDENTIFIER,
	epicenterDataRoot,
	epicenterFolderRoot,
	isAppId,
	partitionDir,
} from './app-data.ts';

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

test('Windows resolves under roaming APPDATA, not local, and not XDG', () => {
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
	).toBe(join('C:\\Users\\person\\AppData\\Roaming', 'so.epicenter'));
});

test('Windows without APPDATA refuses rather than guessing', () => {
	expect(() => epicenterDataRoot(system({ platform: 'win32' }))).toThrow(
		/APPDATA/,
	);
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

test('the folder root is the home directory, capitalized, no dot', () => {
	// The same shape on all three, because `homedir()` is the one input: Bun
	// resolves it through `uv_os_homedir` on Windows (USERPROFILE) and
	// HOME-then-getpwuid_r on POSIX, matching Node. Nothing platform-specific
	// belongs here; a person's home directory is not an ambient guess the way
	// an application-data directory is.
	expect(epicenterFolderRoot({ env: {}, homeDir: '/Users/person' })).toBe(
		'/Users/person/Epicenter',
	);
	expect(epicenterFolderRoot({ env: {}, homeDir: '/home/person' })).toBe(
		'/home/person/Epicenter',
	);
	expect(
		epicenterFolderRoot({ env: {}, homeDir: 'C:\\Users\\person' }),
	).toContain('Epicenter');
});

test('the folder root is not the data root, and that is the point', () => {
	// ADR-0207 refused putting a human surface in the machine-facing root, and
	// ADR-0010 is the failure it refused: a continuous producer writing into
	// ~/Library/Application Support, where no person or agent would ever look.
	const home = '/Users/person';
	expect(epicenterFolderRoot({ env: {}, homeDir: home })).not.toBe(
		epicenterDataRoot(system({ platform: 'darwin', homeDir: home })),
	);
});

test('EPICENTER_FOLDER_DIR wins, and a relative one is refused', () => {
	expect(
		epicenterFolderRoot({
			env: { EPICENTER_FOLDER_DIR: '/mnt/vault' },
			homeDir: '/Users/person',
		}),
	).toBe('/mnt/vault');
	expect(
		epicenterFolderRoot({
			env: { EPICENTER_FOLDER_DIR: '' },
			homeDir: '/Users/person',
		}),
	).toBe('/Users/person/Epicenter');
	expect(() =>
		epicenterFolderRoot({
			env: { EPICENTER_FOLDER_DIR: 'vault' },
			homeDir: '/Users/person',
		}),
	).toThrow('absolute');
});

test('an app directory sits under apps/', () => {
	expect(appDataDir('/root', 'local-mail')).toBe('/root/apps/local-mail');
	expect(appDataDir('/root', 'local-books')).toBe('/root/apps/local-books');
});

test('an admitted folder name is an app id too', () => {
	// The id space is open: an admitted app's id is its folder name (ADR-0179),
	// and it names its directory the same way a composed engine's literal does.
	expect(appDataDir('/root', 'field-notes')).toBe('/root/apps/field-notes');
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
	const mail = appDataDir('/root', 'local-mail');
	expect(partitionDir(mail, 'accounts', '104217392837465102938')).toBe(
		'/root/apps/local-mail/accounts/104217392837465102938',
	);
	const books = appDataDir('/root', 'local-books');
	expect(partitionDir(books, 'companies', '9130354674627613')).toBe(
		'/root/apps/local-books/companies/9130354674627613',
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
