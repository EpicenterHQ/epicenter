/**
 * Local repository saves across independent IndexedDB connections.
 * Whole-file writes from two connections land whole, the last one winning,
 * while commits race saves; row sets compose and publish whole files; reopen,
 * structural replacement, invalid writes and deletion exercise the
 * production local engine without a filesystem or network substitute.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { readCommit } from '../git/raw-objects.js';
import { type LocalRepository, openRepository } from './repository.js';
import { snapshotContent } from './storage.js';
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
