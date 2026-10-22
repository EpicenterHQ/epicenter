/**
 * Scoped capture regressions
 *
 * Point reads, row lists and prefix lists avoid unrelated trees without losing
 * directory occupancy. Deleting the last child prunes its directory immediately;
 * current files do not require decoding either sync checkpoint.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type GitObject, hashObject, writeCommit } from '../git/raw-objects.js';
import { changeSnapshot } from './git/snapshot.js';
import { type LocalRepository, openRepository } from './repository.js';

const author = { name: 'Capture', email: 'capture@example.com', timestamp: 1 };

async function seed(repository: LocalRepository, files: [string, string][]) {
	const candidate = await changeSnapshot({
		root: null,
		edits: new Map(files),
		read: async () => {
			throw new Error('Fresh fixture has no prior tree');
		},
	});
	const commit: GitObject = {
		type: 'commit',
		bytes: writeCommit({
			tree: candidate.tree,
			parents: [],
			author,
			message: 'Fixture\n',
		}),
	};
	const head = await hashObject(commit);
	candidate.objects.set(head, commit);
	expect(
		await repository.storage.publish({
			expected: (await repository.storage.capture([])).state,
			workingTree: candidate.tree,
			objects: candidate.objects,
			refs: { remoteBase: head, pendingCommit: null },
		}),
	).toBe(true);
	return { head };
}

const trees = (
	snapshot: Awaited<ReturnType<LocalRepository['storage']['capture']>>,
) =>
	[...snapshot.objects.values()].filter((object) => object.type === 'tree')
		.length;

test('one file captures its ancestor trees without reading the unrelated archive', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		await seed(
			repository,
			Array.from(
				{ length: 40 },
				(_, index) =>
					[`archive/${index}/file.txt`, `${index}\n`] as [string, string],
			),
		);
		const capture = await repository.storage.capture(['archive/0/file.txt']);
		expect(trees(capture)).toBe(3);
		expectOk(await repository.files.write('archive/0/file.txt', 'changed\n'));
		const after = await repository.storage.capture(['archive/0/file.txt']);
		expect(trees(after)).toBe(3);
		expect(
			await expectOk(
				await repository.files.read('archive/0/file.txt'),
			)!.content.text(),
		).toBe('changed\n');
		expect(
			await expectOk(
				await repository.files.read('archive/39/file.txt'),
			)!.content.text(),
		).toBe('39\n');
	} finally {
		repository.close();
	}
});

test('row lists omit attachment trees while prefix lists retain partial filename matching and pending children', async () => {
	const repository = await openRepository(crypto.randomUUID(), {
		notes: { type: 'object' },
	});
	try {
		await seed(repository, [
			['notes/one.md', '---\ntitle: One\n---\nBody\n'],
			['notes/one/deep/file.txt', 'attachment'],
			['notes/two.md', '---\ntitle: Two\n---\n'],
			['archive/nested/file.txt', 'archive'],
		]);
		expect(trees(await repository.storage.capture({ rows: 'notes' }))).toBe(2);
		expect(
			expectOk(await repository.tables.notes.list()).map((row) => row.id),
		).toEqual(['one', 'two']);
		expect(expectOk(await repository.files.list('notes/on'))).toEqual([
			'notes/one.md',
			'notes/one/deep/file.txt',
		]);
		expect(
			trees(await repository.storage.capture({ prefix: 'notes/tw' })),
		).toBe(2);
		expectOk(await repository.files.write('notes/new/extra.txt', 'pending'));
		expect(expectOk(await repository.files.list('notes/ne'))).toEqual([
			'notes/new/extra.txt',
		]);
		expect(expectOk(await repository.files.list('notes/one/'))).toEqual([
			'notes/one/deep/file.txt',
		]);
	} finally {
		repository.close();
	}
});

test('deleting the final child removes directory occupancy and its case twin before commit', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		await seed(repository, [['Notes/folder/file.txt', 'old']]);
		expect(
			expectErr(await repository.files.write('notes', 'replacement')).name,
		).toBe('CaseTwin');
		expectOk(await repository.files.delete('Notes/folder/file.txt'));
		expectOk(await repository.files.write('notes', 'replacement'));

		expect(expectOk(await repository.files.list())).toEqual(['notes']);
	} finally {
		repository.close();
	}
});

test('working files remain readable and editable without decoding the received checkpoint', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		const fixture = await seed(repository, [['keep/file.txt', 'content']]);
		const { state } = await repository.storage.capture([]);
		// B's bytes are intentionally absent. File operations need only W;
		// synchronization must explicitly capture its checkpoints.
		expect(
			await repository.storage.publish({
				expected: state,
				refs: {
					remoteBase: 'a'.repeat(40),
					pendingCommit: fixture.head,
				},
			}),
		).toBe(true);
		expect(
			await expectOk(
				await repository.files.read('keep/file.txt'),
			)!.content.text(),
		).toBe('content');
		expectOk(await repository.files.write('keep/file.txt', 'newer'));
	} finally {
		repository.close();
	}
});
