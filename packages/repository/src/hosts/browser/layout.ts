/**
 * The replica layout in this origin's private storage:
 *
 *   .epicenter/replicas/<replicaId>/
 *     manifest.json   which repository, its display name, the account (null: a guest's), the server (null: none yet)
 *     sqlite/         the opfs-sahpool VFS's directory, which it alone owns (it deletes it whole on removeVfs)
 *     objects/<oid>   sealed blob bytes
 *     removing        present while a removal is unfinished
 *
 * The manifest is a rebuildable descriptor, read to list replicas without
 * opening them; the database is authoritative and refuses a binding that
 * does not match it. There is no registry file: the replicas are the
 * directories. One tab at a time owns a replica, by holding its Web Lock.
 *
 * A removal is recoverable: mark it (`removing`), close, delete the
 * contents, delete the root. Each step leaves a state the next startup can
 * finish, so a tab closed midway never leaves a half-removed replica that
 * looks whole: one with the marker is never listed or opened, and listing
 * finishes it once no tab holds its lock.
 */
import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';
import { directoryIn, entriesOf, fileIn, writeWhole } from './opfs.js';

/** A replica id becomes a directory, a VFS name and a lock name. */
export const REPLICA_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The Web Lock a tab holds while its worker may hold the replica's storage. */
export const replicaLock = (replica: string) => `epicenter:replica:${replica}`;

/** The opfs-sahpool directory of a replica, from the origin's root. */
export const sqliteDirectory = (replica: string) => `.epicenter/replicas/${replica}/sqlite`;

export const SQLITE = 'sqlite';
export const OBJECTS = 'objects';
const MANIFEST = 'manifest.json';
const REMOVING = 'removing';

const ManifestSchema = Type.Object(
	{
		replica: Type.String({ pattern: REPLICA_ID.source }),
		repository: Type.String(),
		name: Type.String(),
		account: Type.Union([Type.String(), Type.Null()]),
		server: Type.Union([Type.String(), Type.Null()]),
	},
	{ additionalProperties: false },
);

/** What a replica's manifest says. */
export type Manifest = Static<typeof ManifestSchema>;

/** `.epicenter/replicas`, created when missing. */
export async function replicasDirectory() {
	const root = await navigator.storage.getDirectory();
	const epicenter = await root.getDirectoryHandle('.epicenter', { create: true });
	return epicenter.getDirectoryHandle('replicas', { create: true });
}

/** A replica's root directory, or null when there is none; `create` makes it. */
export async function replicaDirectory(replica: string, { create = false } = {}) {
	if (!REPLICA_ID.test(replica)) return null;
	const replicas = await replicasDirectory();
	return create ? replicas.getDirectoryHandle(replica, { create: true }) : directoryIn(replicas, replica);
}

/** Whether a replica's removal has begun and not finished. */
async function isRemoving(root: FileSystemDirectoryHandle) {
	return (await fileIn(root, REMOVING)) !== null;
}

/** The manifest in `root`, or null when it is missing, unreadable, or the replica is being removed. */
async function manifestIn(root: FileSystemDirectoryHandle): Promise<Manifest | null> {
	if (await isRemoving(root)) return null;
	const file = await fileIn(root, MANIFEST);
	if (file === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(await file.text());
	} catch {
		return null;
	}
	return Check(ManifestSchema, value) ? value : null;
}

/** A replica's manifest, or null when it has none, or is being removed. */
export async function readManifest(replica: string) {
	const root = await replicaDirectory(replica);
	return root === null ? null : manifestIn(root);
}

/** Write a new replica's manifest, whole or not at all. In the owning worker only. */
export async function writeManifest(manifest: Manifest) {
	const root = await replicaDirectory(manifest.replica, { create: true });
	if (root === null) throw new Error(`'${manifest.replica}' is not a replica id`);
	await writeWhole(root, MANIFEST, new TextEncoder().encode(`${JSON.stringify(manifest, null, '\t')}\n`));
}

/**
 * Delete a replica's files: mark it removing, delete its contents, then its
 * root. The caller holds its lock and has closed it. A failure midway
 * (another worker still letting go of the database) leaves the marker, so
 * the next listing finishes it.
 */
export async function removeReplicaFiles(replica: string) {
	const root = await replicaDirectory(replica);
	if (root === null) return;
	await root.getFileHandle(REMOVING, { create: true });
	for (const [name] of await entriesOf(root)) if (name !== REMOVING) await root.removeEntry(name, { recursive: true });
	await (await replicasDirectory()).removeEntry(replica, { recursive: true });
}

/**
 * Every replica in this origin, from their manifests. A removal left
 * unfinished is finished here when no tab holds that replica's lock, and
 * is never listed.
 */
export async function listReplicas(): Promise<Manifest[]> {
	const replicas = await replicasDirectory();
	const found: Manifest[] = [];
	for (const [name, kind] of await entriesOf(replicas)) {
		if (kind !== 'directory' || !REPLICA_ID.test(name)) continue;
		const root = await replicas.getDirectoryHandle(name);
		if (await isRemoving(root)) {
			await finishRemoval(name);
			continue;
		}
		const manifest = await manifestIn(root);
		if (manifest !== null && manifest.replica === name) found.push(manifest);
	}
	return found;
}

/** Finish an interrupted removal, unless a tab holds the replica (it finishes it later). */
async function finishRemoval(replica: string) {
	await navigator.locks.request(replicaLock(replica), { ifAvailable: true }, async (lock) => {
		if (lock === null) return;
		// A worker that has not let go yet keeps it marked for the next listing.
		await removeReplicaFiles(replica).catch(() => {});
	});
}
