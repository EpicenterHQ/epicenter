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
	SaveFailure,
	Table,
	Tables,
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
import type { Result } from 'wellcrafted/result';

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
	settled(path: string): Promise<void>;
};

type Provided<T extends Tables> = {
	folder: Folder<T>;
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
			const onFailedRef = useRef(onFailed);
			onFailedRef.current = onFailed;
			useEffect(() => {
				let active = true;
				let folder: Folder<T> | undefined;
				let stopFailed: (() => void) | undefined;
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
						stopFailed = folder.onFailed((failure) =>
							onFailedRef.current?.(failure),
						);
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
					stopFailed?.();
					if (folder !== undefined) void folder.close();
				};
			}, []);
			if (state.kind === 'opening') return loading;
			if (state.kind === 'refused') return refused?.(state.error);
			return createElement(
				Context.Provider,
				{ value: { folder: state.folder } },
				children,
			);
		},
		useFolder(): ReactFolder<T> {
			const provided = useContext(Context);
			if (provided === null)
				throw new Error('useFolder is used outside OpenFolder');
			return useSnapshot(provided.folder);
		},
	};
}

type Reads = Map<
	string,
	{ readonly get: () => unknown; readonly value: unknown }
>;
type Read = <V>(key: string, get: () => V) => V;

function useSnapshot<T extends Tables>(folder: Folder<T>): ReactFolder<T> {
	const current = useRef<{
		folder: Folder<T>;
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

function snapshot<T extends Tables>(
	folder: Folder<T>,
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
	// Each snapshot has new table objects because React Compiler memoizes calls on their receiver.
	const tables = Object.fromEntries(
		Object.entries(folder.tables).map(([name, table]) => [
			name,
			tableSnapshot(name, table, read),
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
		write: folder.write,
		update: folder.update,
		delete: folder.delete,
		checkpoint: folder.checkpoint,
		settled: folder.settled,
	};
}

function tableSnapshot<S extends Schema>(
	name: string,
	table: Table<S>,
	read: Read,
): ReactTable<S> {
	return {
		get rows() {
			return read(`rows:${name}`, table.rows);
		},
		row: (id) => read(`row:${name}/${id}`, () => table.row(id)),
		create: table.create,
		update: table.update,
		delete: table.delete,
	};
}

/** Editor-owned input ahead of its save; failed input remains visible. */
export function useDraft<T, E>(
	value: T,
	save: (value: T) => Promise<Result<unknown, E>>,
) {
	const [typed, setTyped] = useState<{ value: T } | null>(null);
	const [error, setError] = useState<E | null>(null);
	const latest = useRef(0);
	const saveRef = useRef(save);
	const typedRef = useRef<{ value: T } | null>(null);
	useLayoutEffect(() => {
		saveRef.current = save;
	});
	const [set] = useState(() => (next: T) => {
		const draft = { value: next };
		typedRef.current = draft;
		setTyped(draft);
		setError(null);
		const mine = ++latest.current;
		void saveRef.current(next).then((answer) => {
			if (mine !== latest.current) return;
			if (answer.error === null) {
				typedRef.current = null;
				setTyped(null);
			} else setError(answer.error);
		});
	});
	const [retry] = useState(() => () => {
		if (typedRef.current !== null) set(typedRef.current.value);
	});
	const [discard] = useState(() => () => {
		latest.current++;
		typedRef.current = null;
		setTyped(null);
		setError(null);
	});
	return {
		value: typed === null ? value : typed.value,
		set,
		error,
		retry,
		discard,
	};
}
