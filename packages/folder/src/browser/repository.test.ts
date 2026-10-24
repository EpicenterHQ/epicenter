/**
 * Local repository saves across independent IndexedDB connections.
 * Whole-file writes from two connections land whole, the last one winning,
 * while commits race saves; row sets compose and publish whole files; reopen,
 * structural replacement, invalid writes and deletion exercise the
 * production local engine without a filesystem or network substitute.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import type { TSchema } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { readCommit } from '../git/raw-objects.js';
import { type EngineTable, folderHandle } from '../handle.js';
import { type LocalRepository, openRepository } from './repository.js';
import { snapshotContent } from './storage.js';
import { prepareCommit } from './sync.js';

const author = { name: 'Test', email: 'test@example.com', timestamp: 1 };

async function text(repository: LocalRepository, path: string) {
	return expectOk(await repository.files.read(path))?.content.text();
}

/** The `Folder` over `repository`, whose owner composes row changes. */
function folderOver(
	repository: LocalRepository,
	tables: Record<string, object>,
) {
	return folderHandle(
		{
			files: repository.files,
			tables: repository.tables as Record<string, EngineTable>,
			subscribe: repository.onChange,
			close: repository.close,
		},
		tables as Record<string, TSchema>,
		{ saveAfterMs: 60_000 },
	);
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

test('whole-file writes from two tabs land whole while a pending commit retains exact identity', async () => {
	const id = crypto.randomUUID();
	const a = await openRepository(id);
	const b = await openRepository(id);
	try {
		const initial =
			'---\na: 0\nb: 0\n---\nFirst paragraph.\n\nLast paragraph.\n';
		expectOk(await a.files.write('todos/one.md', initial));
		await observeEmpty(a);
		const base = (await prepareCommit(a.storage, author))!;
		expect(await a.storage.acknowledge(base.base, base.head)).toBe(true);
		const changedA = initial.replace('a: 0', 'a: 1');
		const changedB = initial.replace('b: 0', 'b: 1');
		await Promise.all([
			a.files.write('todos/one.md', changedA).then(expectOk),
			b.files.write('todos/one.md', changedB).then(expectOk),
			prepareCommit(a.storage, { ...author, timestamp: 2 }),
		]);
		const pending = (await prepareCommit(a.storage, {
			...author,
			timestamp: 3,
		}))!;
		// The last write to land wins whole; nothing merges them.
		expect([changedA, changedB]).toContain((await text(a, 'todos/one.md'))!);
		// A still-unsent candidate is not rebased merely because a new save lands.
		const prior = await text(b, 'todos/one.md');
		expectOk(
			await b.files.write(
				'todos/one.md',
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
		expectOk(await repository.files.write('notes/one.md', 'Offline first\n'));
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

test('a delete removes whatever is there, a missing file is already deleted, and a write recreates it', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		const initial = 'One\n\nMiddle\n\nLast\n';
		expectOk(await repository.files.write('note.md', initial));
		expectOk(
			await repository.files.write('note.md', initial.replace('Last', 'Phone')),
		);
		expectOk(await repository.files.delete('note.md'));
		expect(await text(repository, 'note.md')).toBeUndefined();
		expectOk(await repository.files.delete('note.md'));
		const laptop = initial.replace('One', 'Laptop');
		expectOk(await repository.files.write('note.md', laptop));
		expect(await text(repository, 'note.md')).toBe(laptop);
	} finally {
		repository.close();
	}
});

test('path structure is representable, case twins and non-text input are refused atomically', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		expectOk(await repository.files.write('docs/A.md', 'A'));
		expectOk(await repository.files.write('keep.md', 'keep'));
		expect(expectErr(await repository.files.write('DOCS/B.md', 'B')).name).toBe(
			'CaseTwin',
		);
		expect(
			expectErr(await repository.files.write('docs/A.md', '\0')).name,
		).toBe('NotText');
		expect(
			expectErr(await repository.files.write('docs/A.md', '\ud800')).name,
		).toBe('NotText');
		for (const path of [
			'/bad',
			'a//b',
			'../a',
			'a/.git/config',
			'a/.GIT/config',
			'a/./b',
		]) {
			expect(expectErr(await repository.files.write(path, 'bad')).name).toBe(
				'InvalidPath',
			);
		}
		expect(
			expectErr(await repository.files.write('docs', 'replace directory')).name,
		).toBe('Occupied');
		expect(
			expectErr(await repository.files.write('docs/A.md/child', 'replace file'))
				.name,
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
		// A delete permits reusing the now-vacant path, including offline
		// before those deletions are committed.
		expectOk(await repository.files.delete('docs/A.md'));
		expectOk(await repository.files.write('docs', 'replace directory'));
		const replacement = (await prepareCommit(repository.storage, {
			...author,
			timestamp: 2,
		}))!;
		expect(
			await repository.storage.acknowledge(replacement.base, replacement.head),
		).toBe(true);
		expect(
			expectErr(await repository.files.write('docs/B.md', 'nested again')).name,
		).toBe('Occupied');
		expectOk(await repository.files.delete('docs'));
		expectOk(await repository.files.write('docs/B.md', 'nested again'));
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
	const folder = folderOver(repository, { notes: { type: 'object' } });
	try {
		expectOk(
			await folder.tables.notes!.write('one', {
				fields: { title: 'Keep row' },
			}),
		);
		expect(
			expectErr(
				await folder.files.write('notes/one.md/attachment.txt', 'collision'),
			).name,
		).toBe('Occupied');
		expect(expectOk(await folder.tables.notes!.get('one'))!.fields).toEqual({
			title: 'Keep row',
		});
		expectOk(
			await folder.tables.notes!.write('one.md', {
				fields: { title: 'Suffix row' },
			}),
		);
		expectOk(await folder.tables.notes!.delete('one.md'));
		expect(expectOk(await folder.tables.notes!.get('one.md'))).toBeUndefined();
		expect(expectOk(await folder.tables.notes!.get('one'))!.fields).toEqual({
			title: 'Keep row',
		});
		expectOk(
			await folder.files.write(
				'notes/two.md/attachment.txt',
				'keep attachment',
			),
		);
		expect(
			expectErr(
				await folder.tables.notes!.write('two', {
					fields: { title: 'collision' },
				}),
			).name,
		).toBe('Occupied');
		expect(expectOk(await folder.files.list('notes/two.md/'))).toEqual([
			'notes/two.md/attachment.txt',
		]);
		// No row file is there: the row is already gone, and its folder stays.
		expectOk(await folder.tables.notes!.delete('two'));
		expect(expectOk(await folder.files.list('notes/two.md/'))).toEqual([
			'notes/two.md/attachment.txt',
		]);
	} finally {
		await folder.close();
	}
});

test('restoring committed bytes restores the same root and creates no additional commit', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		expectOk(await repository.files.write('one.md', 'base\n'));
		await observeEmpty(repository);
		const head = (await prepareCommit(repository.storage, author))!;
		expect(await repository.storage.acknowledge(head.base, head.head)).toBe(
			true,
		);
		expectOk(await repository.files.write('one.md', 'changed\n'));
		expectOk(await repository.files.write('one.md', 'base\n'));
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

test('document saves patch the known row, keep other values, and refuse patches over a broken header', async () => {
	const schema = {
		type: 'object',
		properties: { title: { type: 'string' }, done: { type: 'boolean' } },
		required: ['title', 'done'],
	} as const;
	const repository = await openRepository(crypto.randomUUID(), {
		todos: schema,
	});
	const folder = folderOver(repository, { todos: schema });
	try {
		const first = expectOk(
			await folder.tables.todos!.write('one', {
				fields: { title: 'First', done: false, extra: 'untouched' },
				body: 'Body\n',
			}),
		);
		expect(first.issues).toBeNull();
		const edit = folder.tables.todos!.document('one');
		expectOk(await edit.refresh());
		expectOk(edit.patch({ fields: { done: true } }));
		expectOk(await edit.save());
		const phone = folder.tables.todos!.parse(edit.getSnapshot().text!);
		expect(phone.fields).toMatchObject({ done: true });
		expectOk(edit.patch({ fields: { title: 'Laptop' } }));
		expectOk(await edit.save());
		const laptop = folder.tables.todos!.parse(edit.getSnapshot().text!);
		// Parsing the saved text answers the patch over what was known.
		expect(laptop.fields).toMatchObject({ done: true });
		expect(laptop.body).toBe('Body\n');
		expectOk(edit.patch({ fields: { title: 'Laptop again' } }));
		expectOk(await edit.save());
		const landed = expectOk(await folder.tables.todos!.get('one'))!;
		expect(landed.fields).toEqual({
			title: 'Laptop again',
			done: true,
			extra: 'untouched',
		});
		expectOk(edit.patch({ fields: { title: 12 } }));
		expectOk(await edit.save());
		const raw = expectOk(await folder.tables.todos!.get('one'))!;
		expect(raw.issues?.[0]?.kind).toBe('schema');
		expect(raw.fields).toMatchObject({ title: 12 });
		expectOk(
			await folder.files.write(
				'todos/one.md',
				'---\ntitle: [broken\n---\nKeep body\n',
			),
		);
		const malformed = expectOk(await folder.tables.todos!.get('one'))!;
		expect(malformed.issues?.[0]?.kind).toBe('frontmatter');
		expectOk(await edit.refresh());
		expect(expectErr(edit.patch({ fields: { title: 'repair?' } })).name).toBe(
			'MalformedFrontmatter',
		);
		expect(expectErr(edit.patch({ body: 'New body\n' })).name).toBe(
			'MalformedFrontmatter',
		);
		expect(await text(repository, 'todos/one.md')).toBe(
			'---\ntitle: [broken\n---\nKeep body\n',
		);
		expectOk(
			await folder.files.write(
				'todos/one.md',
				'---\ntitle: Repaired\ndone: true\n---\nKeep body\n',
			),
		);
		expect(expectOk(await folder.tables.todos!.get('one'))!.issues).toBeNull();
		expect(
			expectOk(await folder.tables.todos!.list()).map((row) => row.id),
		).toEqual(['one']);
		expect(expectErr(await folder.tables.todos!.write('../bad', {})).name).toBe(
			'InvalidId',
		);
	} finally {
		await folder.close();
	}
});

test('row deletion removes the row as stored and keeps adjacent files', async () => {
	const repository = await openRepository(crypto.randomUUID(), {
		notes: { type: 'object' },
	});
	const folder = folderOver(repository, { notes: { type: 'object' } });
	try {
		expectOk(
			await folder.tables.notes!.write('one', { fields: { title: 'Before' } }),
		);
		expectOk(
			await repository.files.write('notes/one/nested/a.txt', 'attachment'),
		);
		expectOk(await repository.files.write('keep.md', 'keep'));
		await observeEmpty(repository);
		const committed = (await prepareCommit(repository.storage, author))!;
		expect(
			await repository.storage.acknowledge(committed.base, committed.head),
		).toBe(true);
		const edit = folder.tables.notes!.document('one');
		expectOk(await edit.refresh());
		expectOk(edit.patch({ fields: { title: 'After' } }));
		expectOk(await edit.save());
		expectOk(await folder.tables.notes!.delete('one'));
		expect(expectOk(await repository.files.list('notes/one/'))).toEqual([
			'notes/one/nested/a.txt',
		]);
		expectOk(await folder.tables.notes!.delete('one'));
		expect(expectOk(await repository.files.list())).toEqual([
			'keep.md',
			'notes/one/nested/a.txt',
		]);
		await prepareCommit(repository.storage, { ...author, timestamp: 2 });
		expect(expectOk(await folder.tables.notes!.list())).toEqual([]);
		expect(
			expectErr(await repository.files.write('notes/../escape/x', 'no')).name,
		).toBe('InvalidPath');
		expect(
			expectErr(await repository.files.write('notes/one/../escape', 'no')).name,
		).toBe('InvalidPath');
	} finally {
		await folder.close();
	}
});

test('an ignore edit during preparation invalidates the candidate and retries with the new rule', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		await observeEmpty(repository);
		expectOk(await repository.files.write('.gitignore', '/audio/\n'));
		expectOk(
			await repository.files.write('audio/take.wav', Uint8Array.of(0, 255)),
		);
		const publish = repository.storage.publish;
		let changed = false;
		repository.storage.publish = async (input) => {
			if (!changed && input.refs?.pendingCommit) {
				changed = true;
				expectOk(await repository.files.write('.gitignore', ''));
			}
			return publish(input);
		};
		const prepared = (await prepareCommit(repository.storage, author))!;
		const snapshot = await repository.storage.capture('sync');
		expect(changed).toBe(true);
		expect(readCommit(snapshot.objects.get(prepared.head)!.bytes).tree).toBe(
			snapshot.state.workingTree,
		);
		expect(snapshotContent(snapshot, 'audio/take.wav')).toEqual(
			Uint8Array.of(0, 255),
		);
	} finally {
		repository.close();
	}
});

test('an editor save racing another connection lands its exact text, and the last publication wins', async () => {
	const id = crypto.randomUUID();
	const a = await openRepository(id);
	const b = await openRepository(id);
	const folder = folderHandle(
		{ files: a.files, tables: {}, subscribe: a.onChange, close: a.close },
		{},
		{ saveAfterMs: 60_000 },
	);
	const path = 'a.md';
	const header =
		"﻿---\r\n# untouched header\r\ntitle: 'Old' # quote\r\nanchor: &a { n: 1 }\r\ncopy: *a\r\n---\r\n";
	const original = `${header}one\r\ntwo\r\nthree\r\n`;
	try {
		expectOk(await folder.files.write(path, original));
		const edit = folder.files.document(path);
		expectOk(await edit.refresh());
		expectOk(edit.patch({ body: 'one\r\ntwo\r\nTHREE\r\n' }));
		const publish = a.storage.publish;
		let attempts = 0;
		a.storage.publish = async (input) => {
			if (++attempts === 1)
				expectOk(await b.files.write(path, original.replace('one', 'ONE')));
			return publish(input);
		};
		expectOk(await edit.save());
		expect(attempts).toBe(2);
		const saved = expectOk(await a.files.read(path));
		const stored = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
			await saved?.content.arrayBuffer(),
		);
		expect(stored).toBe(`${header}one\r\ntwo\r\nTHREE\r\n`);
		expect(edit.getSnapshot()).toMatchObject({
			isDirty: false,
			saveError: undefined,
		});
		expect(edit.getSnapshot().text).toBe(stored);
	} finally {
		await folder.close();
		b.close();
	}
});
