/**
 * Syncing a folder on this computer with its folder on the server, as every
 * surface does it (ADR-0811, ADR-0817): the one sync function
 * (`sync({ local, remote, manifest })`) behind the two questions a first
 * sync asks.
 *
 * - **A copied folder asks before it pushes.** A manifest records the
 *   directory it synced in (`root`: device and inode). A directory whose
 *   manifest names another directory is a copy (a Finder duplicate, a backup
 *   restored elsewhere): it sends nothing until the person answers `new`
 *   (it becomes a new folder) or `same` (it is that folder, moved).
 * - **A first sync joins before it creates.** A folder that never agreed
 *   with the server asks it to join the folder its manifest names, which
 *   it does when the person holds it; otherwise the server makes one. From
 *   an app, it joins the one folder attached to the app, or asks which.
 *
 * `syncEvery` keeps every folder in the Epicenter folder in sync from one
 * request for where every folder is (ADR-0819), as the Epicenter app does
 * while it runs.
 */
import { ClientError, isHiddenPath } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import type { Store, Unavailable } from '../device/store.js';
import { acceptShare, folderHeads, listFolders } from '../remote/folders.js';
import {
	folderRepository,
	joinFolder,
	type RemoteAccount,
} from '../remote/repository.js';
import {
	type Manifest,
	type RootIdentity,
	type SyncReport,
	storeManifest,
	sync,
} from '../sync/sync.js';
import {
	copyOf,
	type EpicenterRoot,
	freeName,
	type LocalFolder,
} from './epicenter-folder.js';

/** How a sync of one folder ended. */
export type FolderSync =
	/** It synced with the folder `folder`; `made` when this sync made it on the server. */
	| { kind: 'synced'; folder: string; made: boolean; report: SyncReport }
	/** It is a copy of the folder `copyOf`, and sent nothing: answer `new` or `same`. */
	| { kind: 'copy'; copyOf: string }
	/** An app's person holds several folders attached to it: name one. */
	| { kind: 'choose'; folders: string[] };

/** A copy's answer: a new folder, or the same folder, moved. */
export type CopyAnswer = 'new' | 'same';

/** Whether `manifest` never agreed with the server: its next sync is a first sync. */
const neverAgreed = (manifest: Manifest) =>
	manifest.commit === null && Object.keys(manifest.files).length === 0;

/**
 * Sync the folder in `store` with its folder on the server, as `account`.
 * `identity` is its directory's now (null where the store has none);
 * `copy` answers the question a copy asks. A first sync joins the folder
 * its manifest names, or makes one, and records it.
 */
export async function syncFolder({
	account,
	store,
	identity,
	copy,
}: {
	account: RemoteAccount;
	store: Store;
	identity: RootIdentity | null;
	copy?: CopyAnswer;
}): Promise<Result<FolderSync, Unavailable>> {
	const saved = storeManifest(store);
	const read = await saved.read();
	if (read.error !== null) return read;
	let { manifest } = read.data;
	const original = JSON.stringify(manifest);
	const copied = copyOf(manifest, identity);
	if (copied !== null) {
		if (copy === undefined) return Ok({ kind: 'copy', copyOf: copied });
		// A new folder starts from nothing agreed: every file is its own.
		manifest =
			copy === 'new'
				? { commit: null, files: {} }
				: { ...manifest, root: identity ?? undefined };
	}
	let made = false;
	if (manifest.folder === undefined || neverAgreed(manifest)) {
		const joined = await joinFolder(account, { folder: manifest.folder });
		if (joined.error !== null) return joined;
		if ('choose' in joined.data)
			return Ok({ kind: 'choose', folders: joined.data.choose });
		made = joined.data.made;
		manifest = { ...manifest, folder: joined.data.folder };
	}
	if (identity !== null && manifest.root === undefined)
		manifest = { ...manifest, root: identity };
	if (JSON.stringify(manifest) !== original) {
		const written = await saved.write(manifest, read.data.version);
		if (written.error !== null) return written;
		if (written.data === 'moved')
			return ClientError.Unavailable({
				cause: 'Another sync of this folder started meanwhile; run it again.',
			});
	}
	const folder = manifest.folder as string;
	const ran = await sync({
		local: store,
		remote: folderRepository(account, folder),
		manifest: saved,
	});
	if (ran.error !== null) return ran;
	return Ok({ kind: 'synced', folder, made, report: ran.data });
}

/**
 * Bring the folder `folder` into `local`: record it in the manifest, then
 * sync, which takes its files (and merges any already there). Refused when
 * `local` already syncs with another folder.
 */
export async function cloneFolder({
	account,
	folder,
	local,
}: {
	account: RemoteAccount;
	folder: string;
	local: LocalFolder;
}): Promise<Result<FolderSync, Unavailable>> {
	const saved = storeManifest(local.store);
	const read = await saved.read();
	if (read.error !== null) return read;
	const { manifest, version } = read.data;
	if (manifest.folder !== undefined && manifest.folder !== folder)
		return ClientError.Unavailable({
			cause: `${local.path} already syncs with ${manifest.folder}; clone into another folder`,
		});
	if (manifest.folder === undefined) {
		const written = await saved.write(
			{
				folder,
				...(local.identity === null ? {} : { root: local.identity }),
				commit: null,
				files: {},
			},
			version,
		);
		if (written.error !== null) return written;
		if (written.data === 'moved')
			return ClientError.Unavailable({
				cause: 'Another sync of this folder started meanwhile; run it again.',
			});
	}
	return syncFolder({ account, store: local.store, identity: local.identity });
}

/**
 * Bring the folder `folder` the person holds into the Epicenter folder, in
 * a new directory named for its title (or `name`), a free one when taken.
 */
export async function cloneIntoHome({
	account,
	root,
	folder,
	name,
}: {
	account: RemoteAccount;
	root: EpicenterRoot;
	folder: string;
	name?: string;
}): Promise<Result<{ local: LocalFolder; sync: FolderSync }, Unavailable>> {
	let wanted = name;
	if (wanted === undefined) {
		const listing = await listFolders(account);
		if (listing.error !== null) return listing;
		const held = listing.data.folders.find(({ id }) => id === folder);
		wanted = held?.title ?? folder;
	}
	const present = await root.list();
	if (present.error !== null) return present;
	const made = await root.make(
		freeName(wanted, [
			...present.data.folders.map(({ name }) => name),
			...present.data.unreadable.map(({ name }) => name),
		]),
	);
	if (made.error !== null) return made;
	const synced = await cloneFolder({ account, folder, local: made.data });
	if (synced.error !== null) return synced;
	return Ok({ local: made.data, sync: synced.data });
}

/**
 * Accept the share of `folder` waiting for the person, and bring it into
 * the Epicenter folder beside their own (ADR-0816).
 */
export async function acceptIntoHome({
	account,
	root,
	folder,
}: {
	account: RemoteAccount;
	root: EpicenterRoot;
	folder: string;
}) {
	const accepted = await acceptShare(account, { folder });
	if (accepted.error !== null) return accepted;
	return cloneIntoHome({
		account,
		root,
		folder,
		name: accepted.data.title ?? folder,
	});
}

/** Whether `store` holds a visible change its manifest does not. */
async function changedHere(store: Store, manifest: Manifest) {
	const listed = await store.list(['']);
	if (listed.error !== null) return true;
	const here = listed.data.filter(({ path }) => !isHiddenPath(path));
	if (here.length !== Object.keys(manifest.files).length) return true;
	return here.some(({ path, version }) => manifest.files[path] !== version);
}

/** One folder's part of `syncEvery`. */
export type EverySync = {
	name: string;
	path: string;
	/** How its sync ended, or why it did not run; absent when nothing moved on either side. */
	result?: Result<FolderSync, Unavailable>;
};

/**
 * Sync every synced folder in the Epicenter folder that moved on either
 * side, from one request for where every folder the person holds is
 * (ADR-0819): a folder whose server moved past its manifest, or whose files
 * changed here. A folder never synced, or a copy, waits for a person.
 */
export async function syncEvery({
	account,
	root,
}: {
	account: RemoteAccount;
	root: EpicenterRoot;
}): Promise<Result<EverySync[], Unavailable>> {
	const [heads, listed] = await Promise.all([
		folderHeads(account),
		root.list(),
	]);
	if (heads.error !== null) return heads;
	if (listed.error !== null) return listed;
	const out: EverySync[] = [];
	for (const local of listed.data.folders) {
		const read = await storeManifest(local.store).read();
		const manifest = read.data?.manifest;
		if (
			manifest?.folder === undefined ||
			copyOf(manifest, local.identity) !== null
		)
			continue;
		const head = heads.data[manifest.folder];
		const entry: EverySync = { name: local.name, path: local.path };
		// One the person no longer holds is named, without asking the server again.
		if (head === undefined)
			entry.result = ClientError.Unavailable({
				cause: `${local.path} syncs with ${manifest.folder}, which you no longer hold, or which is gone`,
			});
		else if (
			head !== manifest.commit ||
			(await changedHere(local.store, manifest))
		)
			entry.result = await syncFolder({
				account,
				store: local.store,
				identity: local.identity,
			});
		out.push(entry);
	}
	return Ok(out);
}
