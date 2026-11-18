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
 * There is no Git: a test checks the folder's files, not commits. A secret is
 * a file under `local/`, so a test seeds one as it seeds any other. Files
 * have no modes here, so the `0600` of a file under `local/` is the disk's
 * alone.
 */
import { Ok } from 'wellcrafted/result';
import {
	type Context,
	type Folder,
	normalizePath,
	textUpdate,
} from './context.ts';

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
	const edit: Folder['edit'] = async (path, decide) => {
		const key = normalizePath(path);
		const before = bytes.get(key);
		const result = decide(
			before === undefined ? undefined : decoder.decode(before),
		);
		if (result.data === null) return result;
		const { text, value } = result.data;
		if (text !== undefined) bytes.set(key, encoder.encode(text));
		return Ok(value);
	};
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
		edit,
		update: textUpdate(edit),
		async list(dir) {
			const prefix = dir === undefined ? '' : `${normalizePath(dir)}/`;
			return [...bytes.keys()].filter((path) => path.startsWith(prefix)).sort();
		},
		async delete(path) {
			bytes.delete(normalizePath(path));
		},
	};
}

/**
 * A context whose folder is seeded with `files`, and whose home's `.env` holds
 * `env`'s lines, empty unless given.
 */
export function createMemoryContext(
	files: Readonly<Record<string, string | Uint8Array>> = {},
	env: Readonly<Record<string, string>> = {},
): Context {
	return {
		folder: createMemoryFolder(files),
		env: { path: '.env', values: { ...env } },
	};
}
