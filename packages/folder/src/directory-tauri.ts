/**
 * Directory primitives for a desktop page whose folder the shell granted
 * (`grant_directory`).
 */
import { invoke } from '@tauri-apps/api/core';
import type { DirectoryPrimitives } from './directory-handle.js';
import { UnconfirmedWrite } from './errors.js';
import { commands } from './native/bindings.gen.js';

/**
 * Directory primitives for the folder the shell granted as `scope`. Reads and
 * changes go through the folder plugin's commands, which check the whole path
 * on disk first: no link on the way to a path can carry a read or a write
 * outside the folder, and a final link is described, never followed.
 *
 * A change the shell refused rejects with its reason. A change whose reply
 * was lost (the generated command throws instead of returning a refusal)
 * may have happened or may still: a removal is checked once, and resolves
 * if the path is gone, however it went, or rejects with `UnconfirmedWrite`
 * if it is still there. A lost write or rename reply rejects as it is; file
 * storage reports the write it was publishing as `Unconfirmed`.
 */
export function tauriDirectoryPrimitives(scope: string): DirectoryPrimitives {
	/** A generated command's value, or its refusal as an `Error`. */
	const answer = async <T>(
		reply: Promise<{ data: T; error: null } | { data: null; error: string }>,
	): Promise<T> => {
		const result = await reply;
		if (result.error !== null) throw new Error(result.error);
		return result.data;
	};
	const changed = (
		reply: Promise<{ data: null; error: null } | { data: null; error: string }>,
	) => answer(reply).then(() => {});
	/**
	 * A command invoked by name rejects with the shell's text when refused and
	 * with an `Error` when its reply was lost, as the generated commands treat
	 * them.
	 */
	const rejected = (cause: unknown): never => {
		if (cause instanceof Error) throw cause;
		throw new Error(String(cause));
	};
	async function stat(path: string) {
		const info = await answer(commands.statFolderPath(scope, path));
		if (info === null) return undefined;
		return {
			kind: info.kind,
			size: info.size,
			...(info.mode === null ? {} : { mode: info.mode }),
		};
	}
	return {
		readDir: (path) => answer(commands.readFolderDirectory(scope, path)),
		lstat: stat,
		// The bytes come back as a raw response, an `ArrayBuffer`, rather than
		// as a JSON array of numbers; the generated bindings cannot type that,
		// so the command is invoked by name.
		readFile: (path) =>
			invoke<ArrayBuffer>('plugin:epicenter-folder|read_folder_file', {
				scope,
				path,
			}).then((bytes) => new Uint8Array(bytes), rejected),
		// The bytes go as the raw request body rather than as a JSON array
		// of numbers; the generated bindings cannot type that, so the command
		// is invoked by name.
		writeFile: (path, bytes, options) =>
			invoke('plugin:epicenter-folder|write_folder_file', bytes, {
				headers: {
					scope: encodeURIComponent(scope),
					path: encodeURIComponent(path),
					'create-new': String(options?.createNew === true),
				},
			}).then(() => {}, rejected),
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
