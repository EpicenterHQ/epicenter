/**
 * A device store in memory, for the place `memory()` (the `test`
 * condition's `home`): the same writes as every other store (a create lands
 * only where nothing is, a replacement only over the version its writer
 * read), with nothing kept when the page or process ends. Every folder
 * opened at one memory place shares its files, and hears the others'
 * writes.
 *
 * Its `outside` is the rest of the world, for a test: another program
 * writing or reading a file (which the folder hears, as it hears any
 * outside change), the disk or the network making the folder's own writes
 * or reads wait or fail, and the folder's open waiting or failing.
 * `memoryFiles` from `@epicenter/folder/memory` hands it to a test.
 */
import { ClientError } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import type { OpenFolderError } from '../errors.js';
import { blobIdOf } from '../hash.js';
import {
	type BlobId,
	type Changed,
	type Store,
	StoreError,
	type Unavailable,
	within,
} from './store.js';

/** What a test does to a folder in memory from outside it. */
export type MemoryFiles = {
	/**
	 * Put `content` at `path`, or remove the file for null, as another
	 * program would: nothing checks it against the contract, and the folder
	 * hears it and lists again.
	 */
	write(path: string, content: string | Uint8Array | null): Promise<void>;
	/** The text at `path` as another program reads it, or null when nothing is there. */
	read(path: string): string | null;
	/** Every file's path below `under` (a directory; every file when absent), sorted. */
	paths(under?: string): string[];
	/** Make every write of the folder's own wait until the returned release is called. Reads still answer. */
	hold(): () => void;
	/**
	 * Refuse every write of the folder's own below `under` (every write when
	 * absent) as `Unavailable`, `reason` its cause, until the returned undo is
	 * called.
	 */
	refuse(reason: string, options?: { under?: string }): () => void;
	/**
	 * Refuse every read and listing of the folder's own below `under` (all of
	 * them when absent) as `Unavailable`, `reason` its cause, until the
	 * returned undo is called. Writes still land.
	 */
	refuseReads(reason: string, options?: { under?: string }): () => void;
	/** Make every open of a folder at this place wait until the returned release is called. */
	holdOpen(): () => void;
	/**
	 * Fail every open of a folder at this place with `error` until the
	 * returned undo is called: an `OpenFolderError` fails the folder, and
	 * `Unavailable` is a temporary failure it tries again on its own.
	 */
	refuseOpen(error: OpenFolderError | Unavailable): () => void;
};

/** Whether `path` is below `under` (everything is below no directory). */
const below = (path: string, under: string | undefined) =>
	under === undefined || under === '' || path.startsWith(`${under}/`);

/** A gate: `wait()` answers once nothing holds it. */
function gate() {
	let held: Promise<void> | null = null;
	return {
		async wait() {
			while (held !== null) await held;
		},
		hold() {
			let release = () => {};
			held = new Promise((resolve) => {
				release = () => {
					held = null;
					resolve();
				};
			});
			return release;
		},
	};
}

/** A set of refusals by directory, each undone on its own. */
function refusals() {
	const active = new Set<{ reason: string; under?: string }>();
	return {
		/** The reason `path` is refused, or null. */
		of(path: string | undefined) {
			for (const refusal of active)
				if (path === undefined || below(path, refusal.under))
					return refusal.reason;
			return null;
		},
		/** The reason a listing below `dir` touches a refused directory, or null. */
		overlapping(dir: string | undefined) {
			for (const { reason, under } of active)
				if (
					under === undefined ||
					under === '' ||
					dir === undefined ||
					dir === '' ||
					under === dir ||
					under.startsWith(`${dir}/`) ||
					dir.startsWith(`${under}/`)
				)
					return reason;
			return null;
		},
		add(reason: string, under?: string) {
			const refusal = { reason, under };
			active.add(refusal);
			return () => {
				active.delete(refusal);
			};
		},
	};
}

export function memoryStore(): Store & {
	outside: MemoryFiles;
	/** Open the store for a folder: once nothing holds the open, the store or the error set. */
	opened(): Promise<Result<Store, OpenFolderError | Unavailable>>;
} {
	const files = new Map<string, { bytes: Uint8Array; version: BlobId }>();
	const listeners = new Set<Changed>();
	const writes = gate();
	const opens = gate();
	const writeRefusals = refusals();
	const readRefusals = refusals();
	let openRefusal: OpenFolderError | Unavailable | null = null;

	/** The version `bytes` at `path` would be, null for a removal. */
	const versionOf = async (path: string, bytes: Uint8Array | null) =>
		bytes === null ? null : blobIdOf(path, bytes);

	/**
	 * Put `bytes` at `path` as `version`, or remove it for null. Synchronous,
	 * so a write's check and its change are one step.
	 */
	function place(
		path: string,
		bytes: Uint8Array | null,
		version: BlobId | null,
	) {
		if (bytes === null || version === null) files.delete(path);
		else files.set(path, { bytes: bytes.slice(), version });
	}

	/** Every folder at this place hears it, the writer's own included: the change is readable already. */
	const tell = (path: string) => {
		for (const listener of [...listeners]) listener([path]);
	};

	const store: Store = {
		async list(under) {
			for (const directory of under) {
				const refused = readRefusals.overlapping(directory);
				if (refused !== null)
					return ClientError.Unavailable({ cause: refused });
			}
			return Ok(
				[...files]
					.filter(([path]) => within(path, under))
					.map(([path, { bytes, version }]) => ({
						path,
						version,
						size: bytes.byteLength,
					})),
			);
		},
		async read(paths) {
			for (const path of paths) {
				const refused = readRefusals.of(path);
				if (refused !== null)
					return ClientError.Unavailable({ cause: refused });
			}
			return Ok(
				paths.map((path) => {
					const file = files.get(path);
					return file === undefined
						? { path, gone: true as const }
						: { path, bytes: file.bytes.slice(), version: file.version };
				}),
			);
		},
		async put(path, bytes, expect) {
			await writes.wait();
			const refused = writeRefusals.of(path);
			if (refused !== null) return ClientError.Unavailable({ cause: refused });
			const landed = await versionOf(path, bytes);
			// No await from here: of two writes over one version, one lands.
			const now = files.get(path)?.version ?? null;
			if (now !== expect) return StoreError.Moved({ path, now });
			place(path, bytes, landed);
			tell(path);
			return Ok(landed);
		},
		async watch(changed) {
			listeners.add(changed);
			return Ok(() => {
				listeners.delete(changed);
			});
		},
		close() {},
	};

	return {
		...store,
		async opened() {
			await opens.wait();
			return openRefusal === null
				? Ok(store)
				: { data: null, error: openRefusal };
		},
		outside: {
			async write(path, content) {
				const bytes =
					typeof content === 'string'
						? new TextEncoder().encode(content)
						: content;
				place(path, bytes, await versionOf(path, bytes));
				tell(path);
			},
			read(path) {
				const file = files.get(path);
				return file === undefined ? null : new TextDecoder().decode(file.bytes);
			},
			paths(under) {
				return [...files.keys()].filter((path) => below(path, under)).sort();
			},
			hold: writes.hold,
			refuse: (reason, { under } = {}) => writeRefusals.add(reason, under),
			refuseReads: (reason, { under } = {}) => readRefusals.add(reason, under),
			holdOpen: opens.hold,
			refuseOpen(error) {
				openRefusal = error;
				return () => {
					if (openRefusal === error) openRefusal = null;
				};
			},
		},
	};
}
