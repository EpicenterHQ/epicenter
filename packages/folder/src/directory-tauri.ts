/**
 * Directory primitives for a desktop page whose folder the shell granted
 * (`grant_directory`).
 */
import { invoke } from '@tauri-apps/api/core';
import type { DirectoryPrimitives } from './directory-handle.js';
import { UnconfirmedWrite, UnexpectedTarget } from './errors.js';
import { type ChangeError, commands } from './native/bindings.gen.js';

/** The shell's refusal of a rename or removal at `path`, as an error. */
function changeRefusal(path: string, refusal: ChangeError): Error {
	switch (refusal.name) {
		case 'Conflict':
			return new UnexpectedTarget(path, {
				name: 'Conflict',
				actualSha256: refusal.actualSha256 ?? undefined,
			});
		case 'Exists':
			return new UnexpectedTarget(path, { name: 'Exists' });
		case 'NotFound':
			return new UnexpectedTarget(path, { name: 'NotFound' });
		case 'Failed':
			return new Error(refusal.message);
		default:
			return new Error(String(refusal));
	}
}

/**
 * Directory primitives for the folder the shell granted as `scope`. Reads and
 * changes go through the folder plugin's commands, which check the whole path
 * on disk first: no link on the way to a path can carry a read or a write
 * outside the folder, and a final link is described, never followed.
 *
 * A change the shell refused rejects with its reason. A rename or removal
 * the shell refused because its path did not hold what the page expected
 * rejects with `UnexpectedTarget`, which says what the shell found; the
 * shell checks and changes the path under one lock per folder, which every
 * window's changes share. A removal of a path already gone rejects as
 * `NotFoundError`, as a directory handle's own does.
 *
 * A change whose reply was lost (the generated command throws instead of
 * returning a refusal) may have happened or may still: a removal is checked
 * once, and resolves if the path is gone, however it went, or rejects with
 * `UnconfirmedWrite` if it is still there. A lost write or rename reply
 * rejects as it is; file storage reports the write it was publishing as
 * `Unconfirmed`.
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
		async rename(from, to, expected) {
			const reply = await commands.renameFolderPath(scope, from, to, expected);
			if (reply.error !== null) throw changeRefusal(to, reply.error);
		},
		async remove(path, options) {
			let reply: Awaited<ReturnType<typeof commands.removeFolderPath>>;
			try {
				reply = await commands.removeFolderPath(
					scope,
					path,
					options?.recursive === true,
					options?.expected ?? 'any',
				);
			} catch (lost) {
				const gone = await stat(path).then(
					(found) => found === undefined,
					() => false,
				);
				if (gone) return;
				throw new UnconfirmedWrite(path, lost, 'removed');
			}
			if (reply.error?.name === 'NotFound')
				throw new DOMException(`'${path}' does not exist`, 'NotFoundError');
			if (reply.error !== null) throw changeRefusal(path, reply.error);
		},
		mkdir: (path) => changed(commands.makeFolderDirectory(scope, path)),
	};
}
