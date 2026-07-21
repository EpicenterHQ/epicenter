import { expect, test } from 'bun:test';
import {
	DataReadError,
	defineTable,
	type NonconformingRowError,
	type RowFor,
	type TableLens,
} from '@epicenter/data';
import { field } from '@epicenter/field';
import { fromTable } from './from-table.svelte.js';

/**
 * Data table Svelte adapter tests.
 *
 * Key behaviors:
 * - Initial refresh classifies conforming and nonconforming rows
 * - Explicit refresh updates classified and point-read surfaces
 */

(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);

const definition = defineTable({
	key: 'so.epicenter.test.svelte.rows',
	fields: { name: field.string() },
});
type Row = RowFor<typeof definition>;

type StoredEntry =
	| { kind: 'row'; row: Row }
	| { kind: 'error'; error: NonconformingRowError };

const row = (id: string, name = id): StoredEntry => ({
	kind: 'row',
	row: { id, name },
});

const nonconforming = (id: string): StoredEntry => ({
	kind: 'error',
	error: DataReadError.NonconformingRow({
		key: definition.key,
		id,
		raw: {},
		issues: [{ field: 'name', kind: 'missing', message: 'required' }],
	}).error,
});

function createMockTable() {
	const store = new Map<string, StoredEntry>();

	const table = {
		async scan() {
			const scan = {
				rows: [] as Row[],
				nonconforming: [] as NonconformingRowError[],
			};
			for (const entry of store.values()) {
				if (entry.kind === 'row') {
					scan.rows.push(entry.row);
				} else {
					scan.nonconforming.push(entry.error);
				}
			}
			return scan;
		},
		subscribe() {
			return () => {};
		},
	} as unknown as TableLens<typeof definition>;

	return { table, store };
}

test('initial refresh classifies conforming and nonconforming rows', async () => {
	const { table, store } = createMockTable();
	store.set('ok', row('ok'));
	store.set('bad', nonconforming('bad'));

	const entries = fromTable(table);
	await entries.whenReady;

	expect(entries.all.map((r) => r.id)).toEqual(['ok']);
	expect(entries.nonconforming.map((e) => e.id)).toEqual(['bad']);
});

test('explicit refresh updates classified and point-read surfaces', async () => {
	const { table, store } = createMockTable();
	const entries = fromTable(table);
	await entries.whenReady;
	expect(entries.all).toEqual([]);

	store.set('a', row('a', 'Ada'));
	await entries.refresh();
	expect(entries.byId('a')?.name).toBe('Ada');
	expect(entries.all.map((r) => r.id)).toEqual(['a']);

	store.delete('a');
	await entries.refresh();
	expect(entries.byId('a')).toBeUndefined();
	expect(entries.all).toEqual([]);
});
