/**
 * Replica Change Tests
 *
 * The write operations a page asks of its replica, each applied over the
 * text the replica shows when it runs, in one transaction, and answered
 * with each path's resulting text and the revision that change made.
 *
 * Key behaviors:
 * - A patch sets fields on the note as it is now, keeping its other keys, their formatting and its body
 * - Exact source over a text the note moved past merges, so a field set meanwhile stays and a remote line stays
 * - A create over a note that exists keeps it and appends the new one as one block
 * - A batch is one transaction and one save: a change that cannot apply stores none of the batch
 * - Each stored change makes one revision, which its answer and its watchers carry
 * - A change through another spelling of a stored path answers the stored text, under the spelling it was given
 */
import { expect, test } from 'bun:test';
import { unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openBunSqlite } from '../bun/sqlite.js';
import { findConflicts } from '../core/conflict.js';
import { openReplica } from './replica.js';

const PATH = 'notes/a.md';
const note = (body: string, fields = 'title: A\n') =>
	`---\n${fields}---\n${body}`;

const open = () =>
	unwrap(
		openReplica({
			driver: openBunSqlite(),
			binding: { repository: 'r', server: null, account: null },
			device: 'laptop',
			after: () => {},
			now: () => 0,
			quiet: 0,
		}),
	);

test('a patch sets fields on the note as it is now, keeping its other keys, their formatting and its body', () => {
	const replica = open();
	replica.write(PATH, note('one\n', 'title: A # the name\ntags: [x]\n'));
	const changed = expectOk(
		replica.change([
			{ kind: 'patch', path: PATH, fields: { done: true, tags: undefined } },
		]),
	);
	expect(changed.texts).toEqual({
		[PATH]: note('one\n', 'title: A # the name\ndone: true\n'),
	});
	expect(replica.read(PATH)).toBe(changed.texts[PATH] ?? null);
});

test('exact source over a text the note moved past merges: a field set meanwhile and a line written meanwhile both stay', () => {
	const replica = open();
	replica.write(PATH, note('one\ntwo\n'));
	// Meanwhile, on this device: a field and the last line changed.
	replica.write(PATH, note('one\nTWO\n', 'title: B\n'));
	const changed = expectOk(
		replica.change([
			{
				kind: 'write',
				path: PATH,
				text: note('ONE\ntwo\n'),
				over: note('one\ntwo\n'),
			},
		]),
	);
	expect(changed.texts[PATH]).toBe(note('ONE\nTWO\n', 'title: B\n'));
});

test('a create over a note that exists keeps it and appends the new one as one block', () => {
	const replica = open();
	replica.write(PATH, note('mine\n'));
	const text =
		expectOk(
			replica.change([{ kind: 'create', path: PATH, text: note('theirs\n') }]),
		).texts[PATH] ?? '';
	expect(text.startsWith(note('mine\n'))).toBe(true);
	expect(findConflicts(text)).toHaveLength(1);
});

test('exact source and a delete apply over the text they name; a stale exact source merges', () => {
	const replica = open();
	replica.write(PATH, note('a\nb\nc\n'));
	replica.write(PATH, note('a\nb\nC\n'));
	expect(
		expectOk(
			replica.change([
				{
					kind: 'write',
					path: PATH,
					text: note('A\nb\nc\n'),
					over: note('a\nb\nc\n'),
				},
			]),
		).texts[PATH],
	).toBe(note('A\nb\nC\n'));
	expect(
		expectOk(replica.change([{ kind: 'delete', path: PATH }])).texts,
	).toEqual({ [PATH]: null });
	expect(replica.read(PATH)).toBeNull();
});

test('a batch is one transaction: a change that cannot apply stores none of it', () => {
	const replica = open();
	replica.write(PATH, note('one\n'));
	const before = replica.revision();
	expectErr(
		replica.change([
			{ kind: 'patch', path: PATH, fields: { title: 'Z' } },
			{ kind: 'patch', path: 'notes/gone.md', fields: { title: 'Z' } },
		]),
	);
	expect(
		expectErr(
			replica.change([
				{ kind: 'patch', path: 'notes/gone.md', fields: { title: 'Z' } },
			]),
		).name,
	).toBe('NotFound');
	expect(replica.read(PATH)).toBe(note('one\n'));
	expect(replica.revision()).toBe(before);
});

test('a patch on a key the header holds twice writes it once, in the header', () => {
	const replica = open();
	const broken = '---\ntitle: A\ntitle: B\n---\nbody\n';
	replica.write('notes/broken.md', broken);
	expectOk(
		replica.change([
			{ kind: 'patch', path: 'notes/broken.md', fields: { title: 'Z' } },
		]),
	);
	expect(replica.read('notes/broken.md')).toBe('---\ntitle: Z\n---\nbody\n');
	expect(replica.notSent()).toEqual([]);
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
	expect(changed.texts).toEqual({
		[PATH]: note('one\n', 'title: A\ndone: false\n'),
		'notes/b.md': note('b\n'),
	});
	expect(heard).toEqual([[[PATH, 'notes/b.md'], changed.revision]]);
	expect(replica.revision()).toBe(changed.revision);
});

test('a change through another spelling of a stored path answers the stored text, under the spelling it was given', () => {
	const replica = open();
	replica.write(PATH, note('one\n'));
	const changed = expectOk(
		replica.change([
			{ kind: 'write', path: 'notes/A.md', text: note('two\n') },
		]),
	);
	expect(changed.texts).toEqual({ 'notes/A.md': note('two\n') });
	expect(replica.read(PATH)).toBe(note('two\n'));
	expect(
		expectOk(
			replica.change([
				{ kind: 'patch', path: 'Notes/a.md', fields: { title: 'Z' } },
			]),
		).texts,
	).toEqual({ 'Notes/a.md': note('two\n', 'title: Z\n') });
});
