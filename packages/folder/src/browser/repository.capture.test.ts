/**
 * Scoped capture regressions
 *
 * Point reads, row lists and prefix lists avoid unrelated trees without losing
 * effective directory occupancy. Pending deletions may empty a directory, while
 * untouched raw occupancy and the current commit remain protected.
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
			revision: 0,
			objects: candidate.objects,
			refs: { base: head, head, shallow: [head] },
			remoteKnown: true,
		}),
	).toBe(true);
	return { head };
}

const trees = (
	snapshot: Awaited<ReturnType<LocalRepository['storage']['capture']>>,
) =>
	[...snapshot.objects.values()].filter((object) => object.type === 'tree')
		.length;

test('one file captures its ancestor trees and commits without reading the unrelated archive', async () => {
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
		expectOk(
			await repository.files.write('archive/0/file.txt', '0\n', 'changed\n'),
		);
		const commitInput = await repository.storage.capture('commit');
		expect(trees(commitInput)).toBe(3);
		expect(
			[...commitInput.objects.values()].some(
				(object) => object.type === 'blob',
			),
		).toBe(false);
		expectOk(await repository.prepareCommit(author));
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
		expectOk(
			await repository.files.write('notes/new/extra.txt', null, 'pending'),
		);
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
			expectErr(await repository.files.write('notes', null, 'replacement'))
				.name,
		).toBe('CaseTwin');
		expect(
			expectOk(await repository.files.delete('Notes/folder/file.txt', 'old')),
		).toEqual({ deleted: true });
		expectOk(await repository.files.write('notes', null, 'replacement'));
		expectOk(await repository.prepareCommit(author));
		expect(expectOk(await repository.files.list())).toEqual(['notes']);
	} finally {
		repository.close();
	}
});

test('a pending current commit can be read without decoding its incorporated base', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		const fixture = await seed(repository, [['keep/file.txt', 'content']]);
		const { state } = await repository.storage.capture([]);
		// The old base's bytes are intentionally absent. Current-data operations
		// require C; future reconciliation must explicitly obtain B when needed.
		expect(
			await repository.storage.publish({
				revision: state.revision,
				refs: {
					base: 'a'.repeat(40),
					head: state.head,
					shallow: state.shallow,
				},
			}),
		).toBe(true);
		expect(
			await expectOk(
				await repository.files.read('keep/file.txt'),
			)!.content.text(),
		).toBe('content');
		expectOk(await repository.files.write('keep/file.txt', 'content', 'newer'));
		expect(expectOk(await repository.prepareCommit(author))).toEqual({
			base: 'a'.repeat(40),
			head: fixture.head,
		});
	} finally {
		repository.close();
	}
});
