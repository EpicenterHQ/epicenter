/**
 * Directory primitives for a desktop page whose folder the shell granted
 * (`grant_directory`).
 */
import { invoke } from '@tauri-apps/api/core';
import { lstat, readDir, readFile } from '@tauri-apps/plugin-fs';
import type { DirectoryPrimitives, EntryKind } from './directory-handle.js';
import { UnconfirmedWrite } from './errors.js';
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
 *
 * A change the shell refused rejects with its reason. A change whose reply
 * was lost (the generated command throws instead of returning a refusal)
 * may have happened or may still: a removal is checked once, and resolves
 * if the path is gone, however it went, or rejects with `UnconfirmedWrite`
 * if it is still there. A lost write or rename reply rejects as it is; file
 * storage reports the write it was publishing as `Unconfirmed`.
 */
export function tauriDirectoryPrimitives(scope: string): DirectoryPrimitives {
	const changed = async (
		reply: Promise<{ data: null; error: null } | { data: null; error: string }>,
	) => {
		const { error } = await reply;
		if (error !== null) throw new Error(error);
	};
	async function stat(path: string) {
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
			if (isForbidden(cause)) return { kind: 'other' as const, size: 0 };
			throw cause;
		}
	}
	return {
		async readDir(path) {
			const entries = await readDir(path);
			return entries.map((entry) => ({
				name: entry.name,
				kind: kindOf(entry),
			}));
		},
		lstat: stat,
		readFile: (path) => readFile(path),
		// The bytes go as the raw request body, as the fs plugin's
		// `writeFile` sends them, rather than as a JSON array of numbers; the
		// generated bindings cannot type that, so the command is invoked by
		// name. A refusal rejects with the shell's text, a lost reply with
		// an `Error`, as the generated commands treat them.
		writeFile: (path, bytes, options) =>
			invoke('plugin:epicenter-folder|write_folder_file', bytes, {
				headers: {
					scope: encodeURIComponent(scope),
					path: encodeURIComponent(path),
					'create-new': String(options?.createNew === true),
				},
			}).then(
				() => {},
				(cause: unknown) => {
					if (cause instanceof Error) throw cause;
					throw new Error(String(cause));
				},
			),
		rename: (from, to) => changed(commands.renameFolderPath(scope, from, to)),
		async remove(path, options) {
			let reply: Awaited<ReturnType<typeof commands.removeFolderPath>>;
			try {
				reply = await commands.removeFolderPath(
					scope,
					path,
					options?.recursive === true,
				);
			} catch (lost) {
				const gone = await stat(path).then(
					(found) => found === undefined,
					() => false,
				);
				if (gone) return;
				throw new UnconfirmedWrite(path, lost, 'removed');
			}
			if (reply.error !== null) throw new Error(reply.error);
		},
		mkdir: (path) => changed(commands.makeFolderDirectory(scope, path)),
	};
}
