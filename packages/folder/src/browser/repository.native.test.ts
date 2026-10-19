/**
 * Local API operations over native Git content the text library did not author.
 * Exact byte witnesses protect BOM/binary content, opaque entries retain their
 * paths, and deleting a row preserves adjacent files without decoding names.
 */
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
} from './git/objects.js';
import { type LocalRepository, openRepository } from './repository.js';

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
			revision: 0,
			objects,
			refs: { base: commit, head: commit, shallow: [commit] },
			remoteKnown: true,
		}),
	).toBe(true);
	return { objects, binary, root, folder, commit };
}

test('exact byte bases delete BOM and binary files while caller buffer mutation cannot change the witness', async () => {
	const repository = await openRepository(crypto.randomUUID(), {
		notes: { type: 'object' },
	});
	try {
		await nativeFixture(repository);
		for (const path of ['bom.md', 'binary']) {
			const file = expectOk(await repository.files.read(path))!;
			const from = new Uint8Array(await file.content.arrayBuffer());
			const deleting = repository.files.delete(path, from);
			from.fill(0); // Happens while the asynchronous capture is still running.
			expect(expectOk(await deleting)).toEqual({ deleted: true });
			expect(expectOk(await repository.files.read(path))).toBeUndefined();
		}
		const binaryRow = expectOk(await repository.tables.notes.get('binary'))!;
		expect(
			expectErr(await repository.tables.notes.delete('binary', binaryRow)).name,
		).toBe('NotText');
	} finally {
		repository.close();
	}
});

test('gitlinks stay structural leaves, report truthful deletion, and can be explicitly replaced with text', async () => {
	const id = crypto.randomUUID();
	let repository = await openRepository(id);
	try {
		await nativeFixture(repository);
		expect(expectOk(await repository.files.list())).not.toContain('vendor');
		expect(expectOk(await repository.files.read('vendor'))).toBeUndefined();
		expect(expectOk(await repository.files.delete('vendor', null))).toEqual({
			deleted: false,
		});
		expectOk(await repository.files.write('plain.md', 'plain\n', 'changed\n'));
		const pending = expectOk(await repository.prepareCommit(author))!;
		expect(
			(await repository.storage.capture([])).head.files.get('vendor')?.mode,
		).toBe('160000');
		expect(
			await repository.storage.acknowledge(pending.base, pending.head),
		).toBe(true);
		repository.close();
		repository = await openRepository(id);
		expect(
			(await repository.storage.capture([])).head.files.get('vendor')?.mode,
		).toBe('160000');
		expectOk(await repository.files.write('vendor', null, 'regular file\n'));
		expectOk(await repository.prepareCommit(author));
		expect(
			(await repository.storage.capture([])).head.files.get('vendor')?.mode,
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
		expect(snapshot.head.opaqueDirectories.has('docs')).toBe(true);
		expect(
			expectErr(await repository.files.write('Docs/new.md', null, 'new')).name,
		).toBe('CaseTwin');
		expect(
			expectErr(
				await repository.files.write('docs', null, 'replace unseen names'),
			).name,
		).toBe('Occupied');
		expectOk(await repository.files.write('plain.md', 'plain\n', 'changed\n'));
		expectOk(await repository.prepareCommit(author));
		const after = await repository.storage.capture([]);
		const entries = readTree(after.objects.get(after.head.root!)!.bytes);
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
	const repository = await openRepository(crypto.randomUUID(), {
		notes: { type: 'object' },
	});
	try {
		const native = await nativeFixture(repository);
		const row = expectOk(await repository.tables.notes.get('one'))!;
		expect(expectOk(await repository.tables.notes.delete('one', row))).toEqual({
			deleted: true,
		});
		expectOk(await repository.prepareCommit(author));
		const snapshot = await repository.storage.capture([]);
		expect(snapshot.head.files.has('notes/one.md')).toBe(false);
		const notes = readTree(
			snapshot.objects.get(snapshot.head.root!)!.bytes,
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
		expectOk(await repository.files.write('keep.md', null, 'saved\n'));
		const writing = repository.files.write(
			'unacknowledged.md',
			null,
			'not yet saved\n',
		);
		repository.close();
		expect(expectErr(await writing).name).toBe('StorageFailed');
		repository = await openRepository(id);
		expect(
			await expectOk(await repository.files.read('keep.md'))!.content.text(),
		).toBe('saved\n');
		expect(
			expectOk(await repository.files.read('unacknowledged.md')),
		).toBeUndefined();
	} finally {
		repository.close();
	}
});
