/**
 * Scoped capture regressions
 *
 * Point reads, row lists and prefix lists avoid unrelated trees without losing
 * directory occupancy. Deleting the last child prunes its directory immediately.
 */
import {
	captureFile,
	capturePaths,
	captureRows,
} from './repository.test-support.js';
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { changeSnapshot } from './git/snapshot.js';
import { type LocalRepository, openRepository } from './repository.js';

async function seed(repository: LocalRepository, files: [string, string][]) {
	const candidate = await changeSnapshot({
		root: null,
		edits: new Map(files),
		read: async () => {
			throw new Error('Fresh fixture has no prior tree');
		},
	});
	expect(
		await repository.storage.publish({
			expected: (await repository.storage.capture([])).state.workingTree,
			workingTree: candidate.tree,
			objects: candidate.objects,
		}),
	).toBe(true);
}

const trees = (
	snapshot: Awaited<ReturnType<LocalRepository['storage']['capture']>>,
) =>
	[...snapshot.objects.values()].filter((object) => object.type === 'tree')
		.length;

test('one file captures its ancestor trees without reading the unrelated archive', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		// SAFETY: each generated pair contains a path and its text.
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
		expectOk(await repository.put('archive/0/file.txt', 'changed\n'));
		const after = await repository.storage.capture(['archive/0/file.txt']);
		expect(trees(after)).toBe(3);
		expect(
			await expectOk(
				await captureFile(repository, 'archive/0/file.txt'),
			)!.content.text(),
		).toBe('changed\n');
		expect(
			await expectOk(
				await captureFile(repository, 'archive/39/file.txt'),
			)!.content.text(),
		).toBe('39\n');
	} finally {
		repository.close();
	}
});

test('row lists omit attachment trees while prefix lists retain partial filename matching and pending children', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		await seed(repository, [
			['notes/one.md', '---\ntitle: One\n---\nBody\n'],
			['notes/one/deep/file.txt', 'attachment'],
			['notes/two.md', '---\ntitle: Two\n---\n'],
			['archive/nested/file.txt', 'archive'],
		]);
		expect(trees(await repository.storage.capture({ rows: 'notes' }))).toBe(2);
		expect(
			expectOk(await captureRows(repository, 'notes')).map((row) => row.id),
		).toEqual(['one', 'two']);
		expect(expectOk(await capturePaths(repository, 'notes/on'))).toEqual([
			'notes/one.md',
			'notes/one/deep/file.txt',
		]);
		expect(
			trees(await repository.storage.capture({ prefix: 'notes/tw' })),
		).toBe(2);
		expectOk(await repository.put('notes/new/extra.txt', 'pending'));
		expect(expectOk(await capturePaths(repository, 'notes/ne'))).toEqual([
			'notes/new/extra.txt',
		]);
		expect(expectOk(await capturePaths(repository, 'notes/one/'))).toEqual([
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
		expect(expectErr(await repository.put('notes', 'replacement')).name).toBe(
			'CaseTwin',
		);
		expectOk(await repository.put('Notes/folder/file.txt', null));
		expectOk(await repository.put('notes', 'replacement'));

		expect(expectOk(await capturePaths(repository))).toEqual(['notes']);
	} finally {
		repository.close();
	}
});
