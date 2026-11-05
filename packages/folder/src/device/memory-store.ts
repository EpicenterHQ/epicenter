/**
 * A device store in memory, for the folder `openFolder` answers under the
 * `test` condition: the same writes as every other store (a create lands
 * only where nothing is, a replacement only over the version its writer
 * read), with nothing kept when the page or process ends.
 *
 * Its `outside` is the rest of the world, for a test: another program
 * writing a file (which the folder hears, as it hears any outside change),
 * and the disk or the network making the folder's own writes wait or fail.
 * `memoryFiles(folder)` from `@epicenter/folder/memory` hands it to a test.
 */
import { ClientError, type Version } from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import type { ChangeListener } from '../changes.js';
import { hashBytes } from '../hash.js';
import type { DeviceStore } from './store.js';

/** What a test does to a folder in memory from outside it. */
export type MemoryFiles = {
	/**
	 * Put `content` at `path`, or remove the file for null, as another
	 * program would: nothing checks it against the contract, and the folder
	 * hears it and lists again.
	 */
	write(path: string, content: string | Uint8Array | null): Promise<void>;
	/** Make every write of the folder's own wait until the returned release is called. Reads still answer. */
	hold(): () => void;
	/** Refuse every write of the folder's own as `Unavailable`, `reason` its cause, until the returned undo is called. */
	refuse(reason: string): () => void;
};

/** Where a folder in memory keeps its `outside`; a symbol member, so `reactive`'s copy carries it. */
export const MEMORY_FILES = Symbol('epicenter.memoryFiles');

export function memoryStore(): DeviceStore & { outside: MemoryFiles } {
	const files = new Map<string, { bytes: Uint8Array; version: Version }>();
	let stamps = 0;
	const stampOf = new Map<string, string>();
	const listeners = new Set<ChangeListener>();
	/** Writes of the folder's own wait while this is set. */
	let held: Promise<void> | null = null;
	/** Writes of the folder's own are refused, for this reason, while it is set. */
	let refusal: string | null = null;

	/** Put `bytes` at `path`, or remove it for null; the version put there. */
	async function put(path: string, bytes: Uint8Array | null) {
		if (bytes === null) {
			files.delete(path);
			stampOf.delete(path);
			return null;
		}
		const version = (await hashBytes(bytes)) as Version;
		files.set(path, { bytes: bytes.slice(), version });
		stampOf.set(path, String(++stamps));
		return version;
	}

	return {
		async list() {
			return Ok(
				[...files.keys()].map((path) => ({
					path,
					stamp: stampOf.get(path) ?? '',
				})),
			);
		},
		async read(path) {
			const file = files.get(path);
			if (file === undefined) return Ok(null);
			return Ok({
				bytes: file.bytes.slice(),
				version: file.version,
				stamp: stampOf.get(path) ?? '',
			});
		},
		async write(path, bytes, expected) {
			while (held !== null) await held;
			if (refusal !== null) return ClientError.Unavailable({ cause: refusal });
			const file = files.get(path);
			const holds =
				expected === 'absent'
					? file === undefined
					: file?.version === expected.version;
			if (!holds) return Ok('stale');
			return Ok({ landed: await put(path, bytes) });
		},
		// The client hears its own writes itself; this hears `outside`'s.
		watch(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		outside: {
			async write(path, content) {
				await put(
					path,
					typeof content === 'string'
						? new TextEncoder().encode(content)
						: content,
				);
				for (const listener of [...listeners]) listener([path]);
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
			refuse(reason) {
				refusal = reason;
				return () => {
					refusal = null;
				};
			},
		},
	};
}
