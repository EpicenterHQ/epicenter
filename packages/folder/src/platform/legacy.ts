/**
 * Importing a folder an older build synced (ADR-0822): it kept its manifest
 * inside it, at `.epicenter/synced.json`, `{ folder, root, commit, files }`,
 * `root` being the directory's device and inode when it last synced. Once,
 * the manifest becomes the folder's record at the Epicenter folder's root
 * when its recorded inode is this directory's (the directory it synced in);
 * otherwise the folder is unbound, as any copy is. Then its `synced.json`
 * and `hashes.json` go.
 *
 * A recording an older build left in `.epicenter/recordings/` is recovered
 * before this runs, by the program that opened the folder (the desktop
 * shell at each open, `tidyLegacy` in Bun): moved beside its final path
 * under a recording's reserved name, which its recorder recovers. Nothing
 * here deletes a recording.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Store, Unavailable } from '../device/store.js';
import { LEGACY_HASHES, LEGACY_MANIFEST } from '../state.js';
import type { LocalFolder } from './epicenter-folder.js';
import type { Records } from './records.js';

const decoder = new TextDecoder();

/** What importing a folder's old manifest did. */
export type Imported = 'none' | 'record' | 'unbound';

/** Remove the file at `path` in `store`, if it is there. */
async function remove(store: Store, path: string) {
	const read = await store.read([path]);
	if (read.error !== null) return read;
	const [file] = read.data;
	if (file === undefined || 'gone' in file) return Ok(null);
	const removed = await store.put(path, null, file.version);
	if (removed.error?.name === 'Unavailable') return Err(removed.error);
	return Ok(null);
}

/**
 * Import the manifest `local` kept inside it, once: a record when its
 * recorded inode is the directory's now, and nothing otherwise. Then its
 * manifest and hash cache are removed.
 */
export async function importLegacy({
	local,
	records,
}: {
	local: LocalFolder;
	records: Records;
}): Promise<Result<Imported, Unavailable>> {
	const read = await local.store.read([LEGACY_MANIFEST, LEGACY_HASHES]);
	if (read.error !== null) return read;
	const [file, cache] = read.data;
	if (
		(file === undefined || 'gone' in file) &&
		(cache === undefined || 'gone' in cache)
	)
		return Ok('none');
	let imported: Imported = 'none';
	if (file !== undefined && !('gone' in file)) {
		imported = 'unbound';
		let manifest: {
			folder?: unknown;
			root?: { inode?: unknown };
			commit?: unknown;
			files?: unknown;
		} | null = null;
		try {
			manifest = JSON.parse(decoder.decode(file.bytes));
		} catch {}
		const identity = local.identity;
		if (
			manifest !== null &&
			typeof manifest.folder === 'string' &&
			identity !== null &&
			manifest.root?.inode === identity.inode &&
			typeof manifest.files === 'object' &&
			manifest.files !== null
		) {
			const written = await records.write(
				{
					folder: manifest.folder,
					name: local.name,
					inode: identity.inode,
					birthtime: identity.birthtime,
					cursor: null,
					files: manifest.files as Record<string, never>,
				},
				null,
			);
			if (written.error !== null) return written;
			// A record already there for that folder stands: this one is unbound.
			if (written.data !== 'moved') imported = 'record';
		}
		const removed = await remove(local.store, LEGACY_MANIFEST);
		if (removed.error !== null) return removed;
	}
	const hashes = await remove(local.store, LEGACY_HASHES);
	if (hashes.error !== null) return hashes;
	return Ok(imported);
}
