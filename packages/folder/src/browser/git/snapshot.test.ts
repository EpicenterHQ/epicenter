/**
 * Snapshot tree tests
 *
 * Verifies checkout-free reads and edits preserve unrelated raw Git entries,
 * rebuild only affected trees, and produce nested objects native Git accepts.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type GitObject,
	hashObject,
	readTree,
	type TreeEntry,
	writeCommit,
	writeTree,
} from '../../git/raw-objects.js';
import { changeSnapshot, readSnapshot } from './snapshot.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const entry = (
	name: string | Uint8Array,
	oid: string,
	mode = '100644',
): TreeEntry => ({
	name: typeof name === 'string' ? encoder.encode(name) : name,
	oid,
	mode,
});

function createObjects() {
	const objects = new Map<string, GitObject>();
	const reads: string[] = [];
	async function add(type: GitObject['type'], bytes: Uint8Array | string) {
		const object = {
			type,
			bytes: typeof bytes === 'string' ? encoder.encode(bytes) : bytes,
		};
		const oid = await hashObject(object);
		objects.set(oid, object);
		return oid;
	}
	async function read(oid: string) {
		reads.push(oid);
		const object = objects.get(oid);
		if (object === undefined) throw new Error(`Missing object ${oid}`);
		return object;
	}
	const tree = (entries: readonly TreeEntry[]) =>
		add('tree', writeTree(entries));
	return { objects, reads, add, read, tree };
}

test('null commit reads an empty snapshot without touching storage', async () => {
	const store = createObjects();
	expect(await readSnapshot(null, store.read)).toEqual({
		files: new Map(),
		directories: new Set(),
	});
	expect(store.reads).toEqual([]);
});

test('a pending binary edit becomes an exact Git blob', async () => {
	const bytes = new Uint8Array([0, 1, 255]);
	const changed = await changeSnapshot({
		root: null,
		edits: new Map([['audio/clip.bin', bytes]]),
		read: async () => {
			throw new Error('No prior object exists');
		},
	});
	const file = readTree(changed.objects.get(changed.tree)!.bytes)[0]!;
	const directory = changed.objects.get(file.oid)!;
	const clip = readTree(directory.bytes)[0]!;
	expect(changed.objects.get(clip.oid)).toEqual({ type: 'blob', bytes });
});

test('reads complete nested trees, preserving leaf modes and BOM names without following links', async () => {
	const store = createObjects();
	const blob = await store.add('blob', 'text');
	const linkedCommit = '1'.repeat(40);
	const nested = await store.tree([
		entry('readme.md', blob),
		entry('run', blob, '100755'),
	]);
	const root = await store.tree([
		entry('docs', nested, '40000'),
		entry('link', blob, '120000'),
		entry('vendor', linkedCommit, '160000'),
		entry('\uFEFFname', blob),
	]);

	const snapshot = await readSnapshot(root, store.read);
	expect(snapshot).toEqual({
		directories: new Set(['docs']),
		files: new Map([
			['docs/readme.md', { oid: blob, mode: '100644' }],
			['docs/run', { oid: blob, mode: '100755' }],
			['link', { oid: blob, mode: '120000' }],
			['vendor', { oid: linkedCommit, mode: '160000' }],
			['\uFEFFname', { oid: blob, mode: '100644' }],
		]),
	});
	expect(store.reads.sort()).toEqual([root, nested].sort());
});

test('hidden and non-UTF8 names suppress exposure but their nested trees are read', async () => {
	const store = createObjects();
	const blob = await store.add('blob', 'text');
	const hidden = await store.tree([entry('private', blob)]);
	const raw = await store.tree([entry('unknown', blob)]);
	const root = await store.tree([
		entry('.git', hidden, '40000'),
		entry('.GIT', hidden, '40000'),
		entry('.Git', blob),
		entry(new Uint8Array([255]), raw, '40000'),
		entry('visible', blob),
	]);
	const snapshot = await readSnapshot(root, store.read);
	expect([...snapshot.files.keys()]).toEqual(['visible']);
	expect(store.reads).toContain(hidden);
	expect(store.reads).toContain(raw);
});

test('reads shared subtrees at both paths without rereading their object', async () => {
	const store = createObjects();
	const blob = await store.add('blob', 'same');
	const shared = await store.tree([entry('file', blob)]);
	const root = await store.tree([
		entry('a', shared, '40000'),
		entry('b', shared, '40000'),
	]);
	const snapshot = await readSnapshot(root, store.read);
	expect([...snapshot.files.keys()]).toEqual(['a/file', 'b/file']);
	expect(store.reads.filter((oid) => oid === shared)).toHaveLength(1);
});

test('changes rebuild only affected trees and retain raw names, modes and untouched subtrees', async () => {
	const store = createObjects();
	const old = await store.add('blob', 'old');
	const sibling = await store.tree([entry('untouched', old)]);
	const nested = await store.tree([
		entry('run', old, '100755'),
		entry('link', old, '120000'),
		entry('vendor', '1'.repeat(40), '160000'),
		entry(new Uint8Array([255, 254]), old),
	]);
	const root = await store.tree([
		entry('docs', nested, '40000'),
		entry('sibling', sibling, '40000'),
		entry(new Uint8Array([192]), old),
	]);
	const result = await changeSnapshot({
		root,
		edits: new Map([
			['docs/run', 'new'],
			['docs/new.txt', 'added'],
		]),
		read: store.read,
	});
	expect(store.reads).toEqual([root, nested]);
	expect(result.objects.size).toBe(4);
	expect(result.objects.has(old)).toBe(false);
	const newRoot = readTree(result.objects.get(result.tree)!.bytes);
	expect(
		newRoot.find((item) => decoder.decode(item.name) === 'sibling')?.oid,
	).toBe(sibling);
	expect(newRoot.find((item) => item.name[0] === 192)?.oid).toBe(old);
	const docs = newRoot.find((item) => decoder.decode(item.name) === 'docs')!;
	const newDocs = readTree(result.objects.get(docs.oid)!.bytes);
	expect(
		newDocs.find((item) => decoder.decode(item.name) === 'run')?.mode,
	).toBe('100755');
	expect(newDocs.find((item) => decoder.decode(item.name) === 'link')).toEqual(
		entry('link', old, '120000'),
	);
	expect(
		newDocs.find((item) => decoder.decode(item.name) === 'vendor'),
	).toEqual(entry('vendor', '1'.repeat(40), '160000'));
	expect(newDocs.find((item) => item.name[0] === 255)).toEqual(
		entry(new Uint8Array([255, 254]), old),
	);
});

test('unchanged writes and missing deletions return the original root with no new objects', async () => {
	const store = createObjects();
	const blob = await store.add('blob', 'same');
	const empty = await store.tree([]);
	const root = await store.tree([
		entry('file', blob),
		entry('empty', empty, '40000'),
	]);
	const result = await changeSnapshot({
		root,
		edits: new Map([
			['file', 'same'],
			['missing', null],
			['empty/missing', null],
			['file/missing', null],
		]),
		read: store.read,
	});
	expect(result.tree).toBe(root);
	expect(result.objects.size).toBe(0);
});

test('new descendants replace ancestor files, and new files replace descendant trees', async () => {
	const store = createObjects();
	const old = await store.add('blob', 'old');
	const nested = await store.tree([entry('old.txt', old)]);
	const root = await store.tree([
		entry('file', old),
		entry('folder', nested, '40000'),
	]);
	const result = await changeSnapshot({
		root,
		edits: new Map([
			['file/child.txt', 'child'],
			['folder', 'flat'],
		]),
		read: store.read,
	});
	for (const [oid, object] of result.objects) store.objects.set(oid, object);
	const snapshot = await readSnapshot(result.tree, store.read);
	expect([...snapshot.files.keys()]).toEqual(['file/child.txt', 'folder']);
	expect(store.objects.get(snapshot.files.get('folder')!.oid)?.bytes).toEqual(
		encoder.encode('flat'),
	);
});

test('overwriting symlinks and gitlinks creates ordinary files', async () => {
	const store = createObjects();
	const blob = await store.add('blob', 'target');
	const root = await store.tree([
		entry('link', blob, '120000'),
		entry('sub', '1'.repeat(40), '160000'),
	]);
	const result = await changeSnapshot({
		root,
		edits: new Map([
			['link', 'replacement'],
			['sub', 'replacement'],
		]),
		read: store.read,
	});
	expect(
		readTree(result.objects.get(result.tree)!.bytes).map((item) => item.mode),
	).toEqual(['100644', '100644']);
});

test('deleting a final child prunes its tree while null ancestor plus a new child replaces old descendants', async () => {
	const store = createObjects();
	const blob = await store.add('blob', 'old');
	const nested = await store.tree([entry('old', blob)]);
	const root = await store.tree([
		entry('remove', nested, '40000'),
		entry('replace', nested, '40000'),
	]);
	const result = await changeSnapshot({
		root,
		edits: new Map([
			['remove/old', null],
			['replace', null],
			['replace/new', 'new'],
		]),
		read: store.read,
	});
	for (const [oid, object] of result.objects) store.objects.set(oid, object);
	const snapshot = await readSnapshot(result.tree, store.read);
	expect([...snapshot.files.keys()]).toEqual(['replace/new']);
});

test('a fresh or completely deleted snapshot produces the native empty tree', async () => {
	const store = createObjects();
	const empty = await changeSnapshot({
		root: null,
		edits: new Map(),
		read: store.read,
	});
	expect(empty.tree).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
	expect(empty.objects.get(empty.tree)).toEqual({
		type: 'tree',
		bytes: new Uint8Array(),
	});
	const blob = await store.add('blob', 'old');
	const root = await store.tree([entry('file', blob)]);
	const deleted = await changeSnapshot({
		root,
		edits: new Map([['file', null]]),
		read: store.read,
	});
	expect(deleted.tree).toBe(empty.tree);
	expect(deleted.objects.size).toBe(1);
});

test('conflicting non-null ancestor and descendant edits fail independently of insertion order', async () => {
	const store = createObjects();
	for (const edits of [
		new Map([
			['a', 'file'],
			['a/b', 'nested'],
		]),
		new Map([
			['a/b', 'nested'],
			['a', 'file'],
		]),
	])
		await expect(
			changeSnapshot({ root: null, edits, read: store.read }),
		).rejects.toThrow('Conflicting snapshot edits');
});

test('storage read failures propagate with their original identity', async () => {
	const store = createObjects();
	const root = await store.tree([]);

	const failure = new Error('storage boundary failure');
	const fail = async () => {
		throw failure;
	};
	await expect(readSnapshot(root, fail)).rejects.toBe(failure);

	await expect(
		changeSnapshot({ root, edits: new Map(), read: fail }),
	).rejects.toBe(failure);
});

test('missing, wrong-type and malformed internal objects identify the failed object', async () => {
	const store = createObjects();
	const missing = '1'.repeat(40);
	await expect(readSnapshot(missing, store.read)).rejects.toThrow(
		`Missing object ${missing}`,
	);
	const blob = await store.add('blob', 'text');
	await expect(readSnapshot(blob, store.read)).rejects.toThrow(
		`Expected tree object ${blob}, found blob`,
	);
	const malformed = await store.add('tree', new Uint8Array([52, 48, 48]));
	await expect(
		changeSnapshot({ root: malformed, edits: new Map(), read: store.read }),
	).rejects.toThrow(`Malformed tree object ${malformed}`);
	const slash = await store.tree([entry('a/b', blob)]);
	await expect(
		changeSnapshot({ root: slash, edits: new Map(), read: store.read }),
	).rejects.toThrow('invalid entry name');
	const duplicate = await store.tree([entry('a', blob), entry('a', blob)]);
	await expect(
		changeSnapshot({ root: duplicate, edits: new Map(), read: store.read }),
	).rejects.toThrow('duplicate entry name');
});

test('native Git accepts the changed nested tree including raw unknown names', async () => {
	const store = createObjects();
	const blob = await store.add('blob', 'old\n');
	const nested = await store.tree([
		entry('run', blob, '100755'),
		entry('link', blob, '120000'),
		entry(new Uint8Array([255, 254]), blob),
	]);
	const root = await store.tree([
		entry('docs', nested, '40000'),
		entry('submodule', '1'.repeat(40), '160000'),
	]);
	const changed = await changeSnapshot({
		root,
		edits: new Map([
			['docs/run', 'new\n'],
			['new/deep/file.txt', 'hello\n'],
		]),
		read: store.read,
	});
	for (const [oid, object] of changed.objects) store.objects.set(oid, object);
	const commit = await store.add(
		'commit',
		writeCommit({
			tree: changed.tree,
			parents: [],
			author: { name: 'Test', email: 'test@example.com', timestamp: 1 },
			message: 'Native fixture\n',
		}),
	);
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-snapshot-native-'));
	try {
		const git = (args: string[], stdin?: Uint8Array) => {
			const result = Bun.spawnSync(['git', ...args], {
				cwd: dir,
				env: {
					PATH: process.env.PATH ?? '',
					HOME: dir,
					GIT_CONFIG_GLOBAL: '/dev/null',
					GIT_CONFIG_NOSYSTEM: '1',
				},
				stdin,
			});
			if (result.exitCode !== 0) throw new Error(decoder.decode(result.stderr));
			return decoder.decode(result.stdout).trimEnd();
		};
		git(['init', '--quiet']);
		for (const [oid, object] of store.objects)
			expect(
				git(['hash-object', '-w', '-t', object.type, '--stdin'], object.bytes),
			).toBe(oid);
		expect(git(['ls-tree', '-r', '--name-only', changed.tree])).toContain(
			'new/deep/file.txt',
		);
		expect(git(['cat-file', '-p', `${commit}:docs/run`])).toBe('new');
		expect(git(['fsck', '--strict', '--no-dangling'])).toBe('');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
