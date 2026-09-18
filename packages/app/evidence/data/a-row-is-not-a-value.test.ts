/**
 * A row is a read, not a value. Pinned, because nothing in the type says so.
 *
 * `get` hands back a plain object literal, and plain objects are comparable,
 * cloneable and serializable. This one is not: the content node on it IS the
 * container in the document (ADR-0296, amended), so the object is half snapshot
 * and half handle. TypeScript cannot express "do not clone me", so the contract
 * lives here instead of in a signature.
 *
 * This was found rather than designed. `readArtifact`'s round trip compared
 * `restored.tables.notes.rows` with `data.tables.notes.rows` and started failing
 * the moment rows carried their types, because two documents' `Y.Type`s carry
 * different client ids. The fix was to compare the faithful read, which is what
 * that assertion should always have used: "imports back whole" is a claim about
 * the record, not about the lens.
 *
 * So: **when you need a value, ask the store, not the table.** `store.stored()`
 * for everything and `store.rowFile(table, id)` for one row both answer in
 * plain JSON, and both are faithful where the lens narrows.
 */
import { describe, expect, test } from 'bun:test';
import { defineApp } from '@epicenter/app';
import {
	defineTable,
	field,
	plainText,
} from '../../src/data/definition/index.js';
import { openMemory } from '../../src/data/store/memory.js';
import { syncEngineOf } from '../../src/data/store/store.js';

const database = defineApp({
	id: 'so.epicenter.rowvalue',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			content: plainText(),
		}),
	},
});

/** Two stores holding byte-identical state, the way a synced pair does. */
async function convergedPair() {
	const phone = await openMemory(database);
	const made = phone.tables.notes.create({ title: 'Groceries' });
	const content = phone.tables.notes.get(made.id)?.content;
	content?.insert(0, ['buy milk']);

	const laptop = await openMemory(database);
	syncEngineOf(laptop).applyRemote(phone.encodeStateSince());
	return { phone, laptop, id: made.id };
}

describe('a row is a read, not a value', () => {
	test('two converged stores do NOT produce equal rows', async () => {
		const { phone, laptop, id } = await convergedPair();
		// Same content, both directions of sync settled. The rows still differ,
		// because each `content` is a live container with its own client id. This is
		// not a bug to fix; it is what carrying a handle means.
		expect(laptop.tables.notes.get(id)).not.toEqual(
			phone.tables.notes.get(id) as never,
		);
	});

	test('the faithful read IS the comparison surface', async () => {
		const { phone, laptop } = await convergedPair();
		// The same two stores, compared where a value lives. This is the assertion
		// an "imports back whole" or "converged" test wants.
		expect(laptop.stored().tables).toEqual(phone.stored().tables);
	});

	test('a value is a snapshot and the content node is not', async () => {
		const { phone, id } = await convergedPair();
		const held = phone.tables.notes.get(id);

		phone.tables.notes.update(id, { title: 'Errands' });
		held?.content.insert(0, ['and eggs, ']);

		// The value was copied out when it was read, so the held row still says
		// what it said. The content node is the container itself, so the edit is
		// visible through the same object.
		expect(held?.title).toBe('Groceries');
		expect(phone.tables.notes.get(id)?.title).toBe('Errands');
		expect(held?.content.toString()).toContain('and eggs');
	});

	test('rowFile answers in plain JSON, for one row', async () => {
		const { phone, id } = await convergedPair();
		const row = phone.rowFile('notes', id);
		if (row === undefined) throw new Error('the row is gone');
		// Faithful and untyped: every stored value, and the live content node beside
		// them for a codec. The values alone are what a value comparison wants.
		const { content: _content, ...fields } = row;
		expect(fields).toEqual({ id, title: 'Groceries' });
	});
});
