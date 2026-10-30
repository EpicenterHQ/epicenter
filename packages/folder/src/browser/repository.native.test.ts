/**
 * Local API operations over native Git content the text library did not author.
 * Exact byte witnesses protect BOM/binary content, opaque entries retain their
 * paths, and deleting a row preserves adjacent files without decoding names.
 */
import {
	anyFields,
	captureFile,
	capturePaths,
	captureRow,
} from './repository.test-support.js';
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type GitObject,
	hashObject,
	readTree,
	type TreeEntry,
	writeCommit,
	writeTree,
} from '../git/raw-objects.js';
import { type LocalRepository, openRepository } from './repository.js';
import { prepareCommit } from './sync.js';

const encoder = new TextEncoder();
const author = {
	name: 'Native fixture',
	email: 'native@example.com',
	timestamp: 1,
};

async function nativeFixture(repository: LocalRepository) {
	const objects = new Map<string, GitObject>();
	async function add(type: GitObject['type'], bytes: Uint8Array | string) {
		const object = {
			type,
			bytes: typeof bytes === 'string' ? encoder.encode(bytes) : bytes,
		};
		const oid = await hashObject(object);
		objects.set(oid, object);
		return oid;
	}
	const entry = (
		name: string | Uint8Array,
		oid: string,
		mode = '100644',
	): TreeEntry => ({
		name: typeof name === 'string' ? encoder.encode(name) : name,
		oid,
		mode,
	});
	const plain = await add('blob', 'plain\n');
	const binary = await add('blob', new Uint8Array([0xff, 0, 0x80]));
	const bom = await add('blob', '\uFEFFText\n');
	const row = await add('blob', '---\ntitle: One\n---\nBody\n');
	const hidden = await add(
		'tree',
		writeTree([entry(new Uint8Array([0xff]), binary)]),
	);
	const folder = await add(
		'tree',
		writeTree([entry('a.txt', plain), entry(new Uint8Array([0xfe]), binary)]),
	);
	const notes = await add(
		'tree',
		writeTree([
			entry('one.md', row),
			entry('one', folder, '40000'),
			entry('binary.md', binary),
		]),
	);
	const root = await add(
		'tree',
		writeTree([
			entry('plain.md', plain),
			entry('binary', binary),
			entry('bom.md', bom),
			entry('link', plain, '120000'),
			entry('vendor', '1'.repeat(40), '160000'),
			entry('docs', hidden, '40000'),
			entry('notes', notes, '40000'),
		]),
	);
	const commit = await add(
		'commit',
		writeCommit({
			tree: root,
			parents: [],
			author,
			message: 'Native snapshot\n',
		}),
	);
	expect(
		await repository.storage.publish({
			expected: (await repository.storage.capture([])).state,
			workingTree: root,
			objects,
			refs: { remoteBase: commit, pendingCommit: null },
		}),
	).toBe(true);
	return { objects, binary, root, folder, commit };
}

test('BOM and binary files and rows delete whole, and caller bytes cannot change a queued write', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		await nativeFixture(repository);
		for (const path of ['bom.md', 'binary']) {
			expectOk(await captureFile(repository, path));
			expectOk(await repository.put(path, null));
			expect(expectOk(await captureFile(repository, path))).toBeUndefined();
		}
		const bytes = Uint8Array.of(1, 2, 3);
		const writing = repository.put('copied.bin', bytes);
		bytes.fill(0); // Happens while the asynchronous capture is still running.
		expectOk(await writing);
		const copied = expectOk(await captureFile(repository, 'copied.bin'))!;
		expect(new Uint8Array(await copied.content.arrayBuffer())).toEqual(
			Uint8Array.of(1, 2, 3),
		);
		expectOk(await captureRow(repository, 'notes', 'binary', anyFields));
		expectOk(await repository.put('notes/binary.md', null));
		expect(
			expectOk(await captureRow(repository, 'notes', 'binary', anyFields)),
		).toBeUndefined();
	} finally {
		repository.close();
	}
});

test('gitlinks stay structural leaves a file delete leaves alone, and can be explicitly replaced with text', async () => {
	const id = crypto.randomUUID();
	let repository = await openRepository(id);
	try {
		await nativeFixture(repository);
		expect(expectOk(await capturePaths(repository))).not.toContain('vendor');
		expect(expectOk(await captureFile(repository, 'vendor'))).toBeUndefined();
		expectOk(await repository.put('vendor', null));
		expectOk(await repository.put('plain.md', 'changed\n'));
		const pending = (await prepareCommit(repository.storage, author))!;
		expect(
			(await repository.storage.capture([])).files.get('vendor')?.mode,
		).toBe('160000');
		expect(
			await repository.storage.acknowledge(pending.base, pending.head),
		).toBe(true);
		repository.close();
		repository = await openRepository(id);
		expect(
			(await repository.storage.capture([])).files.get('vendor')?.mode,
		).toBe('160000');
		expectOk(await repository.put('vendor', 'regular file\n'));
		await prepareCommit(repository.storage, author);
		expect(
			(await repository.storage.capture([])).files.get('vendor')?.mode,
		).toBe('100644');
	} finally {
		repository.close();
	}
});

test('subset capture omits unrelated blobs and preserves opaque directories and native modes', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		const native = await nativeFixture(repository);
		const snapshot = await repository.storage.capture(['plain.md']);
		expect(snapshot.objects.has(native.binary)).toBe(false);
		expect(snapshot.directories.has('docs')).toBe(true);
		expect(expectErr(await repository.put('Docs/new.md', 'new')).name).toBe(
			'CaseTwin',
		);
		expect(
			expectErr(await repository.put('docs', 'replace unseen names')).name,
		).toBe('Occupied');
		expectOk(await repository.put('plain.md', 'changed\n'));
		await prepareCommit(repository.storage, author);
		const after = await repository.storage.capture([]);
		const entries = readTree(
			after.objects.get(after.state.workingTree!)!.bytes,
		);
		const prior = readTree(native.objects.get(native.root)!.bytes);
		for (const name of ['docs', 'link', 'vendor']) {
			const named = (entry: TreeEntry) =>
				new TextDecoder().decode(entry.name) === name;
			expect(entries.find(named)).toEqual(prior.find(named));
		}
	} finally {
		repository.close();
	}
});

test('row deletion keeps adjacent native names without decoding or rewriting them', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		const native = await nativeFixture(repository);
		expectOk(await repository.put('notes/one.md', null));
		await prepareCommit(repository.storage, author);
		const snapshot = await repository.storage.capture([]);
		expect(snapshot.files.has('notes/one.md')).toBe(false);
		const notes = readTree(
			snapshot.objects.get(snapshot.state.workingTree!)!.bytes,
		).find((entry) => new TextDecoder().decode(entry.name) === 'notes')!;
		const folder = readTree(snapshot.objects.get(notes.oid)!.bytes).find(
			(entry) => new TextDecoder().decode(entry.name) === 'one',
		)!;
		expect(folder.oid).toBe(native.folder);
	} finally {
		repository.close();
	}
});

test('closing during an unpublished operation returns a storage failure and retains acknowledged work', async () => {
	const id = crypto.randomUUID();
	let repository = await openRepository(id);
	try {
		expectOk(await repository.put('keep.md', 'saved\n'));
		const writing = repository.put('unacknowledged.md', 'not yet saved\n');
		repository.close();
		expect(expectErr(await writing).name).toBe('StorageFailed');
		repository = await openRepository(id);
		expect(
			await expectOk(await captureFile(repository, 'keep.md'))!.content.text(),
		).toBe('saved\n');
		expect(
			expectOk(await captureFile(repository, 'unacknowledged.md')),
		).toBeUndefined();
	} finally {
		repository.close();
	}
});
