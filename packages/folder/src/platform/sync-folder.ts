/**
 * Syncing a folder on this computer with its folder on the server, as
 * Epicenter's programs do it (ADR-0817, ADR-0822): the one sync function
 * (`sync({ local, remote, manifest })`) over the folder's record at the
 * Epicenter folder's root, behind the rules that say which directory is
 * which folder (`identify.ts`).
 *
 * - A directory proven its record's folder syncs from the agreed state.
 * - An unbound directory syncs only when an app made it or the person
 *   chooses to. With nothing it could be, it becomes a new folder
 *   (`makeFolder`, which never joins); with one folder it could be that the
 *   person holds alone, it joins that one; otherwise it asks which
 *   (`Question`), and the person answers `{ join }` or `{ create }`. A join
 *   starts from first contact, which never deletes: a record with nothing
 *   agreed.
 * - A directory Git keeps never syncs, nor does a link in the Epicenter
 *   folder (ADR-0825), nor anything while the Epicenter folder is inside a
 *   file-sync service.
 *
 * `syncEvery` keeps every folder in the Epicenter folder in sync from one
 * request for where every folder is (ADR-0819), as the Epicenter app does
 * while it runs.
 */
import {
	ClientError,
	CONTRACT_PATH,
	isHiddenPath,
} from '@epicenter/definition/contract';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Unavailable } from '../device/store.js';
import { acceptShare, folderHeads, listFolders } from '../remote/folders.js';
import {
	folderRepository,
	makeFolder,
	type RemoteAccount,
} from '../remote/repository.js';
import { type Deletions, type SyncReport, sync } from '../sync/sync.js';
import { type KnownApp, madeBy } from './apps.js';
import {
	type EpicenterRoot,
	freeName,
	type LocalFolder,
} from './epicenter-folder.js';
import {
	type BoundFolder,
	fileSyncOf,
	gitRootOf,
	type Identified,
	identify,
	type Question,
	questionOf,
	type UnboundFolder,
} from './identify.js';
import { type FolderRecord, type Records, recordPath } from './records.js';

/** How a sync of one folder ended. */
export type FolderSync =
	/**
	 * It synced with the folder `folder`: `made` when this sync made it on
	 * the server, `joined` when it joined it from first contact. A report
	 * whose outcome is `deletions` sent nothing: it would delete many files.
	 */
	| {
			kind: 'synced';
			folder: string;
			made: boolean;
			joined: boolean;
			report: SyncReport;
	  }
	/** It is not synced here, and could be one of several folders: the person answers. */
	| { kind: 'question'; question: Question }
	/** Git keeps it, so Epicenter never syncs it. */
	| { kind: 'git' };

/** A person's answer to a folder's question: sync it with a folder they hold, or as a new folder. */
export type Answer = { join: string } | { create: true };

/** The record of a folder bound to `local` from first contact: nothing agreed yet. */
const firstContact = (folder: string, local: LocalFolder): FolderRecord => ({
	folder,
	name: local.name,
	inode: local.identity?.inode ?? '',
	birthtime: local.identity?.birthtime ?? null,
	cursor: null,
	files: {},
});

/**
 * Bind `local` to `folder` from first contact: write its record over any
 * record of that folder no directory here proves. Refused when a directory
 * here is already bound to it.
 */
async function bind({
	identified,
	local,
	folder,
}: {
	identified: Identified;
	local: LocalFolder;
	folder: string;
}): Promise<Result<null, Unavailable>> {
	const bound = identified.bound.find(({ record }) => record.folder === folder);
	if (bound !== undefined && bound.local !== local)
		return ClientError.Unavailable({
			cause: `${bound.local.path} already syncs with that folder here`,
		});
	const free = identified.free.find(({ record }) => record.folder === folder);
	const written = await identified.records.write(
		firstContact(folder, local),
		free?.version ?? null,
	);
	if (written.error !== null) return written;
	if (written.data === 'moved')
		return ClientError.Unavailable({
			cause: `Another program bound ${recordPath(folder)} meanwhile; sync again.`,
		});
	return Ok(null);
}

/** Sync the folder `folder` in `local` from its record. */
async function syncRecorded({
	account,
	records,
	local,
	folder,
	deletions,
}: {
	account: RemoteAccount;
	records: Records;
	local: LocalFolder;
	folder: string;
	deletions?: Deletions;
}) {
	return sync({
		local: local.store,
		remote: folderRepository(account, folder),
		manifest: records.manifest(folder),
		deletions,
	});
}

/**
 * Sync the unbound folder `unbound` as the person chose to, or as its app
 * made it: with `answer` when given; otherwise as a new folder when nothing
 * matches, with the one match held by the person alone, or by asking.
 */
async function syncUnbound({
	account,
	identified,
	unbound,
	answer,
	apps,
	deletions,
}: {
	account: RemoteAccount;
	identified: Identified;
	unbound: UnboundFolder;
	answer?: Answer;
	apps: readonly KnownApp[];
	deletions?: Deletions;
}): Promise<Result<FolderSync, Unavailable>> {
	const listing = await identified.server();
	if (listing === null)
		return (
			(await identified.serverError()) ??
			ClientError.Unavailable({ cause: 'The server could not be asked.' })
		);
	const question = await questionOf(unbound, identified, listing, apps);
	let choice: Answer | null = answer ?? null;
	if (choice === null) {
		if (question.candidates.length === 0) choice = { create: true };
		else if (question.silent !== null) choice = { join: question.silent };
		else return Ok({ kind: 'question', question });
	}
	let folder: string;
	let made = false;
	if ('create' in choice) {
		const created = await makeFolder(account, {
			app: question.madeBy?.client,
		});
		if (created.error !== null) return created;
		folder = created.data;
		made = true;
		const titled = await titleNew(unbound.local);
		if (titled.error !== null) return titled;
	} else {
		const target = choice.join;
		if (!listing.folders.some(({ id }) => id === target))
			return ClientError.Unavailable({
				cause: `You hold no folder ${target}: run epicenter clone to list yours`,
			});
		folder = target;
	}
	const bound = await bind({ identified, local: unbound.local, folder });
	if (bound.error !== null) return bound;
	const ran = await syncRecorded({
		account,
		records: identified.records,
		local: unbound.local,
		folder,
		deletions,
	});
	if (ran.error !== null) return ran;
	return Ok({ kind: 'synced', folder, made, joined: !made, report: ran.data });
}

/**
 * Give a folder being made its title, the directory's name, when it has no
 * `epicenter.json` (ADR-0811): the server reads a folder's title from it,
 * so a computer that loses its record finds the folder again by name.
 */
async function titleNew(
	local: LocalFolder,
): Promise<Result<null, Unavailable>> {
	const read = await local.store.read([CONTRACT_PATH]);
	if (read.error !== null) return read;
	const [file] = read.data;
	if (file !== undefined && !('gone' in file)) return Ok(null);
	const written = await local.store.put(
		CONTRACT_PATH,
		new TextEncoder().encode(
			`${JSON.stringify({ title: local.name }, null, '\t')}\n`,
		),
		null,
	);
	if (written.error?.name === 'Unavailable') return Err(written.error);
	return Ok(null);
}

/** Why Epicenter refuses to sync the Epicenter folder, really at `real`, or null. */
function refusedRoot({ real }: Identified) {
	const check = fileSyncOf(real);
	return check !== null && 'refused' in check
		? ClientError.Unavailable({ cause: check.refused })
		: null;
}

/**
 * Sync the folder named `name` in the Epicenter folder `root`, as the person
 * asked: a folder proven its record's syncs; an unbound one syncs by
 * `answer`, or as a new folder, or with its one match the person holds
 * alone, or asks. `deletions` says what to do with many files deleted here.
 */
export async function syncFolder({
	account,
	root,
	name,
	answer,
	deletions,
	apps = [],
}: {
	account: RemoteAccount;
	root: EpicenterRoot;
	name: string;
	answer?: Answer;
	deletions?: Deletions;
	apps?: readonly KnownApp[];
}): Promise<Result<FolderSync, Unavailable>> {
	const found = await identify({ root, account });
	if (found.error !== null) return found;
	const identified = found.data;
	const refused = refusedRoot(identified);
	if (refused !== null) return refused;
	if (identified.git.some((local) => local.name === name))
		return Ok({ kind: 'git' });
	const link = identified.outside.find((one) => one.name === name);
	if (link !== undefined)
		return ClientError.Unavailable({
			cause: `${link.path} is a link to ${link.target}, a folder outside the Epicenter folder, which Epicenter does not sync. Move the folder into ${root.path}, and leave a link where it was.`,
		});
	const bound = identified.bound.find(({ local }) => local.name === name);
	if (bound !== undefined) {
		if (
			answer !== undefined &&
			!('join' in answer && answer.join === bound.record.folder)
		)
			return ClientError.Unavailable({
				cause: `${bound.local.path} already syncs with ${bound.record.folder}`,
			});
		return syncBound({ account, identified, bound, deletions });
	}
	const unbound = identified.unbound.find(({ local }) => local.name === name);
	if (unbound === undefined)
		return ClientError.Unavailable({
			cause: `${name} is not a folder in ${root.path}`,
		});
	return syncUnbound({ account, identified, unbound, answer, apps, deletions });
}

async function syncBound({
	account,
	identified,
	bound,
	deletions,
}: {
	account: RemoteAccount;
	identified: Identified;
	bound: BoundFolder;
	deletions?: Deletions;
}): Promise<Result<FolderSync, Unavailable>> {
	const ran = await syncRecorded({
		account,
		records: identified.records,
		local: bound.local,
		folder: bound.record.folder,
		deletions,
	});
	if (ran.error !== null) return ran;
	return Ok({
		kind: 'synced',
		folder: bound.record.folder,
		made: false,
		joined: false,
		report: ran.data,
	});
}

/**
 * Bring the folder `folder` the person holds into the Epicenter folder, in
 * a new directory named for its title (or `name`), a free one when taken,
 * and sync it from first contact. Refused when it is synced here already.
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
	const found = await identify({ root, account });
	if (found.error !== null) return found;
	const refused = refusedRoot(found.data);
	if (refused !== null) return refused;
	const here = found.data.bound.find(({ record }) => record.folder === folder);
	if (here !== undefined)
		return ClientError.Unavailable({
			cause: `${here.local.path} already syncs with that folder`,
		});
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
	const local = made.data;
	const bound = await bind({ identified: found.data, local, folder });
	if (bound.error !== null) return bound;
	const ran = await syncRecorded({
		account,
		records: found.data.records,
		local,
		folder,
	});
	if (ran.error !== null) return ran;
	return Ok({
		local,
		sync: {
			kind: 'synced',
			folder,
			made: false,
			joined: true,
			report: ran.data,
		},
	});
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

/** Whether `local` holds a visible change `record` does not. */
async function changedHere(local: LocalFolder, record: FolderRecord) {
	const listed = await local.store.list(['']);
	if (listed.error !== null) return true;
	const here = listed.data.filter(({ path }) => !isHiddenPath(path));
	if (here.length !== Object.keys(record.files).length) return true;
	return here.some(({ path, version }) => record.files[path] !== version);
}

/** One folder's part of `syncEvery`. */
export type EverySync = {
	name: string;
	path: string;
	/** The folder, as the root listed it. */
	local: LocalFolder;
	/**
	 * Why nothing ran: `local` for a folder not synced here that no app made
	 * and no person chose to sync, `question` for one that asks which folder
	 * it is (`result` holds the question), and `git` for one Git keeps.
	 */
	waiting?: 'local' | 'question' | 'git';
	/** How its sync ended, or why it did not run; absent when nothing moved on either side. */
	result?: Result<FolderSync, Unavailable>;
};

/**
 * Sync every folder in the Epicenter folder that moved on either side,
 * from one request for where every folder the person holds is (ADR-0819):
 * a folder whose server moved past its record, or whose files changed
 * here. A folder not synced here syncs when an app made it (`apps`), as if
 * the person had chosen to, and otherwise waits for them (`waiting`).
 * `deletions` answers a folder's stop for many deletions, by its path.
 * `names`, when given, limits the round to the folders of those names, as
 * `epicenter mcp` keeps only the folders it writes in sync (ADR-0819).
 * `warnings` say what the file-sync check could not rule out, and that the
 * Epicenter folder is itself a Git repository.
 */
export async function syncEvery({
	account,
	root,
	apps = [],
	deletions = new Map(),
	names,
}: {
	account: RemoteAccount;
	root: EpicenterRoot;
	apps?: readonly KnownApp[];
	deletions?: ReadonlyMap<string, Deletions>;
	names?: ReadonlySet<string>;
}): Promise<Result<{ folders: EverySync[]; warnings: string[] }, Unavailable>> {
	const [heads, found] = await Promise.all([
		folderHeads(account),
		identify({ root, account }),
	]);
	if (heads.error !== null) return heads;
	if (found.error !== null) return found;
	const identified = found.data;
	const named = ({ local }: { local: LocalFolder }) =>
		names === undefined || names.has(local.name);
	const refused = refusedRoot(identified);
	if (refused !== null) return refused;
	const check = fileSyncOf(identified.real);
	const git = gitRootOf(root.path, identified.rootGit);
	const out: EverySync[] = [];
	for (const bound of identified.bound.filter(named)) {
		const { local, record } = bound;
		const entry: EverySync = { name: local.name, path: local.path, local };
		const head = heads.data[record.folder];
		const answered = deletions.get(local.path);
		// One the person no longer holds is named, without asking the server again.
		if (head === undefined)
			entry.result = ClientError.Unavailable({
				cause: `${local.path} syncs with ${record.folder}, which you no longer hold, or which is gone`,
			});
		else if (
			answered !== undefined ||
			head !== record.cursor ||
			(await changedHere(local, record))
		)
			entry.result = await syncBound({
				account,
				identified,
				bound,
				deletions: answered,
			});
		out.push(entry);
	}
	for (const unbound of identified.unbound.filter(named)) {
		const { local } = unbound;
		const entry: EverySync = { name: local.name, path: local.path, local };
		// Only a folder an app made syncs without the person: the server is
		// asked about no other, so an idle round costs one request.
		if ((await madeBy(local.name, local.store, apps)) === null) {
			out.push({ ...entry, waiting: 'local' });
			continue;
		}
		const result = await syncUnbound({
			account,
			identified,
			unbound,
			apps,
			deletions: deletions.get(local.path),
		});
		out.push({
			...entry,
			result,
			...(result.data?.kind === 'question'
				? { waiting: 'question' as const }
				: {}),
		});
	}
	for (const local of identified.git.filter((local) => named({ local })))
		out.push({ name: local.name, path: local.path, local, waiting: 'git' });
	out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return Ok({
		folders: out,
		warnings: [
			...(check !== null && 'warning' in check ? [check.warning] : []),
			...(git === null ? [] : [git]),
		],
	});
}
