/**
 * The Epicenter folder (ADR-0813, ADR-0816): `~/Epicenter`, every directory
 * directly inside it an Epicenter folder, a folder elsewhere joined by a
 * symbolic link there. Nothing registers a folder; discovery lists the
 * directory. `EpicenterRoot` is that directory as a surface reaches it: Bun
 * or Node through `@epicenter/folder/node`'s `epicenterRoot(path)`, and the
 * desktop shell's root later.
 *
 * `listHome` is the platform's home (ADR-0815): each folder with its title,
 * its state (never synced, synced, or shared), and, with an account, its
 * members, beside the shares waiting for the person and the folders they
 * hold that this computer does not. The CLI's `status`, the Epicenter app,
 * and every app's home read it.
 */
import { CONTRACT_PATH } from '@epicenter/definition/contract';
import type {
	FolderMember,
	FolderRole,
	ListedFolder,
	PendingShare,
} from '@epicenter/definition/site';
import { Ok, type Result } from 'wellcrafted/result';
import type { Store, Unavailable } from '../device/store.js';
import { listFolders } from '../remote/folders.js';
import type { RemoteAccount } from '../remote/repository.js';
import {
	type Manifest,
	type RootIdentity,
	storeManifest,
} from '../sync/sync.js';

/** One directory directly inside the Epicenter folder. */
export type LocalFolder = {
	/** Its directory's name, the person's own label for it. */
	name: string;
	/** Where it is, to show a person and to name it on the command line. */
	path: string;
	store: Store;
	/** The directory's identity now (device and inode); null where the store has none. */
	identity: RootIdentity | null;
};

/** The Epicenter folder as a surface reaches it. */
export type EpicenterRoot = {
	/** Where it is, to show a person. */
	path: string;
	/**
	 * Every directory directly inside it, links followed, hidden names
	 * skipped, by name; and what is there but could not be read, with why.
	 */
	list(): Promise<
		Result<
			{
				folders: LocalFolder[];
				unreadable: { name: string; reason: string }[];
			},
			Unavailable
		>
	>;
	/** Make the directory `name` inside it, refused when anything has that name. */
	make(name: string): Promise<Result<LocalFolder, Unavailable>>;
};

/** Whether two directory identities are one directory. */
const sameRoot = (a: RootIdentity, b: RootIdentity) =>
	a.device === b.device && a.inode === b.inode;

/**
 * A folder's state (ADR-0811): `local` before its first sync (a copy of
 * another folder included), `synced` once it has an id, and `shared` once
 * someone else holds it too.
 */
export type HomeState = 'local' | 'synced' | 'shared';

/** One folder in the home. */
export type HomeFolder = {
	name: string;
	path: string;
	/** The `title` of its `epicenter.json`; null without one, when its name stands in. */
	title: string | null;
	state: HomeState;
	/** Its id on the server, once it synced. */
	folder: string | null;
	/**
	 * The id of the folder this directory is a copy of (its manifest names
	 * one, but it synced in another directory): it is a new local folder, and
	 * its first sync asks whether it is that folder or a new one.
	 */
	copyOf: string | null;
	/** Who holds it, when the server was asked; null otherwise. */
	members: FolderMember[] | null;
	/** The person's role in it, when the server was asked. */
	role: FolderRole | null;
	/**
	 * Why the server does not list it though it synced: the person no longer
	 * holds it, or it is gone. Null otherwise, and without an account.
	 */
	unlisted: string | null;
};

/** The home: the folders here, the shares waiting, and the folders held elsewhere. */
export type Home = {
	folders: HomeFolder[];
	/** The shares waiting for the person; empty without an account. */
	pending: PendingShare[];
	/** The folders the person holds that this computer does not; empty without an account. */
	elsewhere: ListedFolder[];
	/** What is in the Epicenter folder but could not be read, with why. */
	unreadable: { name: string; reason: string }[];
};

const decoder = new TextDecoder();

/** The `title` of the `epicenter.json` in `store`, or null. */
async function localTitle(store: Store): Promise<string | null> {
	const read = await store.read([CONTRACT_PATH]);
	const [file] = read.data ?? [];
	if (file === undefined || 'gone' in file) return null;
	try {
		const { title } = JSON.parse(decoder.decode(file.bytes)) as {
			title?: unknown;
		};
		return typeof title === 'string' && title.trim() !== '' ? title : null;
	} catch {
		return null;
	}
}

/**
 * Whether `manifest` was written for another directory than `identity`: a
 * copy, which must not sync as the folder it names. A manifest with no
 * directory recorded, or a store with no identity, is not a copy.
 */
export function copyOf(
	manifest: Manifest,
	identity: RootIdentity | null,
): string | null {
	if (
		manifest.folder === undefined ||
		manifest.root === undefined ||
		identity === null
	)
		return null;
	return sameRoot(manifest.root, identity) ? null : manifest.folder;
}

/**
 * The home: every folder in `root` with its title and state, and, with an
 * `account`, each one's members as the server lists them, the shares waiting
 * for the person, and the folders they hold that are not here. Without an
 * account a synced folder is `synced`, since whether it is shared is the
 * server's to say.
 */
export async function listHome({
	root,
	account,
}: {
	root: EpicenterRoot;
	account?: RemoteAccount;
}): Promise<Result<Home, Unavailable>> {
	const listed = await root.list();
	if (listed.error !== null) return listed;
	const server = account === undefined ? null : await listFolders(account);
	if (server !== null && server.error !== null) return server;
	const remote = new Map(
		(server?.data.folders ?? []).map((folder) => [folder.id, folder]),
	);
	const here = new Set<string>();
	const folders: HomeFolder[] = [];
	for (const local of listed.data.folders) {
		const [title, read] = await Promise.all([
			localTitle(local.store),
			storeManifest(local.store).read(),
		]);
		const manifest = read.data?.manifest;
		const copy =
			manifest === undefined ? null : copyOf(manifest, local.identity);
		const folder = copy === null ? (manifest?.folder ?? null) : null;
		if (folder !== null) here.add(folder);
		const listing = folder === null ? undefined : remote.get(folder);
		folders.push({
			name: local.name,
			path: local.path,
			title,
			state:
				folder === null
					? 'local'
					: (listing?.members.length ?? 0) + (listing?.invited.length ?? 0) > 1
						? 'shared'
						: 'synced',
			folder,
			copyOf: copy,
			members: listing?.members ?? null,
			role: listing?.role ?? null,
			unlisted:
				server === null || folder === null || listing !== undefined
					? null
					: 'The server does not list this folder: it was unshared with you, or it is gone.',
		});
	}
	return Ok({
		folders,
		pending: server?.data.pending ?? [],
		elsewhere: (server?.data.folders ?? []).filter(({ id }) => !here.has(id)),
		unreadable: listed.data.unreadable,
	});
}

/**
 * A name for a new directory in the Epicenter folder: `wanted` with the
 * characters no disk keeps replaced, or `wanted 2`, `wanted 3`, … when one
 * of `taken` has it (ADR-0813).
 */
export function freeName(wanted: string, taken: Iterable<string>): string {
	const base =
		wanted
			.replace(/[/\\:*?"<>|\p{Cc}]/gu, '-')
			.replace(/^[.\s]+|\s+$/g, '')
			.slice(0, 100) || 'Folder';
	const lower = new Set([...taken].map((name) => name.toLowerCase()));
	let name = base;
	for (let n = 2; lower.has(name.toLowerCase()); n++) name = `${base} ${n}`;
	return name;
}
