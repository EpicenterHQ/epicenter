/**
 * What a synced folder's row says, from the CLI's own words: its last round
 * of `epicenter sync --json` and its `epicenter status --json` line.
 *
 * Key behaviors:
 * - A folder that cannot be read says why, before anything about rounds
 * - No round yet is "waiting"; a round's status picks the tone
 * - Retry and stopped carry the CLI's message as the detail
 * - A synced folder with changes since says they are not synced yet
 * - A remote URL reads as `owner/name`; none reads as "This computer only"
 */
import { describe, expect, test } from 'bun:test';
import type { SyncedFolder, SyncRound } from '../ui/bindings.gen';
import { ago, describeSync, folderName, remoteName } from './synced-folders.ts';

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

function folder(overrides: Partial<SyncedFolder> = {}): SyncedFolder {
	return {
		path: '/Users/me/Epicenter/notes',
		name: 'notes',
		remote: 'https://git.epicenter.so/me/notes.git',
		changes: 0,
		ahead: 0,
		behind: 0,
		problem: null,
		last: null,
		...overrides,
	};
}

function round(overrides: Partial<SyncRound> = {}): SyncRound {
	return {
		folder: '/Users/me/Epicenter/notes',
		status: 'synced',
		head: 'abc1234def',
		notes: [],
		message: null,
		endedAt: NOW - 120_000,
		...overrides,
	};
}

describe('describeSync', () => {
	test('a folder that cannot be read says why, whatever its last round', () => {
		expect(
			describeSync(folder({ problem: 'not on disk', last: round() }), NOW),
		).toEqual({ tone: 'problem', label: 'Missing from disk', detail: null });
		expect(
			describeSync(folder({ problem: 'not in a Git repository' }), NOW).label,
		).toBe('Not a Git repository');
		expect(
			describeSync(
				folder({ problem: 'its repository is not set up for sync' }),
				NOW,
			).label,
		).toBe('Not set up for sync');
	});

	test('no round yet is waiting for the first sync', () => {
		expect(describeSync(folder(), NOW)).toEqual({
			tone: 'waiting',
			label: 'Waiting for the first sync',
			detail: null,
		});
	});

	test('a synced round says when', () => {
		expect(describeSync(folder({ last: round() }), NOW)).toEqual({
			tone: 'synced',
			label: 'Synced 2 min ago',
			detail: null,
		});
	});

	test('changes made since a synced round are not synced yet', () => {
		expect(
			describeSync(folder({ last: round(), changes: 3 }), NOW).detail,
		).toBe('3 changes not synced yet');
		expect(
			describeSync(folder({ last: round(), changes: 1 }), NOW).detail,
		).toBe('1 change not synced yet');
	});

	test('retry and stopped carry the CLI message', () => {
		expect(
			describeSync(
				folder({
					last: round({ status: 'retry', message: 'index.lock is held' }),
				}),
				NOW,
			),
		).toEqual({
			tone: 'retry',
			label: 'Will try again',
			detail: 'index.lock is held',
		});
		expect(
			describeSync(
				folder({
					last: round({
						status: 'stopped',
						message: 'the remote main was rewritten',
					}),
				}),
				NOW,
			),
		).toEqual({
			tone: 'stopped',
			label: 'Stopped',
			detail: 'the remote main was rewritten',
		});
	});
});

describe('ago', () => {
	test('reads like a person would say it', () => {
		expect(ago(NOW - 10_000, NOW)).toBe('just now');
		expect(ago(NOW - 70_000, NOW)).toBe('1 min ago');
		expect(ago(NOW - 59 * 60_000, NOW)).toBe('59 min ago');
		expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
		expect(ago(NOW + 5_000, NOW)).toBe('just now');
		expect(ago(NOW - 3 * 86_400_000, NOW)).toMatch(/^on /);
	});
});

describe('remoteName', () => {
	test('an Epicenter or other HTTPS remote reads as owner/name', () => {
		expect(remoteName('https://git.epicenter.so/me/notes.git')).toBe(
			'me/notes',
		);
		expect(remoteName('http://localhost:8788/git/ana/recorder-demo')).toBe(
			'ana/recorder-demo',
		);
	});

	test('a local remote reads as its folder name, and none as this computer', () => {
		expect(remoteName('/tmp/remote.git')).toBe('remote');
		expect(remoteName(null)).toBe('This computer only');
	});
});

describe('folderName', () => {
	test('is the last segment of a path', () => {
		expect(folderName('/Users/me/Recorder')).toBe('Recorder');
		expect(folderName('/')).toBe('/');
	});
});
