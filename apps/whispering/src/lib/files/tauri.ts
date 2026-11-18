/**
 * `Files` on the desktop: the folder at the absolute path `dir` (or the
 * path it answers, asked once, with the first operation), through five of
 * Whispering's own commands in its shell (`src-tauri/src/files.rs`). The
 * page holds none of `@tauri-apps/plugin-fs`'s commands.
 *
 * Each command checks the folder against the app's grant (the default
 * folder, or the one the person picked in the folder dialog) and the path
 * against the plain-name rule, and refuses a symbolic link. Reads answer
 * raw bytes, not JSON: `files_read_many` answers one buffer holding a
 * count, each path's length in the order asked (or a marker for a missing
 * file), then the bytes. `files_write` sends its bytes as the request's
 * body; the shell stages them in `local/.tmp/` and renames them into the
 * folder, so the folder only ever holds finished files (ADR-0894).
 */
import { Ok, type Result } from 'wellcrafted/result';
import {
	checkPath,
	type Entry,
	type Files,
	type FilesError,
	failed,
	messageOf,
} from './files.js';

/** How the page calls its shell: `invoke` from `@tauri-apps/api/core`, or a stand-in in a test. */
export type Invoke = (
	command: string,
	args?: Record<string, unknown> | Uint8Array,
	options?: { headers: Record<string, string> },
) => Promise<unknown>;

const tauriInvoke: Invoke = async (command, args, options) => {
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke(command, args, options);
};

/** The marker `files_read_many` answers in place of a missing file's length. */
const MISSING = 0xffff_ffff;

/** A refusal the shell answered, as `FilesError`; anything else is `Io`. */
function fromShell(cause: unknown): FilesError {
	if (typeof cause === 'object' && cause !== null && 'name' in cause) {
		const { name, message } = cause as { name: unknown; message: unknown };
		if (name === 'NotFound' || name === 'Refused' || name === 'Io')
			return { name, message: String(message) };
	}
	return { name: 'Io', message: messageOf(cause) };
}

/** The bytes an answer holds: an `ArrayBuffer`, a typed array, or a list of numbers. */
function bytesOf(answer: unknown): Uint8Array {
	if (answer instanceof ArrayBuffer) return new Uint8Array(answer);
	if (ArrayBuffer.isView(answer))
		return new Uint8Array(answer.buffer, answer.byteOffset, answer.byteLength);
	if (Array.isArray(answer)) return Uint8Array.from(answer as number[]);
	throw new Error('The shell answered something other than bytes');
}

/** `files_read_many`'s buffer, read back into each present path's bytes. */
export function readManyAnswer(
	paths: readonly string[],
	buffer: Uint8Array,
): Map<string, Uint8Array> {
	const view = new DataView(
		buffer.buffer,
		buffer.byteOffset,
		buffer.byteLength,
	);
	const count = view.getUint32(0, true);
	if (count !== paths.length)
		throw new Error(`Asked for ${paths.length} files, answered ${count}`);
	let at = 4 + 4 * count;
	const read = new Map<string, Uint8Array>();
	for (const [index, path] of paths.entries()) {
		const length = view.getUint32(4 + 4 * index, true);
		if (length === MISSING) continue;
		read.set(path, buffer.slice(at, at + length));
		at += length;
	}
	if (at !== buffer.byteLength)
		throw new Error('The shell answered more bytes than it listed');
	return read;
}

export function tauriFiles(
	dir: string | (() => Promise<string>),
	invoke: Invoke = tauriInvoke,
): Files {
	let root: Promise<string> | undefined;
	const folder = () =>
		(root ??= typeof dir === 'string' ? Promise.resolve(dir) : dir());

	/** Call `command`, answering its refusal as `FilesError`. */
	async function call<T>(
		command: string,
		args: Record<string, unknown> | Uint8Array,
		options?: { headers: Record<string, string> },
	): Promise<Result<T, FilesError>> {
		try {
			return Ok((await invoke(command, args, options)) as T);
		} catch (cause) {
			return { data: null, error: fromShell(cause) };
		}
	}

	return {
		async read(path) {
			const checked = checkPath(path);
			if (checked.error !== null) return checked;
			const answer = await call<unknown>('files_read', {
				folder: await folder(),
				path,
			});
			if (answer.error?.name === 'NotFound') return Ok(null);
			if (answer.error !== null) return answer;
			return Ok(bytesOf(answer.data));
		},
		async readMany(paths) {
			for (const path of paths) {
				const checked = checkPath(path);
				if (checked.error !== null) return checked;
			}
			if (paths.length === 0) return Ok(new Map());
			const answer = await call<unknown>('files_read_many', {
				folder: await folder(),
				paths,
			});
			if (answer.error !== null) return answer;
			try {
				return Ok(readManyAnswer(paths, bytesOf(answer.data)));
			} catch (cause) {
				return failed(`Could not read the notes: ${messageOf(cause)}`);
			}
		},
		async write(path, bytes) {
			const checked = checkPath(path);
			if (checked.error !== null) return checked;
			const answer = await call<null>('files_write', bytes, {
				headers: {
					'x-folder': encodeURIComponent(await folder()),
					'x-path': encodeURIComponent(path),
				},
			});
			if (answer.error !== null) return answer;
			return Ok(undefined);
		},
		async list(dir) {
			const checked = checkPath(dir, { directory: true });
			if (checked.error !== null) return checked;
			return call<Entry[]>('files_list', { folder: await folder(), dir });
		},
		async remove(path) {
			const checked = checkPath(path);
			if (checked.error !== null) return checked;
			const answer = await call<null>('files_remove', {
				folder: await folder(),
				path,
			});
			if (answer.error !== null) return answer;
			return Ok(undefined);
		},
	};
}
