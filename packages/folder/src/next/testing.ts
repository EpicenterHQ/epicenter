/**
 * `@epicenter/folder/next/testing`: a folder over memory, for tests of the
 * folder and of what is built on it. `memoryHost` is a `FolderHost` a test
 * can write behind, delay, and break.
 */
import { Err, Ok } from 'wellcrafted/result';
import { ReadError, type SaveError } from '../shared/errors.js';
import type { Expected, Fetched, FolderHost, Listed } from './storage.js';

export { createFolder } from './folder.js';

const encoder = new TextEncoder();

type StorageLog = {
	lists: number;
	reads: string[][];
	puts: { path: string; expected: Expected }[];
};

type StorageControl = {
	beforePut: ((path: string) => void) | undefined;
	readGate: Promise<void> | undefined;
	listGate: Promise<void> | undefined;
	putGate: Promise<void> | undefined;
	failPut: Map<string, SaveError>;
	listFails: boolean;
	closed: boolean;
};

export function memoryHost(initial: Record<string, string | Uint8Array> = {}) {
	let clock = 0;
	const files = new Map<
		string,
		{ bytes: Uint8Array; version: string; token: string }
	>();
	const listeners = new Set<(paths: readonly string[] | null) => void>();
	const place = (path: string, data: string | Uint8Array) => {
		const bytes = typeof data === 'string' ? encoder.encode(data) : data;
		const stamp = `${++clock}`;
		const file = { bytes, version: `v${stamp}`, token: `t${stamp}` };
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
				[...files].map(([path, file]) => [path, { token: file.token }]),
			);
			await control.listGate;
			if (control.listFails)
				return ReadError.StorageFailed({ cause: 'list failed' });
			return Ok(answer);
		},
		async read(paths) {
			log.reads.push([...paths]);
			await Promise.resolve();
			const answer = new Map(
				paths.map((path) => {
					const file = files.get(path);
					const fetched: Fetched =
						file === undefined
							? null
							: {
									bytes: file.bytes.slice(),
									version: file.version,
									token: file.token,
								};
					return [path, Ok(fetched)] as const;
				}),
			);
			await control.readGate;
			return answer;
		},
		async put(path, bytes, expected) {
			if (control.closed) throw new Error('put after close');
			log.puts.push({ path, expected });
			await control.putGate;
			control.beforePut?.(path);
			const failure = control.failPut.get(path);
			if (failure !== undefined) return Err(failure);
			const current = files.get(path);
			if (expected === 'absent' && current !== undefined) return Ok('stale');
			if (typeof expected === 'object' && current?.version !== expected.version)
				return Ok('stale');
			if (bytes === null) {
				files.delete(path);
				return Ok({ landed: null });
			}
			const placed = place(path, bytes);
			return Ok({ landed: { version: placed.version, token: placed.token } });
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
