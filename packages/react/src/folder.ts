/**
 * An opened folder in React: `useFolder()` answers the folder as a snapshot
 * that re-renders its component only when something that component read
 * changes.
 *
 * ```tsx
 * export const { FolderProvider, useFolder } = createFolderContext<typeof tables>();
 *
 * function TodoList() {
 * 	const folder = useFolder();
 * 	const open = folder.tables.todos.rows.filter((todo) => todo.issues === null && !todo.fields.done);
 * 	return open.map((todo) => <TodoItem key={todo.id} todo={todo} />);
 * }
 * ```
 *
 * A snapshot is immutable: each read answers what it answered first in that
 * snapshot, and a new snapshot (a new object) comes when a read value
 * changes, so React Compiler and `useMemo` see the change. `row(id)` and
 * `file(path)` are reads of their own, so a detail view re-renders only when
 * its row changes. A component that only writes, like a list item with a
 * checkbox, reads nothing and never re-renders from the folder. Writes are
 * the folder's own functions.
 */
import type {
	FileValue,
	Folder,
	Row,
	Store,
	Table,
	Tables,
} from '@epicenter/folder/next';
import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import type { TSchema as Schema } from 'typebox';

export type ReactTable<S extends Schema = Schema> = Pick<
	Table<S>,
	'row' | 'create' | 'update' | 'delete'
> & {
	/** Every row in the table, in listing order; an unchanged row keeps its object. */
	readonly rows: readonly Row<S>[];
};

export type ReactFolder<T extends Tables = Tables> = Pick<
	Folder<T>,
	'file' | 'read' | 'write' | 'delete'
> & {
	/** Every listed file, in listing order. */
	readonly files: readonly FileValue[];
	/** Whether a write is waiting or in flight. */
	readonly saving: boolean;
	readonly tables: { readonly [K in keyof T]: ReactTable<T[K]> };
};

/** A provider for an opened folder, and the hook its components read it with. */
export function createFolderContext<const T extends Tables>() {
	const Context = createContext<Folder<T> | null>(null);
	return {
		FolderProvider({
			folder,
			children,
		}: {
			folder: Folder<T>;
			children?: ReactNode;
		}) {
			return createElement(Context.Provider, { value: folder }, children);
		},
		useFolder(): ReactFolder<T> {
			const folder = useContext(Context);
			if (folder === null)
				throw new Error('useFolder is used outside its FolderProvider');
			return useSnapshot(folder);
		},
	};
}

/**
 * What one snapshot read: for each read (a store, or one row or file by its
 * key), how to read it again and the value it answered.
 */
type Reads = Map<
	unknown,
	{ readonly get: () => unknown; readonly value: unknown }
>;

function useSnapshot<T extends Tables>(folder: Folder<T>): ReactFolder<T> {
	const current = useRef<{
		folder: Folder<T>;
		view: ReactFolder<T>;
		reads: Reads;
	} | null>(null);
	const subscribe = useCallback(
		(onChange: () => void) => {
			const stops = storesOf(folder).map((store) => store.subscribe(onChange));
			return () => {
				for (const stop of stops) stop();
			};
		},
		[folder],
	);
	const getSnapshot = () => {
		const known = current.current;
		if (
			known !== null &&
			known.folder === folder &&
			[...known.reads.values()].every(({ get, value }) => get() === value)
		)
			return known.view;
		const reads: Reads = new Map();
		const view = snapshot(folder, reads);
		current.current = { folder, view, reads };
		return view;
	};
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function storesOf(folder: Folder): Store<unknown>[] {
	return [
		folder.files,
		folder.saving,
		...Object.values(folder.tables).map((table) => table.rows),
	];
}

/** A snapshot of `folder` whose reads record themselves in `reads`. */
function snapshot<T extends Tables>(
	folder: Folder<T>,
	reads: Reads,
): ReactFolder<T> {
	const read: Read = (key, get) => {
		const known = reads.get(key);
		if (known !== undefined) {
			// SAFETY: `reads` maps each key to a value its `get` answered.
			return known.value as ReturnType<typeof get>;
		}
		const value = get();
		reads.set(key, { get, value });
		return value;
	};
	// Each snapshot brings its own table objects: React Compiler memoizes a
	// call like `view.tables.todos.row(id)` on `view.tables.todos`, so a new
	// snapshot must be new all the way down.
	const tables = Object.fromEntries(
		Object.entries(folder.tables).map(([name, table]) => [
			name,
			tableSnapshot(name, table, read),
		]),
	);
	return {
		get files() {
			return read(folder.files, folder.files.get);
		},
		file: (path) => read(`file:${path}`, () => folder.file(path)),
		get saving() {
			return read(folder.saving, folder.saving.get);
		},
		// SAFETY: one table snapshot per key of the folder's tables.
		tables: tables as ReactFolder<T>['tables'],
		read: folder.read,
		write: folder.write,
		delete: folder.delete,
	};
}

type Read = <V>(key: unknown, get: () => V) => V;

function tableSnapshot<S extends Schema>(
	name: string,
	table: Table<S>,
	read: Read,
): ReactTable<S> {
	return {
		get rows() {
			return read(table.rows, table.rows.get);
		},
		// One row is its own read: a change to another row leaves this snapshot standing.
		row: (id) => read(`row:${name}/${id}`, () => table.row(id)),
		create: table.create,
		update: table.update,
		delete: table.delete,
	};
}

/**
 * Text a person is typing, ahead of the value it saves to: `text` shows what
 * was typed until that text's save answers, then `value` again, which is the
 * landed text, or the disk's when the save failed.
 *
 * ```tsx
 * const title = useDraft(todo?.issues === null ? todo.fields.title : '', (title) =>
 * 	folder.tables.todos.update(id, { fields: { title } }),
 * );
 * <input value={title.text} onChange={(event) => title.set(event.target.value)} />
 * ```
 */
export type Draft = {
	/** What was typed, until its save answers; the value after. */
	readonly text: string;
	set(text: string): void;
};

export function useDraft(
	value: string,
	save: (text: string) => Promise<unknown>,
): Draft {
	const [typed, setTyped] = useState<string | null>(null);
	const latest = useRef(0);
	const saveRef = useRef(save);
	useLayoutEffect(() => {
		saveRef.current = save;
	});
	const [set] = useState(() => (text: string) => {
		setTyped(text);
		const mine = ++latest.current;
		void saveRef.current(text).finally(() => {
			if (mine === latest.current) setTyped(null);
		});
	});
	return { text: typed ?? value, set };
}
