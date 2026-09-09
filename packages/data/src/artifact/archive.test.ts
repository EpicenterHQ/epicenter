/**
 * Structural archive fidelity and fresh-lineage reconstruction against pinned Yjs 14.
 * Archives capture authority snapshot plus tail, preserve unknown values and rich
 * content, require referenced blob bytes, and refuse incomplete or altered inputs.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	BlobStoreError,
	generateBlobId,
	type BlobStore,
} from '@epicenter/blobs';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openCurrentAuthority } from '../sync/authority.js';
import { captureArchive, prepareArchive } from './archive.js';

function setup() {
	const database = new Database(':memory:');
	const authority = openCurrentAuthority({
		sqlite: createBunSqliteAdapter(database),
	});
	const doc = new Y.Doc();
	const id = generateBlobId();
	const row = new Y.Type();
	const content = new Y.Type('section');
	doc.get('tables:unknown').setAttr('row-1', row);
	row.setAttr('content', content);
	row.setAttr('unknown-value', {
		nested: [null, true, 'value'],
		absent: undefined,
		binary: new Uint8Array([0, 255]),
	});
	row.setAttr('audio', id);
	row.setAttr('!future', 42);
	content.setAttr('id', 'content-1');
	content.insert(0, 'hello ', { bold: true });
	const nested = new Y.Type('link');
	content.insert(6, [nested]);
	nested.setAttr('href', `https://example.invalid/blobs/${id}?download=1`);
	nested.insert(0, 'linked', { italic: true, color: 'red' });
	content.insert(7, [{ embed: 'image', src: `/blobs/${id}` }]);
	doc
		.get('kv')
		.setAttr('undeclared-setting', { mode: 'unknown', flag: undefined });
	doc.get('future-root').setAttr('binary', new Uint8Array([8, 9]));
	doc.get('future-root').setAttr('numbers', {
		nan: NaN,
		positive: Infinity,
		negative: -Infinity,
		negativeZero: -0,
		bigint: 42n,
	});
	authority.ensureCurrent(Y.encodeStateAsUpdateV2(doc));
	let previous = Y.encodeStateVector(doc);
	content.insert(8, ' tail', { underline: true });
	expectOk(authority.bind(1).append(Y.encodeStateAsUpdateV2(doc, previous)));
	previous = Y.encodeStateVector(doc);
	doc.get('kv').setAttr('last-tail-setting', 'included');
	expectOk(authority.bind(1).append(Y.encodeStateAsUpdateV2(doc, previous)));
	const blobs: Pick<BlobStore, 'get'> = {
		async get(requested) {
			return requested === id
				? Ok(new Blob(['audio bytes'], { type: 'audio/wav' }))
				: BlobStoreError.BlobNotFound({ id: requested });
		},
	};
	return {
		authority,
		doc,
		id,
		blobs,
		close() {
			doc.destroy();
			database.close();
		},
	};
}

function view(doc: Y.Doc) {
	return [...doc.share]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => [
			key,
			value.toDelta({ deep: true, renderer: null }).toJSON(),
		]);
}

test('archive preserves captured tail, named rich content, unknown roots and fields, settings, binary, undefined and blobs', async () => {
	const s = setup();
	try {
		const capture = s.authority.capture();
		const archive = expectOk(await captureArchive(capture, s.blobs));
		const restored = expectOk(await prepareArchive(archive));
		const doc = new Y.Doc();
		try {
			Y.applyUpdateV2(doc, restored.bytes);
			expect(view(doc)).toEqual(view(s.doc));
			expect(restored.source).toEqual({
				generation: capture.generation,
				head: capture.head,
			});
			expect(restored.blobs.map((entry) => entry.id)).toEqual([s.id]);
			expect(await restored.blobs[0]!.blob.text()).toBe('audio bytes');
			expect(restored.blobs[0]!.blob.type).toBe('audio/wav');
			expect([...doc.store.clients.keys()]).not.toContain(s.doc.clientID);
		} finally {
			doc.destroy();
		}
	} finally {
		s.close();
	}
});

test('ten archive activations preserve values with one new writer and no preceding lineage', async () => {
	const s = setup();
	try {
		const priorWriters = new Set([s.doc.clientID]);
		const expected = view(s.doc);
		for (let index = 0; index < 10; index++) {
			const archived = expectOk(
				await captureArchive(s.authority.capture(), s.blobs),
			);
			const restored = expectOk(await prepareArchive(archived));
			const activation = await s.authority.prepareActivation({
				operation: `restore-${index}`,
				expected: restored.source,
				bytes: restored.bytes,
			});
			expect(activation.activate().status).toBe('activated');
			const replayed = new Y.Doc();
			try {
				Y.applyUpdateV2(replayed, s.authority.capture().snapshot.bytes);
				expect(view(replayed)).toEqual(expected);
				const writers = [...replayed.store.clients.keys()];
				expect(writers).toHaveLength(1);
				expect(priorWriters.has(writers[0]!)).toBe(false);
				priorWriters.add(writers[0]!);
				expect(replayed.store.pendingDs).toBeNull();
				expect(replayed.store.pendingStructs).toBeNull();
			} finally {
				replayed.destroy();
			}
		}
		expect(s.authority.capture().generation).toBe(11);
	} finally {
		s.close();
	}
});

test('a missing referenced blob refuses the backup while retaining current generation and head', async () => {
	const s = setup();
	try {
		const before = s.authority.capture();
		const missing: Pick<BlobStore, 'get'> = {
			async get(id) {
				return BlobStoreError.BlobNotFound({ id });
			},
		};
		const error = expectErr(await captureArchive(before, missing));
		expect(error.name).toBe('BlobNotFound');
		expect(s.authority.capture()).toEqual(before);
	} finally {
		s.close();
	}
});

test('capture snapshots all source values before asynchronous blob acquisition', async () => {
	const s = setup();
	try {
		const capture = s.authority.capture();
		const expected = { generation: capture.generation, head: capture.head };
		let resume!: () => void;
		const wait = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const saving = captureArchive(capture, {
			async get(id) {
				await wait;
				return await s.blobs.get(id);
			},
		});
		capture.generation = 123;
		capture.head = 456;
		capture.snapshot.bytes.fill(0);
		for (const entry of capture.tail) entry.bytes.fill(0);
		resume();
		const restored = expectOk(await prepareArchive(expectOk(await saving)));
		expect(restored.source).toEqual(expected);
		const replayed = new Y.Doc();
		try {
			Y.applyUpdateV2(replayed, restored.bytes);
			expect(view(replayed)).toEqual(view(s.doc));
		} finally {
			replayed.destroy();
		}
	} finally {
		s.close();
	}
});

test('capture refuses missing, duplicated, reordered, or over-head tail entries', async () => {
	const s = setup();
	try {
		const good = s.authority.capture();
		for (const tail of [
			good.tail.slice(1),
			[...good.tail, good.tail[0]!],
			[...good.tail].reverse(),
			[...good.tail, { seq: good.head + 1, bytes: good.snapshot.bytes }],
		]) {
			expect(
				expectErr(await captureArchive({ ...good, tail }, s.blobs)).name,
			).toBe('InvalidArchive');
		}
	} finally {
		s.close();
	}
});

test('capture refuses unresolved struct dependencies and unresolved delete dependencies', async () => {
	const source = new Y.Doc();
	const empty = new Y.Doc();
	try {
		const row = source.get('root');
		row.insert(0, 'a');
		const before = Y.encodeStateVector(source);
		row.insert(1, 'b');
		const incremental = Y.encodeStateAsUpdateV2(source, before);
		row.delete(0, 2);
		const deleted = Y.encodeStateAsUpdateV2(
			source,
			Y.encodeStateVector(source),
		);
		for (const bytes of [incremental, deleted]) {
			const result = await captureArchive(
				{
					generation: 1,
					head: 2,
					snapshot: { position: 1, bytes: Y.encodeStateAsUpdateV2(empty) },
					tail: [{ seq: 2, bytes }],
				},
				{
					async get() {
						throw new Error('No blob read is permitted for incomplete capture');
					},
				},
			);
			expect(expectErr(result).message).toContain(
				'unresolved Yjs dependencies',
			);
		}
	} finally {
		source.destroy();
		empty.destroy();
	}
});

async function rewrite(
	bytes: Uint8Array,
	change: (archive: {
		version: number;
		body: { roots: unknown[]; blobs: unknown[] };
		digest: string;
	}) => void,
	resign = false,
) {
	const archive = JSON.parse(new TextDecoder().decode(bytes)) as {
		version: number;
		body: { roots: unknown[]; blobs: unknown[] };
		digest: string;
	};
	change(archive);
	if (resign) {
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(JSON.stringify(archive.body)),
		);
		archive.digest = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('');
	}
	return new TextEncoder().encode(JSON.stringify(archive));
}

test('unsupported versions, changed archive bytes, and structurally incomplete blob manifests refuse preparation', async () => {
	const s = setup();
	try {
		const bytes = expectOk(
			await captureArchive(s.authority.capture(), s.blobs),
		);
		const unsupported = await rewrite(bytes, (archive) => {
			archive.version = 2;
		});
		expect(expectErr(await prepareArchive(unsupported)).message).toContain(
			'Unsupported archive format or version',
		);
		const changed = await rewrite(bytes, (archive) => {
			archive.body.blobs = [];
		});
		expect(expectErr(await prepareArchive(changed)).message).toContain(
			'integrity',
		);
		const missing = await rewrite(
			bytes,
			(archive) => {
				archive.body.blobs = [];
			},
			true,
		);
		expect(expectErr(await prepareArchive(missing)).message).toContain(
			'missing referenced blobs',
		);
		const duplicate = await rewrite(
			bytes,
			(archive) => {
				archive.body.blobs.push(archive.body.blobs[0]);
			},
			true,
		);
		expect(expectErr(await prepareArchive(duplicate)).message).toContain(
			'duplicate archived blob',
		);
	} finally {
		s.close();
	}
});

test('preparation reads archive input before its first await and refuses unknown nested fields', async () => {
	const s = setup();
	try {
		const bytes = expectOk(
			await captureArchive(s.authority.capture(), s.blobs),
		);
		const preparing = prepareArchive(bytes);
		bytes.fill(0);
		expect(expectOk(await preparing).blobs).toHaveLength(1);
		const valid = expectOk(
			await captureArchive(s.authority.capture(), s.blobs),
		);
		const unknown = await rewrite(
			valid,
			(archive) => {
				const root = archive.body.roots[0] as [string, Record<string, unknown>];
				root[1].future = 'must not disappear';
			},
			true,
		);
		expect(expectErr(await prepareArchive(unknown)).message).toContain(
			'Unsupported archive fields',
		);
	} finally {
		s.close();
	}
});

test('subdocuments refuse capture instead of silently dropping their content', async () => {
	const root = new Y.Doc();
	const child = new Y.Doc();
	try {
		root.get('root').setAttr('child', child);
		const bytes = Y.encodeStateAsUpdateV2(root);
		const result = await captureArchive(
			{ generation: 1, head: 1, snapshot: { position: 1, bytes }, tail: [] },
			{
				async get() {
					throw new Error('No blobs should be read');
				},
			},
		);
		expect(expectErr(result).message).toContain('Subdocuments');
	} finally {
		root.destroy();
		child.destroy();
	}
});

test('a blob named only inside an undeclared rich-content URL is included', async () => {
	const s = setup();
	try {
		const previous = Y.encodeStateVector(s.doc);
		const row = s.doc.get('tables:unknown').getAttr('row-1') as Y.Type;
		row.deleteAttr('audio');
		expectOk(
			s.authority.bind(1).append(Y.encodeStateAsUpdateV2(s.doc, previous)),
		);
		const restored = expectOk(
			await prepareArchive(
				expectOk(await captureArchive(s.authority.capture(), s.blobs)),
			),
		);
		expect(restored.blobs.map((blob) => blob.id)).toEqual([s.id]);
	} finally {
		s.close();
	}
});

test('an accepted write during blob capture makes the prepared archive activation stale', async () => {
	const s = setup();
	try {
		let resume!: () => void;
		const wait = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const saving = captureArchive(s.authority.capture(), {
			async get(id) {
				await wait;
				return await s.blobs.get(id);
			},
		});
		const previous = Y.encodeStateVector(s.doc);
		s.doc.get('kv').setAttr('after-backup-start', 'preserved by refusal');
		expectOk(
			s.authority.bind(1).append(Y.encodeStateAsUpdateV2(s.doc, previous)),
		);
		resume();
		const prepared = expectOk(await prepareArchive(expectOk(await saving)));
		const before = s.authority.capture();
		const activation = await s.authority.prepareActivation({
			operation: 'stale-archive',
			expected: prepared.source,
			bytes: prepared.bytes,
		});
		expect(activation.activate()).toEqual({ status: 'conflict' });
		expect(s.authority.capture()).toEqual(before);
	} finally {
		s.close();
	}
});

test('a BlobId split across text formatting requires its bytes during capture and preparation', async () => {
	const doc = new Y.Doc();
	try {
		const id = generateBlobId();
		const text = doc.get('unknown-text-root');
		text.insert(0, id.slice(0, 10), { bold: true });
		text.insert(10, id.slice(10));
		const capture = {
			generation: 1,
			head: 1,
			snapshot: { position: 1, bytes: Y.encodeStateAsUpdateV2(doc) },
			tail: [],
		};
		const missing = await captureArchive(capture, {
			async get(requested) {
				return BlobStoreError.BlobNotFound({ id: requested });
			},
		});
		expect(expectErr(missing).name).toBe('BlobNotFound');
		const reads: string[] = [];
		const archive = expectOk(
			await captureArchive(capture, {
				async get(requested) {
					reads.push(requested);
					return Ok(new Blob(['split reference']));
				},
			}),
		);
		expect(reads).toEqual([id]);
		expect(
			expectOk(await prepareArchive(archive)).blobs.map((blob) => blob.id),
		).toEqual([id]);
		const incomplete = await rewrite(
			archive,
			(value) => {
				value.body.blobs = [];
			},
			true,
		);
		expect(expectErr(await prepareArchive(incomplete)).message).toContain(
			'missing referenced blobs',
		);
	} finally {
		doc.destroy();
	}
});

test('embedded content interrupts BlobId text matching', async () => {
	const doc = new Y.Doc();
	try {
		const id = generateBlobId();
		const text = doc.get('unknown-text-root');
		text.insert(0, id.slice(0, 10), { bold: true });
		text.insert(10, [{ divider: true }]);
		text.insert(11, id.slice(10));
		const archive = expectOk(
			await captureArchive(
				{
					generation: 1,
					head: 1,
					snapshot: { position: 1, bytes: Y.encodeStateAsUpdateV2(doc) },
					tail: [],
				},
				{
					async get(requested) {
						return BlobStoreError.BlobNotFound({ id: requested });
					},
				},
			),
		);
		expect(expectOk(await prepareArchive(archive)).blobs).toEqual([]);
	} finally {
		doc.destroy();
	}
});
