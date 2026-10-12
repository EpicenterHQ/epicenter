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
 * - A pending incoming update leads the header in each record state; a sync
 *   it refuses says Sync waits, and a refused recovery names its paths and
 *   says nothing was written
 * - Observation times are absolute
 */
import { expect, test } from 'bun:test';
import { type GitSnapshot, PullError, SyncError } from '@epicenter/folder';
import { Ok } from 'wellcrafted/result';
import {
	DIVERGED,
	filesLine,
	INCOMING_WAITS,
	incomingLine,
	lastVersionLine,
	pushLine,
	recoveryLine,
	summaryLine,
	syncOutcomeLine,
	versionLine,
	versionOutcomeLine,
} from './status.js';
import { TodosError } from './todos.svelte.js';

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
			pull: idle,
			merge: idle,
		},
		lastCommit: undefined,
		lastPush: undefined,
		lastFetch: undefined,
		lastPull: undefined,
		lastMerge: undefined,
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

test('a pending incoming update leads the header for every record state, and a sync it refuses says Sync waits', () => {
	const recorded = snapshot({
		pendingIncoming: {
			state: 'recorded',
			operationId: 'op-1',
			branch: 'main',
			expectedHead: 'a'.repeat(40),
			nextHead: 'b'.repeat(40),
		},
	});
	const line = incomingLine(recorded)!;
	expect(line).toMatchObject({
		label: 'Incoming update not finished',
		tone: 'error',
	});
	expect(line.detail).toContain('aaaaaaa → bbbbbbb on main');
	expect(line.detail).toContain('You can still edit and save files');
	expect(
		incomingLine(snapshot({ pendingIncoming: { state: 'unadmitted' } })),
	).toMatchObject({ label: 'Incoming update never started' });
	expect(
		incomingLine(
			snapshot({
				pendingIncoming: { state: 'unreadable', reason: 'not JSON' },
			}),
		)?.detail,
	).toContain('not JSON');
	expect(incomingLine(snapshot())).toBeUndefined();

	const lines = {
		files: filesLine({ saving: false }),
		versions: versionLine(recorded),
		lastVersion: lastVersionLine(recorded),
		remote: pushLine(recorded),
	};
	expect(summaryLine({ ...lines, incoming: line }).short).toBe(
		'Update pending',
	);

	const waits = SyncError.Merge({
		error: PullError.IncomingPending({ pending: { state: 'unadmitted' } })
			.error,
	});
	expect(syncOutcomeLine(waits, recorded)).toEqual({
		label: 'Sync waits',
		detail: INCOMING_WAITS,
		tone: 'warning',
	});
	const blocked = SyncError.Checkpoint({
		outcome: {
			status: 'blocked',
			reason: 'Incoming update op-1 has not finished',
		},
	});
	expect(syncOutcomeLine(blocked, recorded).label).toBe('Sync waits');
	expect(syncOutcomeLine(blocked, snapshot()).label).toBe('Sync stopped');
});

test('a refused recovery names its paths and says nothing was written; a fenced page and success say so plainly', () => {
	const pending = { state: 'unadmitted' } as const;
	const refused = recoveryLine(
		PullError.RecoveryRefused({
			pending,
			paths: ['todos/milk.md', '.git/index'],
			reason:
				"todos/milk.md holds neither the update's before nor its after state",
		}),
	);
	expect(refused.label).toBe('Incoming update not recovered');
	expect(refused.detail).toContain('todos/milk.md\n.git/index');
	expect(refused.detail).toContain('Nothing was written');
	expect(
		recoveryLine(TodosError.NotStarted({ reason: 'Epicenter is quitting.' })),
	).toMatchObject({ label: 'Recovery waits', tone: 'neutral' });
	expect(
		recoveryLine(
			Ok({
				status: 'completed',
				pending: {
					state: 'recorded',
					operationId: 'op-1',
					branch: 'main',
					expectedHead: undefined,
					nextHead: 'b'.repeat(40),
				},
				changedPaths: ['todos/milk.md'],
			}),
		),
	).toMatchObject({ label: 'Incoming update finished: 1 file', tone: 'good' });
	expect(recoveryLine(Ok({ status: 'admissionCleared' })).detail).toContain(
		'never changed a file',
	);
});

test('observation times are absolute', () => {
	expect(versionLine(snapshot()).detail).toBe(
		`Checked at ${new Date(checkedAt).toLocaleString()}`,
	);
	expect(pushLine(snapshot()).detail).toContain(
		`as of ${new Date(checkedAt).toLocaleString()}`,
	);
});
