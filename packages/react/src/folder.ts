/** Tracked immutable React snapshots over one opened folder. */
import type {
	Data,
	FileValue,
	Folder,
	Opened,
	OpenFolderError,
	Patch,
	Row,
	Saved,
	Table,
	Tables,
	WriteError,
} from '@epicenter/folder/next';
import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import type { TSchema as Schema, Static } from 'typebox';
import { extractErrorMessage } from 'wellcrafted/error';

export type SaveFailure = {
	path: string;
	error: WriteError;
	text: string | undefined;
};
export type ReactTable<S extends Schema = Schema> = {
	readonly rows: readonly Row<S>[];
	row(id: string): Row<S> | undefined;
	create(id: string, init: { fields: Static<S>; body?: string }): Saved;
	update(id: string, patch: Patch<S>): Saved;
	delete(id: string): Saved;
};
export type ReactFolder<T extends Tables = Tables> = {
	readonly files: readonly FileValue[];
	file(path: string): FileValue | undefined;
	readonly saving: boolean;
	read: Folder<T>['read'];
	write(path: string, data: Data): Saved;
	update: Folder<T>['update'];
	delete(path: string): Saved;
	readonly tables: { readonly [K in keyof T]: ReactTable<T[K]> };
	checkpoint(): void;
};

type Provided<T extends Tables> = {
	folder: Folder<T>;
	onFailed: ((failure: SaveFailure) => void) | undefined;
};
type OpenState<T extends Tables> =
	| { kind: 'opening' }
	| { kind: 'refused'; error: OpenFolderError }
	| { kind: 'ready'; folder: Folder<T> };

/** One mounted opener and the hook its descendants use. */
export function createFolderContext<const T extends Tables>() {
	const Context = createContext<Provided<T> | null>(null);
	return {
		OpenFolder({
			open,
			children,
			loading,
			refused,
			onFailed,
		}: {
			open: () => Opened<T>;
			children: ReactNode;
			loading?: ReactNode;
			refused?: (error: OpenFolderError) => ReactNode;
			onFailed?: (failure: SaveFailure) => void;
		}) {
			const [state, setState] = useState<OpenState<T>>({ kind: 'opening' });
			const openRef = useRef(open);
			useEffect(() => {
				let active = true;
				let folder: Folder<T> | undefined;
				const checkpoint = () => folder?.checkpoint();
				const visibility = () => folder?.checkpoint();
				const beforeUnload = (event: BeforeUnloadEvent) => {
					folder?.checkpoint();
					if (!folder?.saving()) return;
					event.preventDefault();
					event.returnValue = '';
				};
				void Promise.resolve()
					.then(() => openRef.current())
					.then((result) => {
						if (result.error !== null) {
							if (active) setState({ kind: 'refused', error: result.error });
							return;
						}
						if (!active) {
							void result.data.close();
							return;
						}
						folder = result.data;
						window.addEventListener('focus', checkpoint);
						window.addEventListener('online', checkpoint);
						window.addEventListener('pagehide', checkpoint);
						window.addEventListener('beforeunload', beforeUnload);
						document.addEventListener('visibilitychange', visibility);
						setState({ kind: 'ready', folder });
					})
					.catch((cause: unknown) => {
						if (!active) return;
						const error: OpenFolderError = {
							name: 'Unavailable',
							message: `The folder could not be opened: ${extractErrorMessage(cause)}`,
							cause,
						};
						setState({ kind: 'refused', error });
					});
				return () => {
					active = false;
					window.removeEventListener('focus', checkpoint);
					window.removeEventListener('online', checkpoint);
					window.removeEventListener('pagehide', checkpoint);
					window.removeEventListener('beforeunload', beforeUnload);
					document.removeEventListener('visibilitychange', visibility);
					if (folder !== undefined) void folder.close();
				};
			}, []);
			if (state.kind === 'opening') return loading;
			if (state.kind === 'refused') return refused?.(state.error);
			return createElement(
				Context.Provider,
				{ value: { folder: state.folder, onFailed } },
				children,
			);
		},
		useFolder(): ReactFolder<T> {
			const provided = useContext(Context);
			if (provided === null)
				throw new Error('useFolder is used outside OpenFolder');
			return useSnapshot(provided.folder, provided.onFailed);
		},
	};
}

type Reads = Map<
	string,
	{ readonly get: () => unknown; readonly value: unknown }
>;
type Read = <V>(key: string, get: () => V) => V;

function useSnapshot<T extends Tables>(
	folder: Folder<T>,
	onFailed: ((failure: SaveFailure) => void) | undefined,
): ReactFolder<T> {
	const current = useRef<{
		folder: Folder<T>;
		onFailed: typeof onFailed;
		view: ReactFolder<T>;
		reads: Reads;
	} | null>(null);
	const subscribe = useCallback(
		(onChange: () => void) => folder.subscribe(onChange),
		[folder],
	);
	const getSnapshot = () => {
		const known = current.current;
		if (
			known !== null &&
			known.folder === folder &&
			known.onFailed === onFailed &&
			[...known.reads.values()].every(({ get, value }) => get() === value)
		)
			return known.view;
		const reads: Reads = new Map();
		const view = snapshot(folder, onFailed, reads);
		current.current = { folder, onFailed, view, reads };
		return view;
	};
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function snapshot<T extends Tables>(
	folder: Folder<T>,
	onFailed: ((failure: SaveFailure) => void) | undefined,
	reads: Reads,
): ReactFolder<T> {
	const read: Read = (key, get) => {
		const known = reads.get(key);
		if (known !== undefined) {
			// SAFETY: each key stores the value returned by its matching read.
			return known.value as ReturnType<typeof get>;
		}
		const value = get();
		reads.set(key, { get, value });
		return value;
	};
	const report = (
		path: string,
		text: string | undefined,
		saved: Saved,
	): Saved => {
		void saved.then(({ error }) => {
			if (error !== null) onFailed?.({ path, error, text });
		});
		return saved;
	};
	// Each snapshot has new table objects because React Compiler memoizes calls on their receiver.
	const tables = Object.fromEntries(
		Object.entries(folder.tables).map(([name, table]) => [
			name,
			tableSnapshot(name, table, read, report),
		]),
	);
	return {
		get files() {
			return read('files', folder.files);
		},
		file: (path) => read(`file:${path}`, () => folder.file(path)),
		get saving() {
			return read('saving', folder.saving);
		},
		// SAFETY: each table key has one snapshot of its original schema.
		tables: tables as ReactFolder<T>['tables'],
		read: folder.read,
		write: (path, data) =>
			report(
				path,
				typeof data === 'string' ? data : undefined,
				folder.write(path, data),
			),
		update: (path, patch, options) =>
			report(
				path,
				patch.body ?? fieldText(patch.fields),
				folder.update(path, patch, options),
			),
		delete: (path) => report(path, undefined, folder.delete(path)),
		checkpoint: folder.checkpoint,
	};
}

function tableSnapshot<S extends Schema>(
	name: string,
	table: Table<S>,
	read: Read,
	report: (path: string, text: string | undefined, saved: Saved) => Saved,
): ReactTable<S> {
	const pathOf = (id: string) => `${name}/${id}.md`;
	return {
		get rows() {
			return read(`rows:${name}`, table.rows);
		},
		row: (id) => read(`row:${name}/${id}`, () => table.row(id)),
		create: (id, init) =>
			report(
				pathOf(id),
				init.body ?? fieldText(init.fields),
				table.create(id, init),
			),
		update: (id, patch) =>
			report(
				pathOf(id),
				patch.body ?? fieldText(patch.fields),
				table.update(id, patch),
			),
		delete: (id) => report(pathOf(id), undefined, table.delete(id)),
	};
}

function fieldText(fields: object | undefined): string | undefined {
	if (fields === undefined) return undefined;
	const values = Object.values(fields).filter(
		(value): value is string => typeof value === 'string',
	);
	return values.length === 0 ? undefined : values.join('\n');
}

/** Text ahead of its save, until that save answers. */
export type Draft = { readonly text: string; set(text: string): void };
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
