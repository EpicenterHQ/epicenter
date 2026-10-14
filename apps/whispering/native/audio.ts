/**
 * Reads one saved audio file for transcription, straight from the data folder.
 *
 * The page's folder engine, in the directory the desktop shell grants it, is
 * the only thing that opens the folder. This reads a file out of the same
 * directory the way any other program would: it takes no lock, writes
 * nothing, and knows nothing of Git, history, or the folder's engine. The host uses it for one thing, which is sending the audio a
 * recording names to the transcription endpoint without carrying the bytes
 * through the page.
 *
 * The path is a literal folder-relative path, checked by the folder's own
 * rule and refused with the folder's own errors. Every component must be
 * spelled exactly as its directory lists it, so a case-insensitive filesystem
 * cannot alias another name. No component may be a symbolic link, every
 * component before the last must be a directory, and the last must be a
 * regular file. The file is opened once without following a link, checked
 * again through the open handle, read into bytes this process owns, and
 * closed. A later change to the path does not change what was read.
 *
 * This is best effort against a program writing the folder at the same time,
 * as every read of a shared directory is. Each component is checked and then
 * used in separate steps, so a writer that swaps a directory on the way for a
 * link between its check and the open is followed. Opening without following
 * a link protects the last component only. What is read is whatever the path
 * held at that moment; no version is asked for and none is returned.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FileError, pathProblem } from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';

const codeOf = (cause: unknown) =>
	(cause as { code?: string } | undefined)?.code;

/** Absent where the platform has no such flag; the checks around the open still apply. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
/** So opening something that is not a regular file can never wait for a writer. */
const NON_BLOCKING = constants.O_NONBLOCK ?? 0;

export async function readAudio(
	root: string,
	path: string,
): Promise<Result<Uint8Array<ArrayBuffer>, FileError>> {
	const problem = pathProblem(path);
	if (problem !== undefined)
		return FileError.InvalidPath({ path, reason: problem });

	const parts = path.split('/');
	let current = root;
	for (const [index, name] of parts.entries()) {
		let names: string[];
		try {
			names = await readdir(current);
		} catch (cause) {
			if (codeOf(cause) === 'ENOENT') return FileError.NotFound({ path });
			if (codeOf(cause) === 'ENOTDIR')
				return FileError.NotADirectory({
					path: parts.slice(0, index).join('/'),
				});
			return FileError.Io({ path, operation: 'list the directory of', cause });
		}
		if (!names.includes(name)) return FileError.NotFound({ path });
		current = join(current, name);
		let stats: Awaited<ReturnType<typeof lstat>>;
		try {
			stats = await lstat(current);
		} catch (cause) {
			if (codeOf(cause) === 'ENOENT') return FileError.NotFound({ path });
			return FileError.Io({ path, operation: 'inspect', cause });
		}
		if (stats.isSymbolicLink())
			return FileError.InvalidPath({
				path,
				reason: 'the path passes through a symbolic link',
			});
		if (index < parts.length - 1) {
			if (!stats.isDirectory())
				return FileError.NotADirectory({
					path: parts.slice(0, index + 1).join('/'),
				});
			continue;
		}
		if (stats.isDirectory()) return FileError.NotAFile({ path });
		if (!stats.isFile())
			return FileError.InvalidPath({
				path,
				reason: 'the path is not a regular file',
			});
	}

	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(current, constants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
	} catch (cause) {
		// A link put there after the check above is refused, not followed.
		if (codeOf(cause) === 'ELOOP')
			return FileError.InvalidPath({
				path,
				reason: 'the path passes through a symbolic link',
			});
		if (codeOf(cause) === 'ENOENT') return FileError.NotFound({ path });
		return FileError.Io({ path, operation: 'open', cause });
	}
	try {
		// What was opened, not what the path names now.
		if (!(await handle.stat()).isFile())
			return FileError.InvalidPath({
				path,
				reason: 'the path is not a regular file',
			});
		return Ok(new Uint8Array(await handle.readFile()));
	} catch (cause) {
		return FileError.Io({ path, operation: 'read', cause });
	} finally {
		await handle.close().catch(() => {});
	}
}
