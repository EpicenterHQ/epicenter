/**
 * Browser staged commits compare their candidate tree with the pinned
 * parent's tree, or Git's empty tree before the first commit. An empty
 * index publishes nothing; a staged empty file is a real first commit.
 * Repeating an unchanged staged commit preserves the branch and index.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { rawBrowserFolder } from '../browser-storage.test-support.js';
import { hashBytes } from '../capture.js';
import { commitTree, readTreeFiles } from './objects.js';

const author = { name: 'Stager', email: 'stager@example.test' };

test('an empty initial index publishes no commit and changes no stored state', async () => {
	const raw = await rawBrowserFolder({ id: 'empty-index' });
	const backend = await raw.backend();
	// The first Git write creates the repository. Staging the empty folder is
	// that write here; this test is about the commit after it.
	await backend.exclusive(() => backend.stage('all'));
	const before = await raw.dump();

	expect(
		await backend.exclusive(() => backend.commitIndex('Empty', author)),
	).toEqual({ status: 'nothing' });
	expect(await backend.readBranch()).toBeUndefined();
	expect(await raw.dump()).toEqual(before);
});

test('a staged empty file commits once and an unchanged index publishes nothing', async () => {
	const raw = await rawBrowserFolder({ id: 'empty-file' });
	const backend = await raw.backend();
	const bytes = new Uint8Array();
	expectOk(
		await raw.boundary.apply([
			{
				kind: 'create',
				path: 'notes/empty.md',
				bytes,
				sha256: await hashBytes(bytes),
			},
		]),
	);
	await backend.exclusive(() => backend.stage('all'));
	const committed = await backend.exclusive(() =>
		backend.commitIndex('Empty file', author),
	);
	expect(committed.status).toBe('committed');
	if (committed.status !== 'committed')
		throw new Error('The file was not committed');
	expect(committed.parent).toBeUndefined();
	expect(await backend.readBranch()).toBe(committed.oid);
	const tree = await backend.withObjects(async (access) =>
		readTreeFiles(access, await commitTree(access, committed.oid)),
	);
	expect([...tree]).toEqual([
		[
			'notes/empty.md',
			{ mode: '100644', oid: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' },
		],
	]);
	const before = await raw.dump();
	expect(
		await backend.exclusive(() => backend.commitIndex('Again', author)),
	).toEqual({ status: 'nothing' });
	expect(await raw.dump()).toEqual(before);
});
