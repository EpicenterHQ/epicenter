/**
 * A folder's history (ADR-0824, ADR-0826, ADR-0828): its changes, a file's
 * versions, a file or the whole folder as it was at a moment, the files
 * changed since one, a restore, and marks. Each is a function of the
 * folder's log on the server, for a folder synced on this computer and
 * named by its directory in the Epicenter folder. The CLI (`epicenter log`,
 * `history`, `show`, `at`, `diff`, `restore`, `mark`) and the Epicenter
 * app's History view both call these.
 *
 * A moment is a change's number, a mark's name, or a time (ISO 8601, or
 * anything `Date` reads); the server reads it. A restore is a forward change
 * on the server: each file named takes back the version it held at the
 * moment, naming a version the server holds, so no bytes travel; the next
 * sync brings it to this computer, and the history keeps everything between.
 */
import { isHiddenPath } from '@epicenter/definition/contract';
import { isMarkName } from '@epicenter/definition/site';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Unavailable, Version } from '../device/store.js';
import {
	folderRepository,
	type LoggedChange,
	type Mark,
	type NamedWrite,
	type RemoteAccount,
} from '../remote/repository.js';
import type { EpicenterRoot } from './epicenter-folder.js';
import { identify } from './identify.js';

export const HistoryError = defineErrors({
	/** The directory `folder` is not a folder synced on this computer, so it has no history to read. */
	NotSynced: ({ folder }: { folder: string }) => ({
		message: `${folder} is not synced on this computer`,
		folder,
	}),
	/** The file held nothing at the moment asked for. */
	NoFile: ({ path, at }: { path: string; at: string | null }) => ({
		message: `${path} held nothing${at === null ? '' : ` at ${at}`}`,
		path,
		at,
	}),
	/** The bytes of the version asked for were purged; its row stays. */
	Purged: ({ path, at }: { path: string; at: string | null }) => ({
		message: `${path}'s bytes at ${at ?? 'its last change'} are no longer kept`,
		path,
		at,
	}),
	/** A mark is letters, digits, `.`, `_` and `-`, in segments joined by `/` (`isMarkName`). */
	BadMarkName: ({ mark }: { mark: string }) => ({
		message: `'${mark}' cannot be a mark: use letters, digits, ., _ and -, in segments joined by /`,
		mark,
	}),
	/** The folder has no change on the server to mark yet. */
	NothingToMark: () => ({
		message: 'The folder has no change on the server to mark yet.',
	}),
	/** The name marks another change, and the mark was not asked to move. */
	MarkTaken: ({ mark, seq }: { mark: string; seq: number }) => ({
		message: `${mark} marks change ${seq} already`,
		mark,
		seq,
	}),
	/** Versions a restore names are no longer kept on the server. */
	RestorePurged: ({ at, versions }: { at: string; versions: string[] }) => ({
		message: `Some versions at ${at} are no longer kept on the server: ${versions.join(', ')}`,
		at,
		versions,
	}),
	/** The folder changed on the server while restoring; restoring again reads it anew. */
	RestoreMoved: ({ paths }: { paths: string[] }) => ({
		message: `The folder changed on the server while restoring (${paths.join(', ')})`,
		paths,
	}),
	/** The server refused the restore for one path. */
	RestoreRefused: ({ path, reason }: { path: string; reason: string }) => ({
		message: reason,
		path,
		reason,
	}),
});
export type HistoryError = InferErrors<typeof HistoryError>;

/** A folder synced on this computer, by its directory's name in the Epicenter folder. */
export type HistoryTarget = {
	root: EpicenterRoot;
	account: RemoteAccount;
	/** The folder's directory, directly inside the Epicenter folder. */
	name: string;
};

/**
 * The folder `name`, synced here: where it is, its store, its record, and
 * its folder on the server (`folder`), whose log, files, and bytes are its
 * history; what an export reads.
 */
export async function syncedFolder({ root, account, name }: HistoryTarget) {
	const found = await identify({ root, account });
	if (found.error !== null) return found;
	const held = found.data.bound.find(({ local }) => local.name === name);
	if (held === undefined) return HistoryError.NotSynced({ folder: name });
	const { local, record } = held;
	return Ok({
		path: local.path,
		store: local.store,
		record,
		folder: folderRepository(account, record.folder),
	});
}

/**
 * The folder's changes, newest first, from `at` (the last when absent),
 * each with its marks; with `path`, only the changes to that file. `here`
 * is the change this computer last synced at.
 */
export async function folderLog({
	at,
	path,
	limit = 20,
	...target
}: HistoryTarget & {
	at?: string;
	path?: string;
	limit?: number;
}): Promise<
	Result<
		{ log: LoggedChange[]; here: number | null },
		HistoryError | Unavailable
	>
> {
	const folder = await syncedFolder(target);
	if (folder.error !== null) return folder;
	const changes = await folder.data.folder.log({ limit, at, path });
	if (changes.error !== null) return changes;
	const cursor = folder.data.record.cursor;
	const here =
		cursor === null ? null : Number(cursor.split('.')[1] ?? Number.NaN);
	return Ok({ log: changes.data, here });
}

/** One version of a file: the change that wrote it, who, when, and its marks. */
export type FileVersion = {
	seq: number;
	at: string;
	author: string;
	via: string;
	/** Null where the change deleted the file. */
	version: Version | null;
	size: number | null;
	marks: string[];
};

/** Each version of the file at `path` in the folder, newest first, from `at` (the last when absent). */
export async function fileHistory({
	path,
	at,
	limit = 50,
	...target
}: HistoryTarget & { path: string; at?: string; limit?: number }): Promise<
	Result<{ path: string; versions: FileVersion[] }, HistoryError | Unavailable>
> {
	const folder = await syncedFolder(target);
	if (folder.error !== null) return folder;
	const changes = await folder.data.folder.log({ limit, path, at });
	if (changes.error !== null) return changes;
	return Ok({
		path,
		versions: changes.data.map(({ seq, at, author, via, files, marks }) => ({
			seq,
			at,
			author,
			via,
			version: files[0]?.version ?? null,
			size: files[0]?.size ?? null,
			marks,
		})),
	});
}

/** The bytes of the file at `path` as the server holds it, or as it was at `at`. */
export async function fileAt({
	path,
	at,
	...target
}: HistoryTarget & { path: string; at?: string }): Promise<
	Result<
		{
			path: string;
			seq: number;
			version: Version;
			size: number | null;
			bytes: Uint8Array;
		},
		HistoryError | Unavailable
	>
> {
	const folder = await syncedFolder(target);
	if (folder.error !== null) return folder;
	const listed = await folder.data.folder.filesAt({ at, paths: [path] });
	if (listed.error !== null) return listed;
	const [file] = listed.data.files;
	if (file === undefined) return HistoryError.NoFile({ path, at: at ?? null });
	const read = await folder.data.folder.blobs([file.version]);
	if (read.error !== null) return read;
	const [bytes] = read.data;
	if (bytes == null) return HistoryError.Purged({ path, at: at ?? null });
	return Ok({
		path: file.path,
		seq: listed.data.seq,
		version: file.version,
		size: file.size,
		bytes,
	});
}

/** One file as the folder held it at a moment. */
export type FileAtMoment = {
	path: string;
	version: Version;
	size: number | null;
};

/** The folder's files as they were at `at`, each with its version and size. */
export async function folderAt({
	at,
	...target
}: HistoryTarget & { at: string }): Promise<
	Result<
		{ moment: string; seq: number; files: FileAtMoment[] },
		HistoryError | Unavailable
	>
> {
	const folder = await syncedFolder(target);
	if (folder.error !== null) return folder;
	const listed = await folder.data.folder.filesAt({ at });
	if (listed.error !== null) return listed;
	const files = listed.data.files
		.filter(({ path }) => !isHiddenPath(path))
		.map(({ path, version, size }) => ({ path, version, size }));
	return Ok({ moment: at, seq: listed.data.seq, files });
}

/** A file a diff names: added, changed, or deleted. */
export type DiffEntry = {
	path: string;
	change: 'added' | 'changed' | 'deleted';
};

/** Each path whose version differs between `before` and `after`, by path. */
function changed(
	before: ReadonlyMap<string, string>,
	after: ReadonlyMap<string, string>,
): DiffEntry[] {
	const out: DiffEntry[] = [];
	for (const [path, version] of after)
		if (!before.has(path)) out.push({ path, change: 'added' });
		else if (before.get(path) !== version)
			out.push({ path, change: 'changed' });
	for (const path of before.keys())
		if (!after.has(path)) out.push({ path, change: 'deleted' });
	return out
		.filter(({ path }) => !isHiddenPath(path))
		.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const versions = (files: { path: string; version: string }[]) =>
	new Map(files.map(({ path, version }) => [path, version]));

/**
 * The files this folder added, changed, or deleted since its last sync,
 * read from the folder alone; or, with `since`, the files the server
 * changed between that moment and now.
 */
export async function folderDiff({
	since,
	...target
}: HistoryTarget & { since?: string }): Promise<
	Result<
		{ since: string | null; diff: DiffEntry[] },
		HistoryError | Unavailable
	>
> {
	const folder = await syncedFolder(target);
	if (folder.error !== null) return folder;
	if (since === undefined) {
		const listed = await folder.data.store.list(['']);
		if (listed.error !== null) return listed;
		return Ok({
			since: null,
			diff: changed(
				new Map(Object.entries(folder.data.record.files)),
				versions(listed.data),
			),
		});
	}
	const [then, now] = await Promise.all([
		folder.data.folder.filesAt({ at: since }),
		folder.data.folder.filesAt(),
	]);
	if (then.error !== null) return then;
	if (now.error !== null) return now;
	return Ok({
		since,
		diff: changed(versions(then.data.files), versions(now.data.files)),
	});
}

/** What a restore wrote on the server. */
export type Restored = {
	moment: string;
	/** Where the folder is on this computer. */
	folder: string;
	written: string[];
	removed: string[];
	/** The log's head after it; the head before when nothing needed writing. */
	cursor: string | null;
};

/**
 * One change on the server that gives the folder's files (or the one at
 * `path`) back the versions they held at `at`, removing files made since.
 * It names versions the server holds, so no bytes travel.
 */
export async function restoreFolder({
	at,
	path,
	...target
}: HistoryTarget & { at: string; path?: string }): Promise<
	Result<Restored, HistoryError | Unavailable>
> {
	const folder = await syncedFolder(target);
	if (folder.error !== null) return folder;
	const only = path === undefined ? undefined : [path];
	const [then, now] = await Promise.all([
		folder.data.folder.filesAt({ at, paths: only }),
		folder.data.folder.filesAt({ paths: only }),
	]);
	if (then.error !== null) return then;
	if (now.error !== null) return now;
	const visible = (files: { path: string; version: string }[]) =>
		versions(files.filter(({ path }) => !isHiddenPath(path)));
	const was = visible(then.data.files);
	const is = visible(now.data.files);
	const writes = [
		...[...was]
			.filter(([path, version]) => is.get(path) !== version)
			.map(([path, version]) => ({
				path,
				expect: is.get(path) ?? null,
				version,
			})),
		...[...is.keys()]
			.filter((path) => !was.has(path))
			.map((path) => ({ path, expect: is.get(path) ?? null, version: null })),
	] as NamedWrite[];
	const paths = (list: NamedWrite[]) => list.map(({ path }) => path).sort();
	const restored = (cursor: string | null): Restored => ({
		moment: at,
		folder: folder.data.path,
		written: paths(writes.filter(({ version }) => version !== null)),
		removed: paths(writes.filter(({ version }) => version === null)),
		cursor,
	});
	if (writes.length === 0) return Ok(restored(now.data.cursor));
	const landed = await folder.data.folder.appendVersions(writes);
	if (landed.error !== null) return landed;
	if ('missing' in landed.data)
		return HistoryError.RestorePurged({ at, versions: landed.data.missing });
	if ('moved' in landed.data)
		return HistoryError.RestoreMoved({
			paths: landed.data.moved.map(({ path }) => path),
		});
	if ('refused' in landed.data)
		return HistoryError.RestoreRefused({
			path: landed.data.refused,
			reason: landed.data.reason,
		});
	return Ok(restored(landed.data.cursor));
}

/** The folder's marks, each with the change it names. */
export async function folderMarks(
	target: HistoryTarget,
): Promise<Result<Mark[], HistoryError | Unavailable>> {
	const folder = await syncedFolder(target);
	if (folder.error !== null) return folder;
	return folder.data.folder.marks();
}

/**
 * Name the folder's last change on the server `mark`, so the log, a file's
 * history, and a restore reach it by name, and an export writes it as a Git
 * tag (ADR-0826). A name that marks another change stays unless `move`.
 */
export async function markFolder({
	mark,
	move = false,
	...target
}: HistoryTarget & { mark: string; move?: boolean }): Promise<
	Result<Mark, HistoryError | Unavailable>
> {
	if (!isMarkName(mark)) return HistoryError.BadMarkName({ mark });
	const folder = await syncedFolder(target);
	if (folder.error !== null) return folder;
	const marked = await folder.data.folder.mark(mark, { move });
	if (marked.error !== null) return marked;
	if ('empty' in marked.data) return HistoryError.NothingToMark();
	if ('taken' in marked.data)
		return HistoryError.MarkTaken({ mark, seq: marked.data.taken.seq });
	return Ok(marked.data.mark);
}
