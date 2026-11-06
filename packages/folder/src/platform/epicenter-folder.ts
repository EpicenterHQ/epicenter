/**
 * The Epicenter folder (ADR-0813, ADR-0816): `~/Epicenter`, every directory
 * directly inside it an Epicenter folder, a folder elsewhere joined by a
 * symbolic link there. Nothing registers a folder; discovery lists the
 * directory. `EpicenterRoot` is that directory as a surface reaches it: Bun
 * or Node through `@epicenter/folder/node`'s `epicenterRoot(path)`, and the
 * Epicenter app's shell through `@epicenter/folder/tauri`'s. It also holds
 * the Epicenter folder's own `.epicenter`, the records of what this computer
 * synced (`records.ts`, ADR-0822).
 *
 * `listHome` is the platform's home (ADR-0815): each folder with its title,
 * its state (on this computer only, synced, shared, or kept by Git), and,
 * with an account, its members and, for a folder not synced here, the
 * question of which folder it is (`identify.ts`); beside them the shares
 * waiting for the person and the folders they hold that this computer does
 * not. The CLI's `status` and the Epicenter app read it.
 */
import type {
	FolderMember,
	FolderRole,
	ListedFolder,
	PendingShare,
} from '@epicenter/definition/site';
import { Ok, type Result } from 'wellcrafted/result';
import type { Store, Unavailable } from '../device/store.js';
import type { FolderIdentity } from '../identity.js';
import type { RemoteAccount } from '../remote/repository.js';
import type { KnownApp } from './apps.js';
import {
	fileSyncOf,
	identify,
	type Question,
	questionOf,
	titleOf,
} from './identify.js';
import type { Records } from './records.js';

/** One directory directly inside the Epicenter folder. */
export type LocalFolder = {
	/** Its directory's name, the person's own label for it. */
	name: string;
	/** Where it is, to show a person and to name it on the command line. */
	path: string;
	store: Store;
	/** The directory's identity now (inode and birth time); null where the store has none. */
	identity: FolderIdentity | null;
	/** Whether Git keeps it (`.git` at its root, or above a link's target): Epicenter never syncs it. */
	git: boolean;
};

/** The Epicenter folder as a surface reaches it. */
export type EpicenterRoot = {
	/** Where it is, to show a person. */
	path: string;
	/**
	 * Every directory directly inside it, links followed, hidden names
	 * skipped, by name; what is there but could not be read, with why; and
	 * the Epicenter folder's real path, links resolved, where it is known.
	 */
	list(): Promise<
		Result<
			{
				folders: LocalFolder[];
				unreadable: { name: string; reason: string }[];
				realPath: string | null;
			},
			Unavailable
		>
	>;
	/** Make the directory `name` inside it, refused when anything has that name. */
	make(name: string): Promise<Result<LocalFolder, Unavailable>>;
	/** The records of what this computer synced, in its own `.epicenter`. */
	records(): Promise<Result<Records, Unavailable>>;
};

/**
 * A folder's state (ADR-0811, ADR-0822): `local` while nothing proves it is
 * a folder synced here (never synced, a copy, or one waiting for the
 * person's answer), `synced` once it is, `shared` once someone else holds it
 * too, and `git` when Git keeps it, so Epicenter does not sync it.
 */
export type HomeState = 'local' | 'synced' | 'shared' | 'git';

/** One folder in the home. */
export type HomeFolder = {
	name: string;
	path: string;
	/** The `title` of its `epicenter.json`; null without one, when its name stands in. */
	title: string | null;
	state: HomeState;
	/** Its id on the server, once it synced here. */
	folder: string | null;
	/** Who holds it, when the server was asked; null otherwise. */
	members: FolderMember[] | null;
	/** The person's role in it, when the server was asked. */
	role: FolderRole | null;
	/**
	 * Why the server does not list it though it synced: the person no longer
	 * holds it, or it is gone. Null otherwise, and without an account.
	 */
	unlisted: string | null;
	/**
	 * For a folder not synced here, with an account: the folders it could be
	 * (ADR-0822), which a person answers by syncing it with one, or as new.
	 */
	question: Question | null;
};

/** The home: the folders here, the shares waiting, and the folders held elsewhere. */
export type Home = {
	folders: HomeFolder[];
	/** The shares waiting for the person; empty without an account. */
	pending: PendingShare[];
	/** The folders the person holds that this computer does not sync; empty without an account. */
	elsewhere: ListedFolder[];
	/** What is in the Epicenter folder but could not be read, with why. */
	unreadable: { name: string; reason: string }[];
	/** Why Epicenter will not sync here, or what it could not tell (`fileSyncOf`). */
	fileSync: { refused: string } | { warning: string } | null;
};

/**
 * The home: every folder in `root` with its title and state, and, with an
 * `account`, each one's members as the server lists them, the question for
 * each folder not synced here, the shares waiting for the person, and the
 * folders they hold that are not here. Without an account a synced folder is
 * `synced`, since whether it is shared is the server's to say.
 */
export async function listHome({
	root,
	account,
	apps = [],
}: {
	root: EpicenterRoot;
	account?: RemoteAccount;
	apps?: readonly KnownApp[];
}): Promise<Result<Home, Unavailable>> {
	const found = await identify({ root, account });
	if (found.error !== null) return found;
	const identified = found.data;
	const server = await identified.server();
	if (account !== undefined && server === null) {
		const listed = await identified.serverError();
		if (listed !== null) return listed;
	}
	const remote = new Map(
		(server?.folders ?? []).map((folder) => [folder.id, folder]),
	);
	const here = new Set<string>();
	const folders: HomeFolder[] = [];
	for (const { local, record } of identified.bound) {
		here.add(record.folder);
		const listing = remote.get(record.folder);
		folders.push({
			name: local.name,
			path: local.path,
			title: await titleOf(local.store),
			state:
				(listing?.members.length ?? 0) + (listing?.invited.length ?? 0) > 1
					? 'shared'
					: 'synced',
			folder: record.folder,
			members: listing?.members ?? null,
			role: listing?.role ?? null,
			unlisted:
				server === null || listing !== undefined
					? null
					: 'The server does not list this folder: it was unshared with you, or it is gone.',
			question: null,
		});
	}
	for (const unbound of identified.unbound)
		folders.push({
			name: unbound.local.name,
			path: unbound.local.path,
			title: unbound.title,
			state: 'local',
			folder: null,
			members: null,
			role: null,
			unlisted: null,
			question:
				server === null
					? null
					: await questionOf(unbound, identified, server, apps),
		});
	for (const local of identified.git)
		folders.push({
			name: local.name,
			path: local.path,
			title: null,
			state: 'git',
			folder: null,
			members: null,
			role: null,
			unlisted: null,
			question: null,
		});
	folders.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return Ok({
		folders,
		pending: server?.pending ?? [],
		elsewhere: (server?.folders ?? []).filter(({ id }) => !here.has(id)),
		unreadable: identified.unreadable,
		fileSync: fileSyncOf(identified.realPath),
	});
}

/**
 * Who holds a folder, as a person reads it (ADR-0811): "Only you", "You and
 * Jess", "Ana and Jess". Every surface that shows a folder's members says
 * it this way.
 */
export function describeMembers(members: readonly FolderMember[]): string {
	const others = members
		.filter(({ you }) => !you)
		.map(({ name, email }) => name || email);
	const you = members.some((member) => member.you);
	if (others.length === 0) return you ? 'Only you' : 'No one';
	const named = you ? ['You', ...others] : others;
	return named.length === 1
		? (named[0] as string)
		: `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
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
