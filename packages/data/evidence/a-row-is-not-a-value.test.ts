/**
 * A row is a read, not a value. Pinned, because nothing in the type says so.
 *
 * `get` hands back a plain object literal, and plain objects are comparable,
 * cloneable and serializable. This one is not: a type field on it IS the
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
 * gives faithful plain data. `store.rowFile(table, id)` gives faithful scalars
 * alongside live types for the artifact codec.
 */
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import { defineData, defineTable, field } from '../src/definition/index.js';
import { openMemory } from '../src/store/memory.js';
import { syncEngineOf } from '../src/store/store.js';

const database = defineData({
	id: 'so.epicenter.rowvalue',
	kv: {},
	tables: {
		notes: defineTable({
			scalars: { title: field.string() },
			types: ['body'],
			file: {
				serialize: ({ id: _id, body, ...rest }) => ({
					data: rest,
					content: String(body),
				}),
				deserialize: (file) => ({ ...file.data, body: new Y.Type() }) as never,
			},
		}),
	},
});

/** Two stores holding byte-identical state, the way a synced pair does. */
async function convergedPair() {
	const phone = await openMemory(database);
	const made = phone.tables.notes.create({ title: 'Groceries' });
	const body = phone.tables.notes.get(made.id)?.body;
	body?.insert(0, ['buy milk']);

	const laptop = await openMemory(database);
	syncEngineOf(laptop.store).applyRemote(phone.store.encodeStateSince());
	return { phone, laptop, id: made.id };
}

describe('a row is a read, not a value', () => {
	test('two converged stores do NOT produce equal rows', async () => {
		const { phone, laptop, id } = await convergedPair();
		// Same content, both directions of sync settled. The rows still differ,
		// because each `body` is a live container with its own client id. This is
		// not a bug to fix; it is what carrying a handle means.
		expect(laptop.tables.notes.get(id)).not.toEqual(
			phone.tables.notes.get(id) as never,
		);
	});

	test('the faithful read IS the comparison surface', async () => {
		const { phone, laptop } = await convergedPair();
		// The same two stores, compared where a value lives. This is the assertion
		// an "imports back whole" or "converged" test wants.
		expect(laptop.store.stored().tables).toEqual(phone.store.stored().tables);
	});

	test('a scalar is a snapshot and a type field is not', async () => {
		const { phone, id } = await convergedPair();
		const held = phone.tables.notes.get(id);

		phone.tables.notes.update(id, { title: 'Errands' });
		held?.body.insert(0, ['and eggs, ']);

		// The scalar was copied out when it was read, so the held row still says
		// what it said. The type field is the container itself, so the edit is
		// visible through the same object.
		expect(held?.title).toBe('Groceries');
		expect(phone.tables.notes.get(id)?.title).toBe('Errands');
		expect(held?.body.toString()).toContain('and eggs');
	});

	test('rowFile returns faithful scalars and the live type for one row', async () => {
		const { phone, id } = await convergedPair();
		const row = phone.store.rowFile('notes', id);
		if (row === undefined) throw new Error('the row is gone');
		const { body, ...scalars } = row;
		expect(scalars).toEqual({ id, title: 'Groceries' });
		expect(body).toBeInstanceOf(Y.Type);
		expect(body).toBe(phone.tables.notes.get(id)?.body);
	});
});
