/**
 * `@epicenter/folder/testing`: a folder over memory, for tests of the
 * folder and of what is built on it. `memoryHost` is a `FolderHost` a test
 * can write behind, delay, and break.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import { ReadError, SaveError } from './shared/errors.js';
import type { Fetched, FolderHost, Listed } from './storage.js';

export { OpenFolderError } from './errors.js';
export { createFolder } from './folder.js';
export { ReadError, SaveError } from './shared/errors.js';
export { WriteRefusal } from './write-refusal.js';

const encoder = new TextEncoder();

type StorageLog = {
	lists: number;
	reads: string[][];
	puts: { path: string }[];
};

type StorageControl = {
	beforePut: ((path: string) => void) | undefined;
	readGate: Promise<void> | undefined;
	failRead: Map<string, ReadError>;
	listGate: Promise<void> | undefined;
	putGate: Promise<void> | undefined;
	failPut: Map<string, SaveError>;
	listFails: boolean;
	closed: boolean;
};

export function memoryHost(initial: Record<string, string | Uint8Array> = {}) {
	let clock = 0;
	const files = new Map<string, { bytes: Uint8Array; stamp: string }>();
	const listeners = new Set<(paths: readonly string[] | null) => void>();
	const place = (path: string, data: string | Uint8Array) => {
		const bytes = typeof data === 'string' ? encoder.encode(data) : data;
		const stamp = `${++clock}`;
		const file = { bytes, stamp: `t${stamp}` };
		files.set(path, file);
		return file;
	};
	for (const [path, data] of Object.entries(initial)) place(path, data);

	const log: StorageLog = { lists: 0, reads: [], puts: [] };
	const control: StorageControl = {
		/** Runs before each put lands; a test plays a racing writer here. */
		beforePut: undefined,
		/** While set, reads wait for it after taking their snapshot. */
		readGate: undefined,
		failRead: new Map<string, ReadError>(),
		listGate: undefined,
		putGate: undefined,
		/** A put to this path fails with this error. */
		failPut: new Map<string, SaveError>(),
		listFails: false,
		closed: false,
	};

	const storage: FolderHost = {
		async list() {
			log.lists++;
			const answer = new Map<string, Listed>(
				[...files].map(([path, file]) => [path, { stamp: file.stamp }]),
			);
			await control.listGate;
			if (control.listFails)
				return ReadError.StorageFailed({ cause: 'list failed' });
			return Ok(answer);
		},
		async read(paths) {
			log.reads.push([...paths]);
			await Promise.resolve();
			const answer = new Map<string, Result<Fetched, ReadError>>(
				paths.map((path) => {
					const failure = control.failRead.get(path);
					if (failure !== undefined) return [path, Err(failure)] as const;
					const file = files.get(path);
					const fetched: Fetched =
						file === undefined
							? null
							: {
									bytes: file.bytes.slice(),
									stamp: file.stamp,
								};
					return [path, Ok(fetched)] as const;
				}),
			);
			await control.readGate;
			return answer;
		},
		async put(path, bytes, expect) {
			if (control.closed) throw new Error('put after close');
			log.puts.push({ path });
			await control.putGate;
			control.beforePut?.(path);
			const current = files.get(path)?.bytes;
			if (
				expect === 'absent'
					? current !== undefined
					: expect !== undefined &&
						(current === undefined ||
							current.length !== expect.length ||
							current.some((byte, index) => byte !== expect[index]))
			)
				return SaveError.Changed({ path });
			const failure = control.failPut.get(path);
			if (failure !== undefined) return Err(failure);
			if (bytes === null) {
				files.delete(path);
				return Ok(null);
			}
			const placed = place(path, bytes);
			return Ok({ stamp: placed.stamp });
		},
		hints(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close() {
			control.closed = true;
		},
	};

	return {
		storage,
		log,
		control,
		hint(paths: readonly string[] | null) {
			for (const listener of listeners) listener(paths);
		},
		text: (path: string) => {
			const file = files.get(path);
			return file === undefined
				? undefined
				: new TextDecoder().decode(file.bytes);
		},
		/** Another writer: change the file and announce the path. */
		outside(path: string, data: string | null, { hint = true } = {}) {
			if (data === null) files.delete(path);
			else place(path, data);
			if (hint) for (const listener of listeners) listener([path]);
		},
	};
}

/** Let microtasks and zero-delay timers run. */
export async function tick(ms = 0) {
	await new Promise((resolve) => setTimeout(resolve, ms));
	await Promise.resolve();
}

/** Wait for a condition that is expected to become true asynchronously. */
export async function until(
	check: () => boolean,
	{ timeout = 1000 }: { timeout?: number } = {},
) {
	const deadline = Date.now() + timeout;
	while (!check() && Date.now() < deadline) await tick(2);
	if (!check())
		throw new Error(`Condition did not become true within ${timeout} ms`);
}
