/**
 * Commit Id Tests
 *
 * A commit id hashes the commit's canonical form, so a resent commit is the
 * same commit and any change to its parent or content is a different one.
 *
 * Key behaviors:
 * - the id ignores key order and extra fields of the object it is given
 * - the id changes with the parent, the mode, the author, the time, a path or a text
 */
import { expect, test } from 'bun:test';
import { type CommitBody, commitId, type LiveCommit } from './commit.js';

const body: CommitBody = {
	parent: 'p',
	mode: 'merge',
	author: { user: 'alice', device: 'laptop' },
	time: '2026-10-28T14:02:11Z',
	files: [
		{ path: 'notes/trip.md', text: 'hello\n' },
		{ path: 'notes/old.md', text: null },
	],
};

test('the id depends on the canonical form only', () => {
	const reordered = { files: body.files, time: body.time, author: { device: 'laptop', user: 'alice' }, mode: 'merge', parent: 'p' } as const;
	expect(commitId(reordered)).toBe(commitId(body));
	const live: LiveCommit = { ...body, id: 'ignored' };
	expect(commitId(live)).toBe(commitId(body));
});

test('every part of the commit changes its id', () => {
	const variants: CommitBody[] = [
		{ ...body, parent: 'q' },
		{ ...body, mode: 'fast-forward' },
		{ ...body, author: { user: 'bob', device: 'laptop' } },
		{ ...body, author: { user: 'alice', device: 'phone' } },
		{ ...body, time: '2026-10-28T14:02:12Z' },
		{ ...body, files: [{ path: 'notes/trip.md', text: 'hello!\n' }, body.files[1] ?? { path: '', text: null }] },
		{ ...body, files: [{ path: 'notes/Trip.md', text: 'hello\n' }, body.files[1] ?? { path: '', text: null }] },
		{ ...body, files: [{ path: 'notes/trip.md', text: 'hello\n' }, { path: 'notes/old.md', text: '' }] },
	];
	const ids = new Set([commitId(body), ...variants.map(commitId)]);
	expect(ids.size).toBe(variants.length + 1);
});
