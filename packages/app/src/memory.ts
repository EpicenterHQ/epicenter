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
 * a `.local` file, so a test seeds one as it seeds any other (ADR-0870). Files
 * have no modes here, so a `.local` file's `0600` is the disk's alone.
 */
import { type Context, type Folder, normalizePath } from './context.ts';

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
		// Nothing else writes this folder between the read and the write, so one try is enough.
		async update(path, change) {
			const found = bytes.get(normalizePath(path));
			const text = change(
				found === undefined ? undefined : decoder.decode(found),
			);
			bytes.set(normalizePath(path), encoder.encode(text));
			return text;
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

/** A context whose folder is seeded with `files`. */
export function createMemoryContext(
	files: Readonly<Record<string, string | Uint8Array>> = {},
): Context {
	return { folder: createMemoryFolder(files) };
}
