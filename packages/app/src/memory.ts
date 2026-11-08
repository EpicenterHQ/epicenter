/**
 * A context held in memory, for testing an action without a computer:
 *
 * ```ts
 * const context = createMemoryContext({ '2026.csv': 'day,minutes\n' });
 * await app.actions.log.run({ minutes: 30 }, context);
 * expect(await context.folder.read('2026.csv')).toContain('30');
 * ```
 *
 * The folder and cache have no `path`, and the cache no `sqlite`; an action
 * that needs them runs only on a computer.
 */
import {
	type Cache,
	type Folder,
	normalizePath,
	type Secrets,
} from './context.ts';

function createMemoryFolder(
	files: Readonly<Record<string, string | Uint8Array>>,
): Folder & { clear(): Promise<void> } {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const bytes = new Map<string, Uint8Array>();
	for (const [path, content] of Object.entries(files))
		bytes.set(
			normalizePath(path),
			typeof content === 'string' ? encoder.encode(content) : content,
		);
	return {
		async read(path) {
			const found = bytes.get(normalizePath(path));
			return found === undefined ? undefined : decoder.decode(found);
		},
		async readBytes(path) {
			return bytes.get(normalizePath(path));
		},
		async write(path, text) {
			bytes.set(normalizePath(path), encoder.encode(text));
		},
		async writeBytes(path, content) {
			bytes.set(normalizePath(path), content);
		},
		async list(dir) {
			const prefix = dir === undefined ? '' : `${normalizePath(dir)}/`;
			return [...bytes.keys()].filter((path) => path.startsWith(prefix)).sort();
		},
		async delete(path) {
			bytes.delete(normalizePath(path));
		},
		async clear() {
			bytes.clear();
		},
	};
}

function createMemorySecrets(): Secrets {
	const values = new Map<string, string>();
	return {
		async get(name) {
			return values.get(name);
		},
		async set(name, value) {
			values.set(name, value);
		},
		async delete(name) {
			values.delete(name);
		},
	};
}

/** A folder seeded with `files`, an empty cache, and empty secrets, all in memory. */
export function createMemoryContext(
	files: Readonly<Record<string, string | Uint8Array>> = {},
): { folder: Folder; cache: Cache; secrets: Secrets } {
	const { clear: _, ...folder } = createMemoryFolder(files);
	return {
		folder,
		cache: createMemoryFolder({}),
		secrets: createMemorySecrets(),
	};
}
