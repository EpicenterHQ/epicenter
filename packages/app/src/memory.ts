/**
 * A context held in memory, for testing an action without a computer:
 *
 * ```ts
 * const context = createMemoryContext({ '2026.csv': 'day,minutes\n' });
 * await inRun(context, () => app.actions.log({ minutes: 30 }));
 * expect(await context.folder.read('2026.csv')).toContain('30');
 * ```
 *
 * The folder has no `path`; an action that needs one runs only on a computer.
 * There is no Git: a test checks the folder's files, not commits.
 */
import { type Folder, normalizePath, type Secrets } from './context.ts';

function createMemoryFolder(
	files: Readonly<Record<string, string | Uint8Array>>,
): Folder {
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

/** A folder seeded with `files`, and empty secrets. */
export function createMemoryContext(
	files: Readonly<Record<string, string | Uint8Array>> = {},
): { folder: Folder; secrets: Secrets } {
	return {
		folder: createMemoryFolder(files),
		secrets: createMemorySecrets(),
	};
}
