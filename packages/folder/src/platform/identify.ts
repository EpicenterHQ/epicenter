/**
 * Which directory is which folder (ADR-0822). A record says what this
 * computer agreed with a folder on the server, and that agreement is
 * trusted only for the directory proven the one that agreed it. Across the
 * whole Epicenter folder, in order:
 *
 * 1. A directory whose inode and birth time match a record is that folder,
 *    with its agreed state, wherever it moved, when both sides have a real
 *    birth time.
 * 2. For a record no directory matched, a directory with its recorded name
 *    and exactly its recorded files (path to blob id) is that folder, when
 *    the server's current member list says the person is its only member.
 *    A list that cannot be read counts the folder as shared.
 * 3. Every other directory is unbound. A record proves at most one
 *    directory, and a directory is proven by at most one record.
 *
 * A directory Git keeps is none of these: Epicenter never syncs it. A
 * folder an older build synced is imported first (`legacy.ts`). A record
 * whose directory moved is brought up to date with its name and identity.
 *
 * An unbound folder stays local until an app makes it or the person syncs
 * it. Then `questionOf` asks which folder it is: the folders the person
 * holds that are not bound here, matched by name or title, each with its
 * members; a shared folder that met rule 2's files is offered selected; and
 * one held by the person alone that is the only match is joined without
 * asking. Every binding not proven by rules 1 and 2 starts from first
 * contact, which never deletes.
 */
import { CONTRACT_PATH, isHiddenPath } from '@epicenter/definition/contract';
import type { FolderListing, ListedFolder } from '@epicenter/definition/site';
import { Ok, type Result } from 'wellcrafted/result';
import type { Store, Unavailable, Version } from '../device/store.js';
import { proves } from '../identity.js';
import { listFolders } from '../remote/folders.js';
import type { RemoteAccount } from '../remote/repository.js';
import { type KnownApp, madeBy } from './apps.js';
import type { EpicenterRoot, LocalFolder } from './epicenter-folder.js';
import { importLegacy } from './legacy.js';
import type { FolderRecord, HeldRecord, Records } from './records.js';

/** How a directory was proven the folder its record names. */
export type Proof = 'identity' | 'files';

/** A directory proven the folder its record names. */
export type BoundFolder = {
	local: LocalFolder;
	record: FolderRecord;
	/** The record's version, which its next write goes over. */
	version: Version;
	proof: Proof;
};

/** A directory no record proves. */
export type UnboundFolder = {
	local: LocalFolder;
	/** The `title` of its `epicenter.json`, or null. */
	title: string | null;
	/** The folders whose record's name and files it met, though they are shared (or their members could not be read). */
	filesMet: string[];
};

/** The Epicenter folder, each directory in it proven or not. */
export type Identified = {
	records: Records;
	bound: BoundFolder[];
	unbound: UnboundFolder[];
	/** The directories Git keeps, which Epicenter never syncs. */
	git: LocalFolder[];
	unreadable: { name: string; reason: string }[];
	/** The records no directory here proves: folders this computer synced once. */
	free: HeldRecord[];
	/** The Epicenter folder's real path, where it is known. */
	realPath: string | null;
	/** The folders the person holds, asked once; null without an account, or when the server could not answer. */
	server(): Promise<FolderListing | null>;
	/** Why the server could not answer, once asked; null when it did, or was not asked. */
	serverError(): Promise<Result<never, Unavailable> | null>;
};

const decoder = new TextDecoder();

/** The `title` of the `epicenter.json` in `store`, or null. */
export async function titleOf(store: Store): Promise<string | null> {
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

/** Whether `local` holds exactly `files` (path to blob id), and no other visible file. */
async function holdsExactly(
	local: LocalFolder,
	files: Record<string, string>,
): Promise<boolean> {
	const listed = await local.store.list(['']);
	if (listed.error !== null) return false;
	const visible = listed.data.filter(({ path }) => !isHiddenPath(path));
	if (visible.length !== Object.keys(files).length) return false;
	return visible.every(({ path, version }) => files[path] === version);
}

/** Whether `listing` says the person holds the folder alone: they are its one member, and no one is invited. */
export const heldAlone = (listing: ListedFolder) =>
	listing.members.length === 1 &&
	listing.members[0]?.you === true &&
	listing.invited.length === 0;

/**
 * Every directory in `root` proven the folder its record names, or not, by
 * the rules above. With `account`, rule 2 asks the server who holds a
 * folder; without one, it proves nothing. Records whose directory moved are
 * updated; a folder an older build synced is imported first.
 */
export async function identify({
	root,
	account,
}: {
	root: EpicenterRoot;
	account?: RemoteAccount;
}): Promise<Result<Identified, Unavailable>> {
	const [listed, opened] = await Promise.all([root.list(), root.records()]);
	if (listed.error !== null) return listed;
	if (opened.error !== null) return opened;
	const records = opened.data;
	const folders = listed.data.folders.filter(({ git }) => !git);
	for (const local of folders) {
		const imported = await importLegacy({ local, records });
		if (imported.error !== null) return imported;
	}
	const held = await records.list();
	if (held.error !== null) return held;

	let asked: Promise<Result<FolderListing, Unavailable>> | null = null;
	const ask = () => {
		if (account === undefined) return null;
		asked ??= listFolders(account);
		return asked;
	};
	const server = async () => {
		const answer = await ask();
		return answer === null || answer.error !== null ? null : answer.data;
	};

	const free = new Map(held.data.map((one) => [one.record.folder, one]));
	const claimed = new Map<LocalFolder, { held: HeldRecord; proof: Proof }>();

	// 1. Inode and birth time, both real.
	for (const local of folders) {
		const identity = local.identity;
		if (identity === null || identity.birthtime === null) continue;
		const match = [...free.values()].find(({ record }) =>
			proves(record, identity),
		);
		if (match === undefined) continue;
		free.delete(match.record.folder);
		claimed.set(local, { held: match, proof: 'identity' });
	}

	// 2. The recorded name and exactly the recorded files, held alone.
	const filesMet = new Map<LocalFolder, string[]>();
	for (const one of [...free.values()]) {
		const local = folders.find(
			(candidate) =>
				!claimed.has(candidate) &&
				candidate.name.toLowerCase() === one.record.name.toLowerCase(),
		);
		if (local === undefined) continue;
		if (!(await holdsExactly(local, one.record.files))) continue;
		const listing = (await server())?.folders.find(
			({ id }) => id === one.record.folder,
		);
		if (listing !== undefined && heldAlone(listing)) {
			free.delete(one.record.folder);
			claimed.set(local, { held: one, proof: 'files' });
		} else
			filesMet.set(local, [...(filesMet.get(local) ?? []), one.record.folder]);
	}

	// A proven directory that moved brings its record up to date.
	const bound: BoundFolder[] = [];
	for (const local of folders) {
		const claim = claimed.get(local);
		if (claim === undefined) continue;
		let { record, version } = claim.held;
		const identity = local.identity;
		const moved =
			record.name !== local.name ||
			(identity !== null &&
				(record.inode !== identity.inode ||
					record.birthtime !== identity.birthtime));
		if (moved) {
			const next: FolderRecord = {
				...record,
				name: local.name,
				...(identity === null
					? {}
					: { inode: identity.inode, birthtime: identity.birthtime }),
			};
			const written = await records.write(next, version);
			if (written.error !== null) return written;
			if (written.data !== 'moved') {
				record = next;
				version = written.data;
			}
		}
		bound.push({ local, record, version, proof: claim.proof });
	}
	const unbound: UnboundFolder[] = [];
	for (const local of folders)
		if (!claimed.has(local))
			unbound.push({
				local,
				title: await titleOf(local.store),
				filesMet: filesMet.get(local) ?? [],
			});

	return Ok({
		records,
		bound,
		unbound,
		git: listed.data.folders.filter(({ git }) => git),
		unreadable: listed.data.unreadable,
		free: [...free.values()],
		realPath: listed.data.realPath,
		server,
		async serverError() {
			const answer = await (asked ?? Promise.resolve(null));
			return answer === null || answer.error === null
				? null
				: { data: null, error: answer.error };
		},
	});
}

/** A folder an unbound directory could be. */
export type Candidate = {
	folder: ListedFolder;
	/** What it matched by: the directory's name (the folder's title, or the name it had here), or its `epicenter.json` title. */
	matchedBy: 'name' | 'title';
	/** Whether the person holds it alone. */
	alone: boolean;
};

/** Which folder an unbound directory is: what a person answers before it syncs. */
export type Question = {
	name: string;
	path: string;
	/** The folders the person holds that are not bound here and match it. */
	candidates: Candidate[];
	/** The shared folder whose recorded name and files it met: offered selected. */
	preselected: string | null;
	/** The folder it joins without asking: the only match, held by the person alone. */
	silent: string | null;
	/** The app that made it (its name and contract are the app's), when one did. */
	madeBy: KnownApp | null;
};

/**
 * The question for `unbound`, from the folders the person holds
 * (`listing`) that are not bound in `identified`.
 */
export async function questionOf(
	unbound: UnboundFolder,
	identified: Identified,
	listing: FolderListing,
	apps: readonly KnownApp[] = [],
): Promise<Question> {
	const here = new Set(identified.bound.map(({ record }) => record.folder));
	const namedHere = new Map(
		identified.free.map(({ record }) => [record.folder, record.name]),
	);
	const name = unbound.local.name.toLowerCase();
	const candidates: Candidate[] = [];
	for (const folder of listing.folders) {
		if (here.has(folder.id)) continue;
		const byName =
			folder.title?.toLowerCase() === name ||
			namedHere.get(folder.id)?.toLowerCase() === name;
		const byTitle = unbound.title !== null && folder.title === unbound.title;
		if (!byName && !byTitle) continue;
		candidates.push({
			folder,
			matchedBy: byName ? 'name' : 'title',
			alone: heldAlone(folder),
		});
	}
	const preselected = candidates.filter(
		({ folder, alone }) => !alone && unbound.filesMet.includes(folder.id),
	);
	const [only] = candidates;
	return {
		name: unbound.local.name,
		path: unbound.local.path,
		candidates,
		preselected:
			preselected.length === 1 ? (preselected[0]?.folder.id ?? null) : null,
		silent:
			candidates.length === 1 && only?.alone === true ? only.folder.id : null,
		madeBy: await madeBy(unbound.local.name, unbound.local.store, apps),
	};
}

/**
 * Why Epicenter will not sync an Epicenter folder at `realPath`, or what it
 * could not tell (ADR-0821): a folder inside a file-sync service (iCloud
 * Drive, a File Provider location, Dropbox, OneDrive, Google Drive) is
 * synced by that service too, which fights Epicenter over every file.
 */
export function fileSyncOf(
	realPath: string | null,
): { refused: string } | { warning: string } | null {
	if (realPath === null)
		return {
			warning:
				'Epicenter could not tell where the Epicenter folder really is, so it cannot say whether a file-sync service also syncs it.',
		};
	const segments = realPath.split(/[/\\]/);
	const refuse = (service: string) => ({
		refused: `The Epicenter folder is in ${service} (${realPath}), which syncs its files too. Move it out, then Epicenter syncs it.`,
	});
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index] as string;
		const next = segments[index + 1];
		if (segment === 'Library' && next === 'Mobile Documents')
			return refuse('iCloud Drive');
		if (segment === 'Library' && next === 'CloudStorage')
			return refuse('a cloud storage folder');
		if (/^Dropbox( \(.+\))?$/.test(segment)) return refuse('Dropbox');
		if (/^OneDrive( - .+)?$/.test(segment)) return refuse('OneDrive');
		if (/^(Google Drive|My Drive)$/.test(segment))
			return refuse('Google Drive');
	}
	if (/dropbox|onedrive|google ?drive|icloud/i.test(realPath))
		return {
			warning: `The Epicenter folder's path (${realPath}) names a file-sync service; if one syncs it, move it out.`,
		};
	return null;
}
