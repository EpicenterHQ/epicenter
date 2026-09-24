/**
 * Row reads are serializable value snapshots; body access returns live editing state.
 * Converged stores produce equal rows while their body nodes remain distinct objects.
 */
import { describe, expect, test } from 'bun:test';
import { defineStore } from '@epicenter/app';
import {
	defineTable,
	field,
	plainText,
} from '../../src/data/definition/index.js';
import { openMemory } from '../../src/data/store/memory.js';
import { syncEngineOf } from '../../src/data/store/store.js';

const database = defineStore({
	id: 'so.epicenter.rowvalue',
	kv: {},
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
			},
			body: plainText(),
		}),
	},
});

/** Two stores holding byte-identical state, the way a synced pair does. */
async function convergedPair() {
	const phone = await openMemory(database);
	const made = phone.tables.notes.create({ title: 'Groceries' });
	const content = phone.tables.notes.body(made.id);
	content?.insert(0, ['buy milk']);

	const laptop = await openMemory(database);
	syncEngineOf(laptop).applyRemote(phone.encodeStateSince());
	return { phone, laptop, id: made.id };
}

describe('rows are values and bodies are live nodes', () => {
	test('two converged stores produce equal value snapshots', async () => {
		const { phone, laptop, id } = await convergedPair();
		expect(laptop.tables.notes.get(id)).toEqual(
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
		phone.tables.notes.body(id)?.insert(0, ['and eggs, ']);

		// The value was copied out when it was read, so the held row still says
		// what it said. The content node is the container itself, so the edit is
		// visible through the same object.
		expect(held?.title).toBe('Groceries');
		expect(phone.tables.notes.get(id)?.title).toBe('Errands');
		expect(phone.tables.notes.body(id)?.toString()).toContain('and eggs');
	});

	test('rowFile preserves stored values alongside the body', async () => {
		const { phone, id } = await convergedPair();
		const row = phone.rowFile('notes', id);
		if (row === undefined) throw new Error('the row is gone');
		expect(row.id).toBe(id);
		expect(row.fields).toEqual({ title: 'Groceries' });
		expect(row.body).toBe(phone.tables.notes.body(id));
	});
});
