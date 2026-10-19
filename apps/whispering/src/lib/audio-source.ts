/**
 * The audio a player holds, identified by the bytes it was made from.
 *
 * A player keeps a Blob, so it goes stale when the file is replaced. Size and
 * modification time cannot say whether that happened: a replacement can have
 * the same length. The bytes' hash can, so a reload compares versions and
 * hands back the same object when the bytes are the same, which lets a player
 * keep playing instead of restarting.
 */
import type { FolderFiles } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from './audio-format.js';
import { readBytes } from './files.js';

export type LoadedAudio = {
	readonly path: string;
	readonly sha256: string;
	readonly blob: Blob;
};

async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Read the audio at `path` as it is now. Returns `current` itself when it
 * already holds exactly these bytes for this path.
 */
export async function loadAudio(
	files: Pick<FolderFiles, 'read'>,
	path: string,
	current: LoadedAudio | undefined,
): Promise<Result<LoadedAudio, { readonly message: string }>> {
	const { data: bytes, error } = await readBytes({ files }, path);
	if (error !== null) return Err({ message: error });
	const sha256 = await hashBytes(bytes);
	if (
		current !== undefined &&
		current.path === path &&
		current.sha256 === sha256
	)
		return Ok(current);
	return Ok({
		path,
		sha256,
		// The folder returns untyped bytes; a player needs the container's type.
		blob: new Blob([bytes as Uint8Array<ArrayBuffer>], {
			type: audioMimeTypeOf(path) ?? '',
		}),
	});
}
