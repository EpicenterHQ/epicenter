/**
 * An opened folder, read reactively: `svelteFolder` wraps it once, and every
 * read is a tracked getter or lookup over one subscription, so `$derived` and
 * effects follow it. `rows` and `row(id)` answer the same objects, and an
 * unchanged row keeps its object, so a derived read reruns on any change but
 * answers the same value unless its own row changed.
 *
 * Writes are the folder's own, and each one that does not land is reported
 * once to `onFailed` with the text a person can copy. `<OpenFolder>` opens,
 * wraps, and closes the folder; apps only see this.
 */
import type {
	Data,
	FileValue,
	Folder,
	Patch,
	Row,
	Saved,
	Table,
	Tables,
	WriteError,
} from '@epicenter/folder/next';
import { typedText } from '@epicenter/folder/next';
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema as Schema, Static } from 'typebox';

export { draft } from './draft.svelte.js';

/** A write that did not land, and the typed text it carried, to offer for copying. */
export type SaveFailure = {
	path: string;
	error: WriteError;
	text: string | undefined;
};
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
};

export function svelteFolder<const T extends Tables>(
	folder: Folder<T>,
	{ onFailed }: { onFailed?: (failure: SaveFailure) => void } = {},
): SvelteFolder<T> {
	const track = createSubscriber((update) => folder.subscribe(update));
	/** Tell `onFailed` once about a write that did not land, except a refusal the caller handles. */
	const report = (
		path: string,
		text: string | undefined,
		saved: Saved,
		handled?: WriteError['name'],
	): Saved => {
		void saved.then(({ error }) => {
			if (error !== null && error.name !== handled)
				onFailed?.({ path, error, text });
		});
		return saved;
	};
	const tables = Object.fromEntries(
		Object.entries(folder.tables).map(([name, table]) => [
			name,
			svelteTable(name, table, track, report),
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
		write: (path, data) =>
			report(
				path,
				typeof data === 'string' ? data : undefined,
				folder.write(path, data),
			),
		update: (path, patch, options) =>
			report(path, typedText(patch), folder.update(path, patch, options)),
		delete: (path) => report(path, undefined, folder.delete(path)),
		checkpoint: folder.checkpoint,
	};
}

function svelteTable<S extends Schema>(
	name: string,
	table: Table<S>,
	track: () => void,
	report: (
		path: string,
		text: string | undefined,
		saved: Saved,
		handled?: WriteError['name'],
	) => Saved,
): SvelteTable<S> {
	const pathOf = (id: string) => `${name}/${id}.md`;
	return {
		get rows() {
			track();
			return table.rows();
		},
		row(id) {
			track();
			return table.row(id);
		},
		create(id, init) {
			return report(
				pathOf(id),
				typedText(init),
				table.create(id, init),
				// A create that finds the file there answers the caller, who decides what it means.
				'Exists',
			);
		},
		update(id, patch) {
			return report(pathOf(id), typedText(patch), table.update(id, patch));
		},
		delete(id) {
			return report(pathOf(id), undefined, table.delete(id));
		},
	};
}
