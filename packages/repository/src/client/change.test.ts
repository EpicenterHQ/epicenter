/**
 * Replica Change Tests
 *
 * The write operations a page asks of its replica, each applied over the
 * text the replica shows when it runs, in one transaction, and answered
 * with each path's resulting text and the revision that change made.
 *
 * Key behaviors:
 * - A patch sets fields on the note as it is now, keeping its other keys, their formatting and its body
 * - A body edit merges with the body alone, so a field set meanwhile stays and a remote line stays
 * - A create over a note that exists keeps it and appends the new one as one block
 * - A batch is one transaction and one save: a change that cannot apply stores none of the batch
 * - Each stored change makes one revision, which its answer and its watchers carry
 */
import { expect, test } from 'bun:test';
import { unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openBunSqlite } from '../bun/sqlite.js';
import { findConflicts } from '../core/conflict.js';
import { openReplica } from './replica.js';

const PATH = 'notes/a.md';
const note = (body: string, fields = 'title: A\n') => `---\n${fields}---\n${body}`;

const open = () =>
	unwrap(openReplica({ driver: openBunSqlite(), binding: { repository: 'r', server: null, account: null }, device: 'laptop', after: () => {}, now: () => 0 }));

test('a patch sets fields on the note as it is now, keeping its other keys, their formatting and its body', () => {
	const replica = open();
	replica.write(PATH, note('one\n', 'title: A # the name\ntags: [x]\n'));
	const changed = expectOk(replica.change([{ kind: 'patch', path: PATH, fields: { done: true, tags: undefined } }]));
	expect(changed.texts).toEqual({ [PATH]: note('one\n', 'title: A # the name\ndone: true\n') });
	expect(replica.read(PATH)).toBe(changed.texts[PATH] ?? null);
});

test('a body edit merges with the body alone: a field set meanwhile and a line written meanwhile both stay', () => {
	const replica = open();
	replica.write(PATH, note('one\ntwo\n'));
	// Meanwhile, on this device: a field and the last line changed.
	replica.write(PATH, note('one\nTWO\n', 'title: B\n'));
	const changed = expectOk(replica.change([{ kind: 'edit-body', path: PATH, from: 'one\ntwo\n', to: 'ONE\ntwo\n' }]));
	expect(changed.texts[PATH]).toBe(note('ONE\nTWO\n', 'title: B\n'));
});

test('a body edit from the body as it is now replaces it, under the frontmatter as it is now', () => {
	const replica = open();
	replica.write(PATH, note('one\n', 'title: B\n'));
	expect(expectOk(replica.change([{ kind: 'edit-body', path: PATH, from: 'one\n', to: 'two\n' }])).texts[PATH]).toBe(note('two\n', 'title: B\n'));
});

test('a create over a note that exists keeps it and appends the new one as one block', () => {
	const replica = open();
	replica.write(PATH, note('mine\n'));
	const text = expectOk(replica.change([{ kind: 'create', path: PATH, text: note('theirs\n') }])).texts[PATH] ?? '';
	expect(text.startsWith(note('mine\n'))).toBe(true);
	expect(findConflicts(text)).toHaveLength(1);
});

test('exact source and a delete apply over the text they name; a stale exact source merges', () => {
	const replica = open();
	replica.write(PATH, note('a\nb\nc\n'));
	replica.write(PATH, note('a\nb\nC\n'));
	expect(expectOk(replica.change([{ kind: 'write', path: PATH, text: note('A\nb\nc\n'), over: note('a\nb\nc\n') }])).texts[PATH]).toBe(note('A\nb\nC\n'));
	expect(expectOk(replica.change([{ kind: 'delete', path: PATH }])).texts).toEqual({ [PATH]: null });
	expect(replica.read(PATH)).toBeNull();
});

test('a batch is one transaction: a change that cannot apply stores none of it', () => {
	const replica = open();
	replica.write(PATH, note('one\n'));
	replica.write('notes/broken.md', '---\ntitle: A\ntitle: B\n---\nheld\n');
	const before = replica.revision();
	expectErr(replica.change([{ kind: 'patch', path: PATH, fields: { title: 'Z' } }, { kind: 'patch', path: 'notes/gone.md', fields: { title: 'Z' } }]));
	expect(expectErr(replica.change([{ kind: 'patch', path: 'notes/broken.md', fields: { title: 'Z' } }])).name).toBe('Unparseable');
	expect(expectErr(replica.change([{ kind: 'edit-body', path: 'notes/gone.md', from: '', to: 'x' }])).name).toBe('NotFound');
	expect(replica.read(PATH)).toBe(note('one\n'));
	expect(replica.revision()).toBe(before);
});

test('later changes in a batch apply over earlier ones, and the batch is one revision its watchers hear', () => {
	const replica = open();
	const heard: [string[], number][] = [];
	replica.watch((paths, revision) => heard.push([paths, revision]));
	const changed = expectOk(
		replica.change([
			{ kind: 'create', path: PATH, text: note('one\n') },
			{ kind: 'patch', path: PATH, fields: { done: false } },
			{ kind: 'create', path: 'notes/b.md', text: note('b\n') },
		]),
	);
	expect(changed.texts).toEqual({ [PATH]: note('one\n', 'title: A\ndone: false\n'), 'notes/b.md': note('b\n') });
	expect(heard).toEqual([[[PATH, 'notes/b.md'], changed.revision]]);
	expect(replica.revision()).toBe(changed.revision);
});
