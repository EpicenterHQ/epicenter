/**
 * A desktop page's folder storage: each method one command of the folder
 * plugin (ADR-0581), which the shell answers over the directory it granted
 * this window as `scope` (`grant_directory`).
 *
 * The shell checks every path as the Bun directory storage does
 * (`directory-store.ts`): literal names, no link followed, `.git` never
 * named. It stages a put's bytes and renames them over the path, checking
 * what the page expects there under the folder's save lock, so the page
 * makes one call per method. A refusal or a failure comes back named as a
 * `FileError`; a failure the shell reports changed nothing.
 *
 * A reply that never arrived (the call rejects with anything else) may hide
 * a change that landed. A lost put of bytes is `Unconfirmed`. A lost
 * removal, of a file or a directory, is checked once: done if no entry is
 * at the path now, however it went, and otherwise `Unconfirmed` for a file
 * and `Io` for a directory. Any other lost reply is `Io`.
 */
import { invoke } from '@tauri-apps/api/core';
import { Ok, type Result } from 'wellcrafted/result';
import type { HostFiles } from './boundary.js';
import { FileError } from './errors.js';
import { hashBytes } from './hash.js';
import {
	commands,
	type PutOutcome,
	type StorageError,
} from './native/bindings.gen.js';

const ANSWERS = new Set<string>([
	'InvalidPath',
	'NotFound',
	'NotAFile',
	'NotADirectory',
	'DirectoryNotEmpty',
	'Io',
] satisfies StorageError['name'][]);

/** Whether `value` is the shell's answer, rather than a reply that was lost. */
function isAnswer(value: unknown): value is StorageError {
	return (
		typeof value === 'object' &&
		value !== null &&
		ANSWERS.has((value as { name?: unknown }).name as string)
	);
}

/** The shell's answer as the page's `FileError`. */
function fileError(error: StorageError) {
	switch (error.name) {
		case 'InvalidPath':
			return FileError.InvalidPath({ path: error.path, reason: error.reason });
		case 'NotFound':
			return FileError.NotFound({ path: error.path });
		case 'NotAFile':
			return FileError.NotAFile({ path: error.path });
		case 'NotADirectory':
			return FileError.NotADirectory({ path: error.path });
		case 'DirectoryNotEmpty':
			return FileError.DirectoryNotEmpty({ path: error.path });
		case 'Io':
			return FileError.Io({
				path: error.path,
				operation: error.operation,
				cause: error.message,
			});
	}
}

/**
 * A generated command's value, or its refusal: the shell's answer, or text
 * Tauri sends when the command could not run. A lost reply is `Io`.
 */
async function answered<T>(
	call: () => Promise<
		{ data: T; error: null } | { data: null; error: StorageError }
	>,
	path: string,
	operation: string,
): Promise<Result<T, FileError>> {
	try {
		const { data, error } = await call();
		if (error === null) return Ok(data);
		if (isAnswer(error)) return fileError(error);
		return FileError.Io({ path, operation, cause: error });
	} catch (cause) {
		return FileError.Io({ path, operation, cause });
	}
}

/** The folder plugin's storage commands for the folder granted as `scope`. */
export function tauriHostFiles(scope: string): HostFiles {
	/** Whether no entry is at `path` now, or `undefined` if that is unknown. */
	async function absent(path: string): Promise<boolean | undefined> {
		const at = path.lastIndexOf('/');
		const { data, error } = await answered(
			() => commands.readFolderChildren(scope, path.slice(0, Math.max(at, 0))),
			path,
			'list',
		);
		if (error?.name === 'NotFound') return true;
		if (error !== null) return undefined;
		const name = path.slice(at + 1);
		return !data.files.includes(name) && !data.directories.includes(name);
	}

	return {
		list: () => answered(() => commands.listFolder(scope), '', 'list'),
		children: (directory) =>
			answered(
				() => commands.readFolderChildren(scope, directory),
				directory,
				'list',
			),
		async read(path) {
			let bytes: Uint8Array;
			try {
				// The bytes come back as a raw response, an `ArrayBuffer`, which
				// the generated bindings cannot type, so the command is invoked
				// by name.
				bytes = new Uint8Array(
					await invoke<ArrayBuffer>(
						'plugin:epicenter-folder|read_folder_file',
						{
							scope,
							path,
						},
					),
				);
			} catch (cause) {
				if (isAnswer(cause)) return fileError(cause);
				return FileError.Io({ path, operation: 'read', cause });
			}
			return Ok({ bytes, sha256: await hashBytes(bytes) });
		},
		async change(path, bytes, ifMatch) {
			const headers: Record<string, string> = {
				scope: encodeURIComponent(scope),
				path: encodeURIComponent(path),
				remove: String(bytes === null),
			};
			if (ifMatch !== null) headers['if-match'] = encodeURIComponent(ifMatch);
			try {
				// The bytes go as the raw request body rather than as a JSON
				// array of numbers, which the generated bindings cannot type, so
				// the command is invoked by name.
				return Ok(
					await invoke<PutOutcome>(
						'plugin:epicenter-folder|put_folder_file',
						bytes ?? new Uint8Array(),
						{ headers },
					),
				);
			} catch (cause) {
				if (isAnswer(cause)) return fileError(cause);
				if (bytes === null && (await absent(path))) return Ok('landed');
				return FileError.Unconfirmed({
					path,
					operation: bytes === null ? 'remove' : 'write',
					cause,
				});
			}
		},
		mkdir: (path) =>
			answered(
				() => commands.makeFolderDirectory(scope, path),
				path,
				'create directory',
			).then((made) => (made.error === null ? Ok(undefined) : made)),
		async rmdir(path) {
			let lost: unknown;
			try {
				const { error } = await commands.removeFolderDirectory(scope, path);
				if (error === null) return Ok(undefined);
				if (isAnswer(error)) return fileError(error);
				lost = error;
			} catch (cause) {
				lost = cause;
			}
			if (await absent(path)) return Ok(undefined);
			return FileError.Io({ path, operation: 'remove directory', cause: lost });
		},
	};
}
