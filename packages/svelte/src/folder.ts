/** Reactive reads over one opened folder; writes keep their core promises. */
import type {
	Data,
	Folder,
	FolderFile,
	Patch,
	Row,
	Saved,
	Table,
	Tables,
} from '@epicenter/folder';
import { withFileNewlines } from '@epicenter/folder/file-browser';
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema as Schema, Static } from 'typebox';
import { edit } from './edit.svelte.js';

export { edit } from './edit.svelte.js';

/** A whole-file text edit, edited as LF and sent in its base's newline style. */
export function fileEdit<T extends Tables>(
	folder: SvelteFolder<T>,
	path: string,
) {
	let base: Data | null = folder.file(path)?.data ?? null;
	let submitted = 0;
	return edit(
		() => {
			const data = folder.file(path)?.data;
			base = data ?? null;
			return typeof data === 'string' ? data.replace(/\r\n?/g, '\n') : '';
		},
		(typed) => {
			const sequence = ++submitted;
			const data = withFileNewlines(
				typed,
				typeof base === 'string' ? base : '',
			);
			const sent = base;
			base = data;
			const saved = folder.write(path, data, { base: sent });
			void saved.then(() => {
				if (sequence === submitted) base = folder.file(path)?.data ?? null;
			});
			return saved;
		},
	);
}

export type SvelteTable<S extends Schema = Schema> = {
	readonly rows: readonly Row<S>[];
	row(id: string): Row<S> | undefined;
	create(id: string, init: { fields: Static<S>; body?: string }): Saved;
	update(id: string, patch: Patch<S>): Saved;
	delete(id: string): Saved;
};
export type SvelteFolder<T extends Tables = Tables> = {
	readonly files: readonly FolderFile[];
	file(path: string): FolderFile | undefined;
	readonly saving: boolean;
	idle(): Promise<void>;
	read: Folder<T>['read'];
	write: Folder<T>['write'];
	update: Folder<T>['update'];
	move: Folder<T>['move'];
	delete(path: string): Saved;
	readonly tables: { readonly [K in keyof T]: SvelteTable<T[K]> };
	refresh(): Promise<void>;
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
		move: folder.move,
		delete: folder.delete,
		idle: folder.idle,
		refresh: folder.refresh,
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
