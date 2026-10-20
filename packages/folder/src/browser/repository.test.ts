/**
 * Local repository saves across independent IndexedDB connections.
 * Two drafts retain independent fields/regions while commits race saves;
 * reopen, structural replacement, invalid writes and unseen deletion exercise
 * the production local engine without a filesystem or network substitute.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { readCommit } from '../git/raw-objects.js';
import { type LocalRepository, openRepository } from './repository.js';
import { prepareCommit } from './sync.js';

const author = { name: 'Test', email: 'test@example.com', timestamp: 1 };

async function text(repository: LocalRepository, path: string) {
	return expectOk(await repository.files.read(path))?.content.text();
}

/** Simulate the atomic successful observation of an empty remote, not a network. */
async function observeEmpty(repository: LocalRepository) {
	const { state } = await repository.storage.capture([]);
	expect(
		await repository.storage.publish({
			expected: state,
			refs: { remoteBase: null, pendingCommit: null },
		}),
	).toBe(true);
}

test('independent fields survive two tabs while a pending commit retains exact identity', async () => {
	const id = crypto.randomUUID();
	const a = await openRepository(id);
	const b = await openRepository(id);
	try {
		const initial =
			'---\na: 0\nb: 0\n---\nFirst paragraph.\n\nLast paragraph.\n';
		expectOk(await a.files.write('todos/one.md', null, initial));
		await observeEmpty(a);
		const base = (await prepareCommit(a.storage, author))!;
		expect(await a.storage.acknowledge(base.base, base.head)).toBe(true);
		const changedA = initial.replace('a: 0', 'a: 1');
		const changedB = initial.replace('b: 0', 'b: 1');
		await Promise.all([
			a.files.write('todos/one.md', initial, changedA).then(expectOk),
			b.files.write('todos/one.md', initial, changedB).then(expectOk),
			prepareCommit(a.storage, { ...author, timestamp: 2 }),
		]);
		const pending = (await prepareCommit(a.storage, {
			...author,
			timestamp: 3,
		}))!;
		expect(await text(a, 'todos/one.md')).toContain('a: 1\nb: 1');
		// A still-unsent candidate is not rebased merely because a new save lands.
		const prior = await text(b, 'todos/one.md');
		expectOk(
			await b.files.write(
				'todos/one.md',
				prior!,
				prior!.replace('Last paragraph.', 'Other paragraph.'),
			),
		);
		expect(await prepareCommit(a.storage, { ...author, timestamp: 4 })).toEqual(
			pending,
		);
		const capture = await a.storage.capture('sync');
		expect(
			readCommit(capture.objects.get(pending.head)!.bytes).parents,
		).toEqual([base.head]);
		expect(await a.storage.acknowledge(pending.base, pending.head)).toBe(true);
		expect(await text(a, 'todos/one.md')).toContain('Other paragraph.');
		expect((await a.storage.capture('sync')).state.workingTree).not.toBe(
			readCommit(capture.objects.get(pending.head)!.bytes).tree,
		);
	} finally {
		a.close();
		b.close();
	}
});

test('reopen preserves offline edits before the first commit and a published commit afterwards', async () => {
	const id = crypto.randomUUID();
	let repository = await openRepository(id);
	try {
		expectOk(
			await repository.files.write('notes/one.md', null, 'Offline first\n'),
		);
		repository.close();
		repository = await openRepository(id);
		expect(await text(repository, 'notes/one.md')).toBe('Offline first\n');
		expect(await prepareCommit(repository.storage, author)).toBeNull();
		expect((await repository.storage.capture('sync')).files.size).toBe(1);
		await observeEmpty(repository);
		const commit = await prepareCommit(repository.storage, author);
		repository.close();
		repository = await openRepository(id);
		expect(await text(repository, 'notes/one.md')).toBe('Offline first\n');
		expect(
			await prepareCommit(repository.storage, { ...author, timestamp: 2 }),
		).toEqual(commit);
		const saved = await repository.storage.capture('sync');
		expect(saved.state.workingTree).toBe(
			readCommit(
				saved.objects.get(
					(saved.state.pendingCommit ?? saved.state.remoteBase)!,
				)!.bytes,
			).tree,
		);
	} finally {
		repository.close();
	}
});

test('unseen deletion retains the edit, and repeated draft saves do not undo the other paragraph', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		const initial = 'One\n\nMiddle\n\nLast\n';
		expectOk(await repository.files.write('note.md', null, initial));
		const phone = initial.replace('Last', 'Phone');
		expectOk(await repository.files.write('note.md', initial, phone));
		expect(expectOk(await repository.files.delete('note.md', initial))).toEqual(
			{ deleted: false },
		);
		const laptop = initial.replace('One', 'Laptop');
		expectOk(await repository.files.write('note.md', initial, laptop));
		expectOk(
			await repository.files.write(
				'note.md',
				laptop,
				laptop.replace('Laptop', 'Laptop again'),
			),
		);
		expect(await text(repository, 'note.md')).toBe(
			'Laptop again\n\nMiddle\n\nPhone\n',
		);
	} finally {
		repository.close();
	}
});

test('path structure is representable, case twins and non-text input are refused atomically', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		expectOk(await repository.files.write('docs/A.md', null, 'A'));
		expectOk(await repository.files.write('keep.md', null, 'keep'));
		expect(
			expectErr(await repository.files.write('DOCS/B.md', null, 'B')).name,
		).toBe('CaseTwin');
		expect(
			expectErr(await repository.files.write('docs/A.md', null, '\0')).name,
		).toBe('NotText');
		expect(
			expectErr(await repository.files.write('docs/A.md', null, '\ud800')).name,
		).toBe('NotText');
		for (const path of [
			'/bad',
			'a//b',
			'../a',
			'a/.git/config',
			'a/.GIT/config',
			'a/./b',
		]) {
			expect(
				expectErr(await repository.files.write(path, null, 'bad')).name,
			).toBe('InvalidPath');
		}
		expect(
			expectErr(await repository.files.write('docs', null, 'replace directory'))
				.name,
		).toBe('Occupied');
		expect(
			expectErr(
				await repository.files.write('docs/A.md/child', null, 'replace file'),
			).name,
		).toBe('Occupied');
		expect(expectOk(await repository.files.list())).toEqual([
			'docs/A.md',
			'keep.md',
		]);
		await observeEmpty(repository);
		const head = (await prepareCommit(repository.storage, author))!;
		expect(await repository.storage.acknowledge(head.base, head.head)).toBe(
			true,
		);
		// An explicit witnessed delete permits reusing the now-vacant path,
		// including offline before those deletions are committed.
		expect(expectOk(await repository.files.delete('docs/A.md', 'A'))).toEqual({
			deleted: true,
		});
		expectOk(await repository.files.write('docs', null, 'replace directory'));
		const replacement = (await prepareCommit(repository.storage, {
			...author,
			timestamp: 2,
		}))!;
		expect(
			await repository.storage.acknowledge(replacement.base, replacement.head),
		).toBe(true);
		expect(
			expectErr(await repository.files.write('docs/B.md', null, 'nested again'))
				.name,
		).toBe('Occupied');
		expect(
			expectOk(await repository.files.delete('docs', 'replace directory')),
		).toEqual({ deleted: true });
		expectOk(await repository.files.write('docs/B.md', null, 'nested again'));
		expect(expectOk(await repository.files.list())).toEqual([
			'docs/B.md',
			'keep.md',
		]);
		const next = await prepareCommit(repository.storage, {
			...author,
			timestamp: 2,
		});
		expect(next?.head).not.toBe(head.head);
		expect(await text(repository, 'keep.md')).toBe('keep');
	} finally {
		repository.close();
	}
	await expect(repository.files.read('keep.md')).rejects.toThrow(
		'Repository is closed',
	);
});

test('table and row-folder writes share the structural collision protection', async () => {
	const repository = await openRepository(crypto.randomUUID(), {
		notes: { type: 'object' },
	});
	try {
		expectOk(
			await repository.tables.notes.set('one', null, {
				fields: { title: 'Keep row' },
			}),
		);
		expect(
			expectErr(
				await repository.files.write(
					'notes/one.md/attachment.txt',
					null,
					'collision',
				),
			).name,
		).toBe('Occupied');
		expect(expectOk(await repository.tables.notes.get('one'))!.fields).toEqual({
			title: 'Keep row',
		});
		const suffixRow = expectOk(
			await repository.tables.notes.set('one.md', null, {
				fields: { title: 'Suffix row' },
			}),
		).sent;
		expect(
			expectOk(await repository.tables.notes.delete('one.md', suffixRow)),
		).toEqual({ deleted: true });
		expect(expectOk(await repository.tables.notes.get('one'))!.fields).toEqual({
			title: 'Keep row',
		});
		expectOk(
			await repository.files.write(
				'notes/two.md/attachment.txt',
				null,
				'keep attachment',
			),
		);
		expect(
			expectErr(
				await repository.tables.notes.set('two', null, {
					fields: { title: 'collision' },
				}),
			).name,
		).toBe('Occupied');
		expect(expectOk(await repository.files.list('notes/two.md/'))).toEqual([
			'notes/two.md/attachment.txt',
		]);
		expect(expectOk(await repository.tables.notes.delete('two', null))).toEqual(
			{ deleted: false },
		);
		expect(expectOk(await repository.files.list('notes/two.md/'))).toEqual([
			'notes/two.md/attachment.txt',
		]);
	} finally {
		repository.close();
	}
});

test('restoring committed bytes restores the same root and creates no additional commit', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		expectOk(await repository.files.write('one.md', null, 'base\n'));
		await observeEmpty(repository);
		const head = (await prepareCommit(repository.storage, author))!;
		expect(await repository.storage.acknowledge(head.base, head.head)).toBe(
			true,
		);
		expectOk(await repository.files.write('one.md', 'base\n', 'changed\n'));
		expectOk(await repository.files.write('one.md', 'changed\n', 'base\n'));
		const saved = await repository.storage.capture('sync');
		expect(saved.state.workingTree).toBe(
			readCommit(
				saved.objects.get(
					(saved.state.pendingCommit ?? saved.state.remoteBase)!,
				)!.bytes,
			).tree,
		);
		expect(
			await prepareCommit(repository.storage, { ...author, timestamp: 2 }),
		).toBeNull();
	} finally {
		repository.close();
	}
});

test('row sent bases preserve another draft, including schema-invalid fields and raw repairs', async () => {
	const schema = {
		type: 'object',
		properties: { title: { type: 'string' }, done: { type: 'boolean' } },
		required: ['title', 'done'],
	} as const;
	const repository = await openRepository(crypto.randomUUID(), {
		todos: schema,
	});
	try {
		const table = repository.tables.todos;
		const first = expectOk(
			await table.set('one', null, {
				fields: { title: 'First', done: false, extra: 'untouched' },
				body: 'Body\n',
			}),
		).sent;
		expect(first.issues).toBeNull();
		const phone = expectOk(
			await table.set('one', first, { fields: { done: true } }),
		).sent;
		expect(phone.fields.done).toBe(true);
		const laptop = expectOk(
			await table.set('one', first, { fields: { title: 'Laptop' } }),
		).sent;
		// sent is the draft, not the merged row; the draft never showed done:true.
		expect(laptop.fields.done).toBe(false);
		expectOk(
			await table.set('one', laptop, { fields: { title: 'Laptop again' } }),
		);
		const landed = expectOk(await table.get('one'))!;
		expect(landed.fields).toEqual({
			title: 'Laptop again',
			done: true,
			extra: 'untouched',
		});
		expectOk(await table.set('one', landed, { fields: { title: 12 } }));
		const raw = expectOk(await table.get('one'))!;
		expect(raw.issues?.[0]?.kind).toBe('schema');
		expect(raw.fields.title).toBe(12);
		expectOk(
			await repository.files.write(
				'todos/one.md',
				raw.text,
				'---\ntitle: [broken\n---\nKeep body\n',
			),
		);
		const malformed = expectOk(await table.get('one'))!;
		expect(malformed.issues?.[0]?.kind).toBe('frontmatter');
		expect(
			expectErr(
				await table.set('one', raw, { fields: { title: 'stale valid base' } }),
			).name,
		).toBe('Unparseable');
		expect(
			expectErr(
				await table.set('one', malformed, { fields: { title: 'repair?' } }),
			).name,
		).toBe('Unparseable');
		expectOk(
			await repository.files.write(
				'todos/one.md',
				malformed.text,
				'---\ntitle: Repaired\ndone: true\n---\nKeep body\n',
			),
		);
		expect(expectOk(await table.get('one'))!.issues).toBeNull();
		expect(expectOk(await table.list()).map((row) => row.id)).toEqual(['one']);
		expect(expectErr(await table.set('../bad', null, {})).name).toBe(
			'InvalidId',
		);
	} finally {
		repository.close();
	}
});

test('row deletion keeps adjacent files and unseen row edits', async () => {
	const repository = await openRepository(crypto.randomUUID(), {
		notes: { type: 'object' },
	});
	try {
		const table = repository.tables.notes;
		const before = expectOk(
			await table.set('one', null, { fields: { title: 'Before' } }),
		).sent;
		expectOk(
			await repository.files.write(
				'notes/one/nested/a.txt',
				null,
				'attachment',
			),
		);
		expectOk(await repository.files.write('keep.md', null, 'keep'));
		await observeEmpty(repository);
		const committed = (await prepareCommit(repository.storage, author))!;
		expect(
			await repository.storage.acknowledge(committed.base, committed.head),
		).toBe(true);
		const edited = expectOk(
			await table.set('one', before, { fields: { title: 'After' } }),
		).sent;
		expect(expectOk(await table.delete('one', before))).toEqual({
			deleted: false,
		});
		expect(expectOk(await repository.files.list('notes/one/'))).toEqual([
			'notes/one/nested/a.txt',
		]);
		expect(expectOk(await table.delete('one', edited))).toEqual({
			deleted: true,
		});
		expect(expectOk(await repository.files.list())).toEqual([
			'keep.md',
			'notes/one/nested/a.txt',
		]);
		await prepareCommit(repository.storage, { ...author, timestamp: 2 });
		expect(expectOk(await table.list())).toEqual([]);
		expect(
			expectErr(await repository.files.write('notes/../escape/x', null, 'no'))
				.name,
		).toBe('InvalidPath');
		expect(
			expectErr(await repository.files.write('notes/one/../escape', null, 'no'))
				.name,
		).toBe('InvalidPath');
	} finally {
		repository.close();
	}
});
