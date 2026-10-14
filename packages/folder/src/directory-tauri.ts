/**
 * Directory primitives for a desktop page whose folder the shell granted
 * (`grant_directory`).
 */
import { lstat, readDir, readFile } from '@tauri-apps/plugin-fs';
import type { DirectoryPrimitives, EntryKind } from './directory-handle.js';
import { commands } from './native/bindings.gen.js';

const kindOf = (entry: {
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly isSymlink: boolean;
}): EntryKind =>
	entry.isSymlink
		? 'link'
		: entry.isFile
			? 'file'
			: entry.isDirectory
				? 'directory'
				: 'other';

/**
 * Whether a plugin error says the path is missing. The plugin reports the
 * operating system's message as text; ENOENT is error 2 everywhere, and
 * Windows reports a missing parent as error 3.
 */
function isMissing(cause: unknown): boolean {
	const text = cause instanceof Error ? cause.message : String(cause);
	return /\(os error [23]\)/.test(text);
}

/**
 * Whether the plugin refused a path its scope does not reach. Its check
 * follows links, so a link inside the folder that points outside it is
 * refused rather than described.
 */
function isForbidden(cause: unknown): boolean {
	const text = cause instanceof Error ? cause.message : String(cause);
	return /forbidden path/i.test(text);
}

/**
 * Directory primitives for the folder the shell granted as `scope`. Reads go
 * through the fs plugin, whose scope reaches the granted root. Changes go
 * through the folder plugin's own commands, which check the whole path on
 * disk before changing anything, so no link in the folder can carry a write
 * outside it.
 */
export function tauriDirectoryPrimitives(scope: string): DirectoryPrimitives {
	const changed = async (
		reply: Promise<{ data: null; error: null } | { data: null; error: string }>,
	) => {
		const { error } = await reply;
		if (error !== null) throw new Error(error);
	};
	return {
		async readDir(path) {
			const entries = await readDir(path);
			return entries.map((entry) => ({
				name: entry.name,
				kind: kindOf(entry),
			}));
		},
		async lstat(path) {
			try {
				const info = await lstat(path);
				return {
					kind: kindOf(info),
					size: info.size,
					...(info.mode === null ? {} : { mode: info.mode }),
				};
			} catch (cause) {
				if (isMissing(cause)) return undefined;
				// Listed and never followed, as a link is.
				if (isForbidden(cause)) return { kind: 'other', size: 0 };
				throw cause;
			}
		},
		readFile: (path) => readFile(path),
		writeFile: (path, bytes, options) =>
			changed(
				commands.writeFolderFile(
					scope,
					path,
					Array.from(bytes),
					options?.createNew === true,
				),
			),
		rename: (from, to) => changed(commands.renameFolderPath(scope, from, to)),
		remove: (path, options) =>
			changed(
				commands.removeFolderPath(scope, path, options?.recursive === true),
			),
		mkdir: (path) => changed(commands.makeFolderDirectory(scope, path)),
	};
}
