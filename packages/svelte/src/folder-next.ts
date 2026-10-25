/**
 * An opened folder, read reactively: `svelteFolder` wraps it once, and every
 * read is a tracked getter or lookup, so `$derived` and effects follow it.
 * Writes are the folder's own functions, unchanged.
 *
 * ```svelte
 * const folder = getFolder();
 * const open = $derived(folder.tables.todos.rows.filter((todo) => todo.issues === null && !todo.fields.done));
 * const todo = $derived(folder.tables.todos.row(id));
 * folder.tables.todos.update(id, { fields: { done: true } });
 * ```
 *
 * `row(id)` reads the same objects `rows` holds, and both follow one
 * subscription per table, so a detail view's `$derived` reruns when any row
 * changes but answers the same object unless its own row did. A component
 * that only writes reads nothing, and nothing reruns in it.
 *
 * `<OpenFolder>` opens, wraps, and closes the folder; apps only see this.
 */
import type {
	FileValue,
	Folder,
	Row,
	Store,
	Table,
	Tables,
} from '@epicenter/folder/next';
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema as Schema } from 'typebox';

export type SvelteTable<S extends Schema = Schema> = Pick<
	Table<S>,
	'row' | 'create' | 'update' | 'delete'
> & {
	/** Every row in the table, in listing order; an unchanged row keeps its object. */
	readonly rows: readonly Row<S>[];
};

export type SvelteFolder<T extends Tables = Tables> = Pick<
	Folder<T>,
	'file' | 'read' | 'write' | 'delete'
> & {
	/** Every listed file, in listing order. */
	readonly files: readonly FileValue[];
	/** Whether a write is waiting or in flight. */
	readonly saving: boolean;
	readonly tables: { readonly [K in keyof T]: SvelteTable<T[K]> };
};

/** Wrap an opened folder once; apps read through what this answers. */
export function svelteFolder<const T extends Tables>(
	folder: Folder<T>,
): SvelteFolder<T> {
	const tables = Object.fromEntries(
		Object.entries(folder.tables).map(([name, table]) => [
			name,
			svelteTable(table),
		]),
	);
	const files = tracked(folder.files);
	const saving = tracked(folder.saving);
	return {
		get files() {
			return files();
		},
		file(path) {
			files();
			return folder.file(path);
		},
		get saving() {
			return saving();
		},
		// SAFETY: one wrapped table per key of the folder's tables.
		tables: tables as SvelteFolder<T>['tables'],
		read: folder.read,
		write: folder.write,
		delete: folder.delete,
	};
}

function svelteTable<S extends Schema>(table: Table<S>): SvelteTable<S> {
	const rows = tracked(table.rows);
	return {
		get rows() {
			return rows();
		},
		row(id) {
			rows();
			return table.row(id);
		},
		create: table.create,
		update: table.update,
		delete: table.delete,
	};
}

/** A read of `store` that tracks: one subscription while any effect reads it. */
function tracked<V>(store: Store<V>): () => V {
	const track = createSubscriber((update) => store.subscribe(update));
	return () => {
		track();
		return store.get();
	};
}
