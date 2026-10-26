/**
 * A desktop page's folder storage: each method one command of the folder
 * plugin (ADR-0581), which the shell answers over the directory it bound to
 * the calling window. No call names a root or a folder.
 *
 * The shell checks every path as the Bun directory storage does
 * (`directory-store.ts`): literal names, no link followed, `.git` never
 * named. It stages a put's bytes and renames them over the path, checking
 * what the page expects there under the folder's save lock, so the page
 * makes one call per method. A refusal or a failure comes back named as a
 * `FileError`; a failure the shell reports changed nothing.
 *
 * An invoke that rejects with anything else did not get the shell's answer.
 * Tauri 2 sends a call again over `postMessage` when its custom-protocol
 * request fails, so a rejection is almost always one the command never ran
 * for: a permission it lacks, an unknown command, arguments it could not
 * read. That cannot be shown from here, and the path's state now is no
 * receipt for the call, so a rejected change (a put, a removal, `mkdir`,
 * `rmdir`) is `Unconfirmed`. A rejected read or listing is `Io`.
 *
 * A call sent again after it landed answers what the second run found: a
 * put whose first run landed answers `stale`, since the path no longer holds
 * what it expected, and the engine's write reads again and finds its own
 * bytes. An unconditional put sent again lands again with the same bytes.
 *
 * A put's expectation travels in its `expected` header: `any`, `absent`,
 * `present`, or the SHA-256 the file there must have.
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
		'name' in value &&
		typeof value.name === 'string' &&
		ANSWERS.has(value.name)
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
 * Tauri sends when the command could not run. Any rejection but the shell's
 * answer is `Io` for a read, and `Unconfirmed` for a change.
 */
async function answered<T>(
	call: () => Promise<
		{ data: T; error: null } | { data: null; error: StorageError }
	>,
	path: string,
	operation: string,
	changes = false,
): Promise<Result<T, FileError>> {
	const unanswered = (cause: unknown) =>
		changes
			? FileError.Unconfirmed({ path, operation, cause })
			: FileError.Io({ path, operation, cause });
	try {
		const { data, error } = await call();
		if (error === null) return Ok(data);
		if (isAnswer(error)) return fileError(error);
		return unanswered(error);
	} catch (cause) {
		return unanswered(cause);
	}
}

/** The folder plugin's storage commands for this window's folder. */
export function tauriHostFiles(): HostFiles {
	return {
		list: () => answered(() => commands.listFolder(), '', 'list'),
		children: (directory) =>
			answered(() => commands.readFolderChildren(directory), directory, 'list'),
		async read(path) {
			let bytes: Uint8Array;
			let stamp: string;
			try {
				// The stamp and bytes come back as one raw `ArrayBuffer`, which
				// the generated bindings cannot type, so the command is invoked
				// by name.
				const response = new Uint8Array(
					await invoke<ArrayBuffer>(
						'plugin:epicenter-folder|read_folder_file',
						{
							path,
						},
					),
				);
				const separator = response.indexOf(0);
				if (separator < 0) throw new Error('The file response has no stamp');
				stamp = new TextDecoder().decode(response.subarray(0, separator));
				bytes = response.subarray(separator + 1);
			} catch (cause) {
				if (isAnswer(cause)) return fileError(cause);
				return FileError.Io({ path, operation: 'read', cause });
			}
			return Ok({ bytes, stamp, sha256: await hashBytes(bytes) });
		},
		async change(path, bytes, expected) {
			const headers = {
				path: encodeURIComponent(path),
				remove: String(bytes === null),
				expected: typeof expected === 'string' ? expected : expected.sha256,
			};
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
				return FileError.Unconfirmed({
					path,
					operation: bytes === null ? 'remove' : 'write',
					cause,
				});
			}
		},
		mkdir: (path) =>
			answered(
				() => commands.makeFolderDirectory(path),
				path,
				'create directory',
				true,
			).then((made) => (made.error === null ? Ok(undefined) : made)),
		rmdir: (path) =>
			answered(
				() => commands.removeFolderDirectory(path),
				path,
				'remove directory',
				true,
			).then((removed) => (removed.error === null ? Ok(undefined) : removed)),
	};
}
