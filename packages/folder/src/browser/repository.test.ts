/**
 * Local repository saves across independent IndexedDB connections.
 * Whole-file writes from two connections land whole, the last one winning;
 * row sets compose and publish whole files; reopen,
 * structural replacement, invalid writes and deletion exercise the
 * production local engine without a filesystem or network substitute.
 */
import { captureFile, capturePaths } from './repository.test-support.js';
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type LocalRepository, openRepository } from './repository.js';

async function text(repository: LocalRepository, path: string) {
	return expectOk(await captureFile(repository, path))?.content.text();
}

test('whole-file writes from two tabs land whole, the last to land winning', async () => {
	const id = crypto.randomUUID();
	const a = await openRepository(id);
	const b = await openRepository(id);
	try {
		const initial =
			'---\na: 0\nb: 0\n---\nFirst paragraph.\n\nLast paragraph.\n';
		expectOk(await a.put('todos/one.md', initial));
		const changedA = initial.replace('a: 0', 'a: 1');
		const changedB = initial.replace('b: 0', 'b: 1');
		await Promise.all([
			a.put('todos/one.md', changedA).then(expectOk),
			b.put('todos/one.md', changedB).then(expectOk),
		]);
		// The last write to land wins whole; nothing merges them.
		expect([changedA, changedB]).toContain((await text(a, 'todos/one.md'))!);
		expect(await text(b, 'todos/one.md')).toBe(await text(a, 'todos/one.md'));
	} finally {
		a.close();
		b.close();
	}
});

test('conditional puts compare exact content and refuse an occupied path', async () => {
	const id = crypto.randomUUID();
	const a = await openRepository(id);
	const b = await openRepository(id);
	const encoder = new TextEncoder();
	try {
		expectOk(await a.put('note.md', 'One'));
		expect(expectErr(await b.put('note.md', 'New', 'absent')).name).toBe(
			'Changed',
		);
		expectOk(await b.put('note.md', 'Two'));
		expect(
			expectErr(await a.put('note.md', 'Mine', encoder.encode('One'))).name,
		).toBe('Changed');
		expect(await text(a, 'note.md')).toBe('Two');
		expectOk(await a.put('note.md', 'Three', encoder.encode('Two')));
		expect(await text(b, 'note.md')).toBe('Three');
	} finally {
		a.close();
		b.close();
	}
});

test('a competing publication between capture and put is checked again', async () => {
	const id = crypto.randomUUID();
	const a = await openRepository(id);
	const b = await openRepository(id);
	try {
		expectOk(await a.put('note.md', 'Original'));
		const publish = a.storage.publish;
		let raced = false;
		a.storage.publish = async (input) => {
			if (!raced) {
				raced = true;
				expectOk(await b.put('note.md', 'Outside'));
			}
			return publish(input);
		};
		expect(
			expectErr(
				await a.put('note.md', 'Mine', new TextEncoder().encode('Original')),
			).name,
		).toBe('Changed');
		expect(await text(a, 'note.md')).toBe('Outside');
	} finally {
		a.close();
		b.close();
	}
});

test('reopen preserves offline edits', async () => {
	const id = crypto.randomUUID();
	let repository = await openRepository(id);
	try {
		expectOk(await repository.put('notes/one.md', 'Offline first\n'));
		repository.close();
		repository = await openRepository(id);
		expect(await text(repository, 'notes/one.md')).toBe('Offline first\n');
	} finally {
		repository.close();
	}
});

test('a delete removes whatever is there, a missing file is already deleted, and a write recreates it', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		const initial = 'One\n\nMiddle\n\nLast\n';
		expectOk(await repository.put('note.md', initial));
		expectOk(await repository.put('note.md', initial.replace('Last', 'Phone')));
		expectOk(await repository.put('note.md', null));
		expect(await text(repository, 'note.md')).toBeUndefined();
		expectOk(await repository.put('note.md', null));
		const laptop = initial.replace('One', 'Laptop');
		expectOk(await repository.put('note.md', laptop));
		expect(await text(repository, 'note.md')).toBe(laptop);
	} finally {
		repository.close();
	}
});

test('path structure is representable, case twins and non-text input are refused atomically', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		expectOk(await repository.put('docs/A.md', 'A'));
		expectOk(await repository.put('keep.md', 'keep'));
		expect(expectErr(await repository.put('DOCS/B.md', 'B')).name).toBe(
			'CaseTwin',
		);
		expect(expectErr(await repository.put('docs/A.md', '\0')).name).toBe(
			'NotText',
		);
		expect(expectErr(await repository.put('docs/A.md', '\ud800')).name).toBe(
			'NotText',
		);
		for (const path of [
			'/bad',
			'a//b',
			'../a',
			'a/.git/config',
			'a/.GIT/config',
			'a/./b',
		]) {
			expect(expectErr(await repository.put(path, 'bad')).name).toBe(
				'InvalidPath',
			);
		}
		expect(
			expectErr(await repository.put('docs', 'replace directory')).name,
		).toBe('Occupied');
		expect(
			expectErr(await repository.put('docs/A.md/child', 'replace file')).name,
		).toBe('Occupied');
		expect(expectOk(await capturePaths(repository))).toEqual([
			'docs/A.md',
			'keep.md',
		]);
		// A delete permits reusing the now-vacant path.
		expectOk(await repository.put('docs/A.md', null));
		expectOk(await repository.put('docs', 'replace directory'));
		expect(
			expectErr(await repository.put('docs/B.md', 'nested again')).name,
		).toBe('Occupied');
		expectOk(await repository.put('docs', null));
		expectOk(await repository.put('docs/B.md', 'nested again'));
		expect(expectOk(await capturePaths(repository))).toEqual([
			'docs/B.md',
			'keep.md',
		]);
		expect(await text(repository, 'keep.md')).toBe('keep');
	} finally {
		repository.close();
	}
	await expect(repository.put('keep.md', 'again')).rejects.toThrow(
		'Repository is closed',
	);
});

test('restoring earlier bytes restores the same root', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		expectOk(await repository.put('one.md', 'base\n'));
		const before = (await repository.storage.capture([])).state.workingTree;
		expectOk(await repository.put('one.md', 'changed\n'));
		expect((await repository.storage.capture([])).state.workingTree).not.toBe(
			before,
		);
		expectOk(await repository.put('one.md', 'base\n'));
		expect((await repository.storage.capture([])).state.workingTree).toBe(
			before,
		);
	} finally {
		repository.close();
	}
});
