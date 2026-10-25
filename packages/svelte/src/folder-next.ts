/** Reactive reads over one opened folder; writes keep their core promises. */
import type {
	Data,
	FileValue,
	Folder,
	Patch,
	Row,
	Saved,
	Table,
	Tables,
} from '@epicenter/folder/next';
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema as Schema, Static } from 'typebox';

export { draft } from './draft.svelte.js';

export type SvelteTable<S extends Schema = Schema> = {
	readonly rows: readonly Row<S>[];
	row(id: string): Row<S> | undefined;
	create(id: string, init: { fields: Static<S>; body?: string }): Saved;
	update(id: string, patch: Patch<S>): Saved;
	delete(id: string): Saved;
};
export type SvelteFolder<T extends Tables = Tables> = {
	readonly files: readonly FileValue[];
	file(path: string): FileValue | undefined;
	readonly saving: boolean;
	read: Folder<T>['read'];
	write(path: string, data: Data): Saved;
	update: Folder<T>['update'];
	delete(path: string): Saved;
	readonly tables: { readonly [K in keyof T]: SvelteTable<T[K]> };
	checkpoint(): void;
	settled(path: string): Promise<void>;
};

export function svelteFolder<const T extends Tables>(
	folder: Folder<T>,
): SvelteFolder<T> {
	const track = createSubscriber((update) => folder.subscribe(update));
	const tables = Object.fromEntries(
		Object.entries(folder.tables).map(([name, table]) => [
			name,
			svelteTable(table, track),
		]),
	);
	return {
		get files() {
			track();
			return folder.files();
		},
		file(path) {
			track();
			return folder.file(path);
		},
		get saving() {
			track();
			return folder.saving();
		},
		// SAFETY: each table key has one wrapped table with its original schema.
		tables: tables as SvelteFolder<T>['tables'],
		read: folder.read,
		write: folder.write,
		update: folder.update,
		delete: folder.delete,
		checkpoint: folder.checkpoint,
		settled: folder.settled,
	};
}

function svelteTable<S extends Schema>(
	table: Table<S>,
	track: () => void,
): SvelteTable<S> {
	return {
		get rows() {
			track();
			return table.rows();
		},
		row(id) {
			track();
			return table.row(id);
		},
		create: table.create,
		update: table.update,
		delete: table.delete,
	};
}
