import {
	ContentError,
	defineStore,
	defineTable,
	field,
	plainText,
} from '@epicenter/app';
/**
 * The artifact read back, and the round trip that is the whole promise: what a
 * person exports is what they get when they import it again (ADR-0267/0268).
 *
 * The round trip is proven end to end rather than by inspecting bytes: export a
 * live store, read the files back into one document's state, apply that state
 * to a fresh store, and compare what the two stores hold. A frontmatter emitter
 * that retyped a value or a codec that lost a content shows up here as a
 * difference between two stores, which is the failure a person would
 * actually suffer.
 */

import { describe, expect, test } from 'bun:test';

import * as Y from '@y/y';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createMemoryRecord, openMemory } from '../store/memory.js';
import { syncEngineOf } from '../store/store.js';
import { readArtifact } from './import.js';
import { type RenderedRow, renderArtifact } from './render.js';

const store = defineStore({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.string() },
	tables: {
		folders: defineTable({
			name: field.string(),
			content: plainText(),
		}),
		notes: defineTable({
			title: field.string(),
			code: field.string(),
			flag: field.string(),
			pinned: field.boolean(),
			count: field.number(),
			tags: field.tags(),
			folderId: field.nullable(field.string()),
			// The faithful codec: everything the store holds goes above the fence
			// and comes back off it, so a key an older release wrote survives the
			// round trip. The `id` is the path, not a field.
			content: plainText(),
		}),
	},
});

/** A store with one of everything the artifact has to carry. */
async function seeded() {
	const data = await openMemory(store);
	data.kv.update({ theme: 'dark' });
	const folder = data.tables.folders.create({ name: 'Inbox' });
	const note = data.tables.notes.create({
		// Values chosen for the ways YAML retypes things when nobody quotes:
		// a numeric-looking string, a boolean-looking one, and a date.
		title: '007',
		// The two that a bare emitter would hand back as a number and a boolean.
		code: '123',
		flag: 'true',
		pinned: false,
		count: 3,
		tags: ['no', '2024-03-05'],
		folderId: folder.id,
	});
	const content = data.tables.notes.get(note.id);
	if (content === undefined) throw new Error('the row has no content');
	content.content.insert(0, ['buy milk\n\n---\nnot a fence']);
	return { data, folder, note };
}

/** Collect the stream into a map, which is what an assertion wants. */
async function collect(
	stream: AsyncIterable<{ data: RenderedRow | null; error: unknown }>,
): Promise<ReadonlyMap<string, string>> {
	const files = new Map<string, string>();
	for await (const rendered of stream) {
		if (rendered.error !== null) throw rendered.error;
		const { path, contents } = rendered.data as RenderedRow;
		if (contents !== undefined) files.set(path, contents);
	}
	return files;
}

describe('readArtifact (ADR-0267/0268)', () => {
	test('an exported store imports back into an identical one', async () => {
		const { data, note } = await seeded();
		const exported = await collect(renderArtifact(data, store));

		const state = expectOk(readArtifact(exported, store));
		await using restored = await openMemory(store);
		expect(syncEngineOf(restored).applyRemote(state).error).toBeNull();

		// Every value, at the same id, read through the same lens.
		expect(restored.tables.notes.rows).toHaveLength(1);
		expect(restored.tables.folders.rows).toHaveLength(1);
		expect(restored.kv.get('theme')).toBe('dark');
		expect(restored.stored().kv).toEqual(data.stored().kv);
		// Compared through `stored()` rather than `rows`, and the reason is the
		// claim itself. A row carries its live content node now, and two documents'
		// nodes are never equal: they are different objects with different client
		// ids. "Imports back whole" is a statement about the RECORD, so the
		// faithful read is what it should have been asserted against all along.
		expect(restored.stored().tables).toEqual(data.stored().tables);

		// And the body text, through the codec, `---` fence and all.
		expect(restored.tables.notes.get(note.id)?.content.toString()).toBe(
			'buy milk\n\n---\nnot a fence',
		);
		await data[Symbol.asyncDispose]();
	});

	test('a value keeps its type, so a string that looks like a number stays one', async () => {
		const { data, note } = await seeded();
		const exported = await collect(renderArtifact(data, store));
		const state = expectOk(readArtifact(exported, store));
		await using restored = await openMemory(store);
		syncEngineOf(restored).applyRemote(state);

		const row = restored.tables.notes.get(note.id);
		expect(row?.title).toBe('007');
		expect(row?.code).toBe('123');
		expect(row?.flag).toBe('true');
		expect(row?.pinned).toBe(false);
		expect(row?.count).toBe(3);
		expect(row?.tags).toEqual(['no', '2024-03-05']);
		await data[Symbol.asyncDispose]();
	});

	test('a row the declaration no longer names survives the round trip', async () => {
		// The export carries it (the artifact is not read through the lens), so
		// the import has to put it back, or a release upgrade plus an export and
		// an import would quietly delete it.
		const record = createMemoryRecord();
		const withLegacy = await openMemory(store, record);
		const made = withLegacy.tables.notes.create({
			title: 'Groceries',
			code: '1',
			flag: 'no',
			pinned: false,
			count: 0,
			tags: [],
			folderId: null,
		});
		withLegacy.tables.notes.update(made.id, { legacy: 'kept' } as never);
		const exported = await collect(renderArtifact(withLegacy, store));
		await withLegacy[Symbol.asyncDispose]();

		const state = expectOk(readArtifact(exported, store));
		await using restored = await openMemory(store);
		syncEngineOf(restored).applyRemote(state);
		expect(restored.stored().tables.get('notes')?.get(made.id)).toEqual({
			title: 'Groceries',
			code: '1',
			flag: 'no',
			pinned: false,
			count: 0,
			tags: [],
			folderId: null,
			legacy: 'kept',
		});
		record.close();
	});

	test('a hand-typed value that was never quoted reads as the string it looks like', async () => {
		const files = new Map([
			['notes/aaaaaaaaaaaaaaaaaaaaaaaa.md', '---\ntitle: Groceries\n---\n'],
		]);
		const state = expectOk(readArtifact(files, store));
		const restored = await openMemory(store);
		syncEngineOf(restored).applyRemote(state);
		expect(
			restored.stored().tables.get('notes')?.get('aaaaaaaaaaaaaaaaaaaaaaaa'),
		).toEqual({ title: 'Groceries' });
		void restored[Symbol.asyncDispose]();
	});

	test('a file that is not a row file refuses the whole import', async () => {
		const files = new Map([['notes/aaaa.md', 'no frontmatter here']]);
		const refused = expectErr(readArtifact(files, store));
		expect(refused.name).toBe('MalformedFile');
	});

	test('a codec that throws on a body refuses the whole import', async () => {
		const breaking = defineStore({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				notes: defineTable({
					title: field.string(),
					content: {
						encode: (node) => node.toString(),
						decode: () => {
							throw new Error('the codec exploded');
						},
						rewrite: () => Ok(undefined),
					},
				}),
			},
		});
		const files = new Map([
			['notes/aaaa.md', '---\ntitle: "x"\n---\n\nprose\n'],
		]);
		const refused = expectErr(readArtifact(files, breaking));
		expect(refused.name).toBe('RowUnreadable');
	});

	test('a codec that refuses a file refuses the whole import', async () => {
		// The codec's error arm is a Result, not a throw: a folder a person
		// hands to an import is data, and the file it could not read is named.
		const refusing = defineStore({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				notes: defineTable({
					title: field.string(),
					content: {
						encode: (node) => node.toString(),
						decode: () => ContentError.Unreadable({ reason: 'no title line' }),
						rewrite: () => Ok(undefined),
					},
				}),
			},
		});
		const files = new Map([
			['notes/aaaa.md', '---\ntitle: "x"\n---\n\nprose\n'],
		]);
		const refused = expectErr(readArtifact(files, refusing));
		expect(refused.name).toBe('RowUnreadable');
		expect(refused.message).toContain('no title line');
	});

	test('a codec that hands one node to two rows is refused', async () => {
		// Two rows given one node hold the SAME content, and an edit to either
		// shows up in both. Measured on `@y/y@14.0.0-rc.24`: setting one node at
		// two keys leaves both keys holding the same instance, silently.
		// `createRow` refuses a node that already belongs to a document, which is
		// what makes that unrepresentable rather than a bug somebody finds later.
		const shared = new Y.Type();
		const sharing = defineStore({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				notes: defineTable({
					title: field.string(),
					// Hands back ONE node for every row, which is the mistake.
					content: {
						encode: (node) => node.toString(),
						decode: () => Ok(shared),
						rewrite: () => Ok(undefined),
					},
				}),
			},
		});
		const files = new Map([
			['notes/aaaa.md', '---\ntitle: "x"\n---\n\nfirst\n'],
			['notes/bbbb.md', '---\ntitle: "y"\n---\n\nsecond\n'],
		]);
		const refused = expectErr(readArtifact(files, sharing));
		expect(refused.message).toContain('already belongs to a document');
	});

	test('a file that is not part of the artifact is left alone', async () => {
		const files = new Map([
			['.DS_Store', 'binary junk'],
			['README.md', '# not a row'],
			['notes/aaaaaaaaaaaaaaaaaaaaaaaa.md', '---\ntitle: "kept"\n---\n'],
		]);
		const state = expectOk(readArtifact(files, store));
		const restored = await openMemory(store);
		syncEngineOf(restored).applyRemote(state);
		expect([...(restored.stored().tables.get('notes')?.keys() ?? [])]).toEqual([
			'aaaaaaaaaaaaaaaaaaaaaaaa',
		]);
		void restored[Symbol.asyncDispose]();
	});
});
