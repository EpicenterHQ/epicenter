/**
 * Status Line Tests
 *
 * The header and toasts report facts from the folder's Git snapshot. These
 * cover the decisions a person acts on, not every label.
 *
 * Key behaviors:
 * - Observed divergence gives fixed guidance, never the push transport's text
 * - Changes since the last version are neutral detail: saves never make
 *   versions, so the header does not warn about them
 * - Observation times are absolute
 */
import { expect, test } from 'bun:test';
import type { GitSnapshot } from '@epicenter/folder';
import {
	DIVERGED,
	filesLine,
	lastVersionLine,
	pushLine,
	summaryLine,
	versionLine,
	versionOutcomeLine,
} from './status.js';

const idle = { active: false };
/** A past day, so the time includes its date. */
const checkedAt = new Date(2020, 0, 2, 14, 32, 5).getTime();

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
	return {
		branch: 'main',
		remote: { url: 'http://127.0.0.1/git/todos.git', branch: 'main' },
		files: {
			state: 'observed',
			value: { head: 'a'.repeat(40), changes: [] },
			checkedAt,
			stale: false,
			error: undefined,
		},
		sync: {
			state: 'observed',
			value: {
				head: 'a'.repeat(40),
				remote: 'a'.repeat(40),
				ahead: 0,
				behind: 0,
			},
			checkedAt,
			stale: false,
			error: undefined,
		},
		activity: {
			scan: idle,
			commit: idle,
			push: idle,
			fetch: idle,
		},
		lastCommit: undefined,
		lastPush: undefined,
		closed: false,
		...overrides,
	};
}

const divergedSync: GitSnapshot['sync'] = {
	state: 'observed',
	value: { head: 'a'.repeat(40), remote: 'b'.repeat(40), ahead: 1, behind: 2 },
	checkedAt,
	stale: false,
	error: undefined,
};

test('observed divergence gives guidance instead of the push error', () => {
	const rejected = 'failed to push: not a simple fast-forward; use force: true';
	const git = snapshot({
		sync: divergedSync,
		lastPush: {
			status: 'failed',
			oid: 'a'.repeat(40),
			error: rejected,
			at: checkedAt,
		},
	});
	const line = pushLine(git);
	expect(line.tone).toBe('error');
	expect(line.detail).toContain(DIVERGED);
	expect(line.detail).not.toContain('force');

	expect(pushLine(snapshot({ sync: divergedSync }))).toMatchObject({
		short: 'Diverged',
		tone: 'error',
	});
});

test('the header leads with current state; changes since the last version are neutral detail', () => {
	const git = snapshot();
	const lines = {
		files: filesLine({ saving: false }),
		versions: versionLine(git),
		lastVersion: lastVersionLine(git),
		remote: pushLine(git),
	};
	expect(lines.files.label).toBe('Saved');
	expect(lines.lastVersion.label).toBe('No version saved this session');
	expect(summaryLine(lines).label).toBe('Up to date');

	const changed = snapshot({
		files: {
			state: 'observed',
			value: {
				head: 'a'.repeat(40),
				changes: [{ path: 'todos/milk.md', kind: 'modify' }],
			},
			checkedAt,
			stale: false,
			error: undefined,
		},
	});
	const versions = versionLine(changed);
	expect(versions).toMatchObject({
		label: '1 change since the last version',
		tone: 'neutral',
	});
	expect(summaryLine({ ...lines, versions }).label).toBe('Up to date');
	expect(summaryLine({ ...lines, files: filesLine({ saving: true }) })).toEqual(
		{ label: 'Saving…', tone: 'busy' },
	);
	expect(
		versionOutcomeLine({
			status: 'committed',
			oid: 'c'.repeat(40),
			parent: undefined,
			message: 'Update todos/milk.md',
			changedPaths: 1,
			indexWarning: undefined,
		}),
	).toMatchObject({ label: 'Saved version ccccccc', tone: 'good' });
});

test('observation times are absolute', () => {
	expect(versionLine(snapshot()).detail).toBe(
		`Checked at ${new Date(checkedAt).toLocaleString()}`,
	);
	expect(pushLine(snapshot()).detail).toContain(
		`as of ${new Date(checkedAt).toLocaleString()}`,
	);
});
