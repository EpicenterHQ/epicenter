/**
 * Header status keeps file publication separate from Git history.
 * Unsaved work cannot be reported as saved because a commit failed, and an
 * unavailable or stale observation cannot establish that history is empty.
 */
import { expect, test } from 'bun:test';
import type { GitSnapshot } from '@epicenter/folder';
import {
	commitLine,
	filesLine,
	headLine,
	summaryLine,
	uncommittedLine,
} from './status.js';

function snapshot(): GitSnapshot {
	return {
		branch: 'main',
		remote: undefined,
		files: { state: 'unknown', error: undefined },
		sync: { state: 'unknown', error: undefined },
		activity: {
			scan: { active: false },
			commit: { active: false },
			push: { active: false },
			fetch: { active: false },
			pull: { active: false },
			merge: { active: false },
		},
		lastCommit: undefined,
		lastPush: undefined,
		lastFetch: undefined,
		lastPull: undefined,
		lastMerge: undefined,
		closed: false,
	};
}

for (const state of [
	{ saving: true, unsavedResults: 0, expected: 'Saving…' },
	{ saving: false, unsavedResults: 1, expected: '1 transcription not saved' },
]) {
	test(`${state.expected} takes priority over a failed commit`, () => {
		const git = snapshot();
		const failed = {
			...git,
			lastCommit: { status: 'failed' as const, error: 'branch locked', at: 1 },
		};
		const files = filesLine({
			...state,
			unsavedTransformations: 0,
		});
		expect(
			summaryLine({
				files,
				uncommitted: uncommittedLine(failed),
				commit: commitLine(failed),
			}).label,
		).toBe(state.expected);
		expect(commitLine(failed).label).toBe('Commit failed');
	});
}

test('a failed commit still needs attention after all files are saved', () => {
	const git = {
		...snapshot(),
		lastCommit: { status: 'failed' as const, error: 'branch locked', at: 1 },
	};
	const files = filesLine({
		saving: false,
		unsavedResults: 0,
		unsavedTransformations: 0,
	});
	expect(
		summaryLine({
			files,
			uncommitted: uncommittedLine(git),
			commit: commitLine(git),
		}).label,
	).toBe('Saved · commit failed');
});

test('changes since the last version are neutral detail: the summary says Saved', () => {
	const git: GitSnapshot = {
		...snapshot(),
		files: {
			state: 'observed',
			value: {
				head: 'abcdef123456',
				changes: [{ path: 'recordings/a.md', kind: 'modify' }],
			},
			checkedAt: 1,
			stale: false,
			error: undefined,
		},
	};
	const uncommitted = uncommittedLine(git);
	expect(uncommitted).toMatchObject({
		label: '1 change since the last version',
		tone: 'neutral',
	});
	const files = filesLine({
		saving: false,
		unsavedResults: 0,
		unsavedTransformations: 0,
	});
	expect(
		summaryLine({ files, uncommitted, commit: commitLine(git) }).label,
	).toBe('Saved');
});

test('an unobserved head does not claim empty history', () => {
	expect(headLine(snapshot()).label).toBe('History not checked yet');
	expect(
		headLine({
			...snapshot(),
			files: { state: 'unknown', error: 'scan refused' },
		}),
	).toEqual({
		label: 'History unavailable',
		detail: 'scan refused',
		tone: 'error',
	});
});

test('a current successful observation distinguishes empty history from a commit', () => {
	const git = snapshot();
	const files = {
		state: 'observed' as const,
		value: { head: undefined, changes: [] },
		checkedAt: 1,
		stale: false,
		error: undefined,
	};
	expect(headLine({ ...git, files }).label).toBe('No commits yet');
	expect(
		headLine({
			...git,
			files: { ...files, value: { ...files.value, head: 'abcdef123456' } },
		}).label,
	).toBe('main at abcdef1');
});

for (const observation of [
	{ stale: true, error: undefined },
	{ stale: false, error: 'refresh refused' },
]) {
	test(`a ${observation.error ? 'failed refresh' : 'stale observation'} labels the previous head as historical`, () => {
		const line = headLine({
			...snapshot(),
			files: {
				state: 'observed',
				value: { head: 'abcdef123456', changes: [] },
				checkedAt: 1,
				...observation,
			},
		});
		expect(line.label).toBe('Last observed: main at abcdef1');
		expect(line.detail).toContain('Checked at');
		if (observation.error) expect(line.detail).toContain(observation.error);
	});
}
