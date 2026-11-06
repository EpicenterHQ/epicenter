/**
 * A folder's history, read through Epicenter (ADR-0824, ADR-0826):
 * `epicenter log`, `history <path>`, `show <path>`, `diff`, `at <moment>`,
 * `restore <moment>`, and `mark <name>`. The folder is one synced here; its
 * history is its log on the server, one change per save, and a moment in
 * it is a change's number, a mark's name, or a time (ISO 8601, or anything
 * `Date` reads).
 *
 * `restore` is a forward change on the server: each file named takes back
 * the version it held at the moment, naming a version the server holds, so
 * no bytes travel. The next `epicenter sync` brings it here.
 *
 * Exit codes: 0 done, 2 what the command cannot use (not synced here, no
 * such moment, the server out of reach).
 */
import { join, relative, resolve, sep } from 'node:path';
import { isHiddenPath } from '@epicenter/definition/contract';
import { isMarkName } from '@epicenter/definition/site';
import { identify } from '@epicenter/folder/platform';
import { folderRepository, type LoggedChange } from '@epicenter/folder/sync';
import { Err, Ok } from 'wellcrafted/result';
import { authContext } from '../auth.ts';
import { folderNameIn, homeRoot } from '../folder-commands.ts';
import { count, EXIT, fail, writeJson, writeOut } from '../output.ts';
import { signedInAccount } from './account.ts';

type Options = Record<string, string | true>;

/** The folder `name` (in the Epicenter folder) synced here, and its folder on the server, or the message to fail with. */
async function bound(name: string) {
	const root = homeRoot();
	const account = signedInAccount(authContext());
	const found = await identify({ root, account });
	if (found.error !== null) return Err(found.error.message);
	const held = found.data.bound.find(({ local }) => local.name === name);
	const path = join(root.path, name);
	if (held === undefined)
		return Err(
			`${path} is not synced on this computer: run epicenter sync on it first`,
		);
	const { local, record } = held;
	return Ok({
		path,
		store: local.store,
		record,
		folder: folderRepository(account, record.folder),
	});
}

/** The folder `dir` names (this directory by default), synced here. */
export async function syncedFolder(dir: string | undefined) {
	const name = await folderNameIn(homeRoot(), dir ?? '.');
	if (name.error !== null) return Err(name.error);
	return bound(name.data);
}

/** The synced folder holding the file `target` names on disk, and the file's path in it. */
async function fileIn(target: string) {
	const root = homeRoot();
	const inside = relative(root.path, resolve(target));
	const [name, ...rest] = inside.split(sep);
	if (
		inside.startsWith('..') ||
		name === undefined ||
		name === '' ||
		rest.length === 0
	)
		return Err(`${resolve(target)} is not a file in a folder in ${root.path}`);
	const at = await bound(name);
	if (at.error !== null) return at;
	return Ok({ ...at.data, file: rest.join('/') });
}

/** The seq of a cursor, `<epoch>.<seq>`, or null. */
const seqOf = (cursor: string | null) =>
	cursor === null ? null : Number(cursor.split('.')[1] ?? Number.NaN);

/** A change's time, as a person reads it: `2026-11-07 09:15`. */
const shortTime = (at: string) => at.slice(0, 16).replace('T', ' ');

/** An author without their email, for a line of the log. */
const nameOf = (author: string) => author.replace(/\s*<[^>]*>$/, '') || author;

function printChanges(
	changes: LoggedChange[],
	{ here, json, key }: { here: number | null; json: boolean; key: string },
) {
	if (json) {
		writeJson({ [key]: changes });
		return EXIT.ok;
	}
	if (changes.length === 0) {
		writeOut('No history yet.');
		return EXIT.ok;
	}
	writeOut(
		changes
			.map((change) => {
				const what =
					change.files.length === 1
						? `${change.files[0]?.version === null ? 'deleted ' : ''}${change.files[0]?.path}`
						: count(change.files.length, 'file');
				const marks = change.marks.map((mark) => `  [${mark}]`).join('');
				const subject = change.message?.split('\n')[0];
				return `${String(change.seq).padStart(5)}  ${shortTime(change.at)}  ${nameOf(change.author)}  ${what}${subject ? `  ${subject}` : ''}${marks}${change.seq === here ? '  (this folder)' : ''}`;
			})
			.join('\n'),
	);
	return EXIT.ok;
}

const limitOf = (options: Options, fallback: number) => {
	const limit = options.limit === undefined ? fallback : Number(options.limit);
	return Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000
		? limit
		: null;
};

/**
 * `epicenter log [<dir>] [--path <path>] [--at <moment>] [--limit <n>]`:
 * the folder's changes, newest first, from `--at` (the last when absent),
 * each with its marks; with `--path`, only the changes to that file.
 */
export async function logCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
) {
	const limit = limitOf(options, 20);
	if (limit === null) return fail('--limit is a whole number, 1 to 1000', json);
	const at = await syncedFolder(dir);
	if (at.error !== null) return fail(at.error, json);
	const log = await at.data.folder.log({
		limit,
		at: typeof options.at === 'string' ? options.at : undefined,
		path: typeof options.path === 'string' ? options.path : undefined,
	});
	if (log.error !== null) return fail(log.error.message, json);
	return printChanges(log.data, {
		here: seqOf(at.data.record.cursor),
		json,
		key: 'log',
	});
}

/**
 * `epicenter history <path> [--at <moment>] [--limit <n>]`: each version
 * of one file, newest first, who wrote it, and when.
 */
export async function historyCommand(
	target: string,
	options: Options,
	json: boolean,
) {
	const limit = limitOf(options, 50);
	if (limit === null) return fail('--limit is a whole number, 1 to 1000', json);
	const at = await fileIn(target);
	if (at.error !== null) return fail(at.error, json);
	const log = await at.data.folder.log({
		limit,
		path: at.data.file,
		at: typeof options.at === 'string' ? options.at : undefined,
	});
	if (log.error !== null) return fail(log.error.message, json);
	if (json) {
		writeJson({
			history: {
				path: at.data.file,
				versions: log.data.map(({ seq, at, author, via, files, marks }) => ({
					seq,
					at,
					author,
					via,
					version: files[0]?.version ?? null,
					size: files[0]?.size ?? null,
					marks,
				})),
			},
		});
		return EXIT.ok;
	}
	writeOut(
		log.data.length === 0
			? `${at.data.file} has no history on the server.`
			: log.data
					.map(({ seq, at, author, files, marks }) => {
						const [file] = files;
						const what =
							file?.version == null
								? 'deleted'
								: `${file.version.slice(0, 10)}  ${count(file.size ?? 0, 'byte')}`;
						return `${String(seq).padStart(5)}  ${shortTime(at)}  ${nameOf(author)}  ${what}${marks.map((mark) => `  [${mark}]`).join('')}`;
					})
					.join('\n'),
	);
	return EXIT.ok;
}

/**
 * `epicenter show <path> [--at <moment>]`: the file's bytes on the server,
 * as they are or as they were at a moment, on stdout.
 */
export async function showCommand(
	target: string,
	options: Options,
	json: boolean,
) {
	const at = await fileIn(target);
	if (at.error !== null) return fail(at.error, json);
	const moment = typeof options.at === 'string' ? options.at : undefined;
	const listed = await at.data.folder.filesAt({
		at: moment,
		paths: [at.data.file],
	});
	if (listed.error !== null) return fail(listed.error.message, json);
	const [file] = listed.data.files;
	if (file === undefined)
		return fail(
			`${at.data.file} held nothing${moment === undefined ? '' : ` at ${moment}`}`,
			json,
		);
	const [bytes] = (await at.data.folder.blobs([file.version])).data ?? [];
	if (bytes == null)
		return fail(
			`${at.data.file}'s bytes at ${moment ?? 'its last change'} are no longer kept`,
			json,
		);
	if (json) {
		writeJson({
			show: {
				path: file.path,
				seq: listed.data.seq,
				version: file.version,
				size: file.size,
				text: new TextDecoder().decode(bytes),
			},
		});
		return EXIT.ok;
	}
	process.stdout.write(bytes);
	return EXIT.ok;
}

/**
 * `epicenter at <moment> [<dir>]`: the folder's files as they were at a
 * moment, each with its size and version.
 */
export async function atCommand(
	moment: string,
	dir: string | undefined,
	json: boolean,
) {
	const at = await syncedFolder(dir);
	if (at.error !== null) return fail(at.error, json);
	const listed = await at.data.folder.filesAt({ at: moment });
	if (listed.error !== null) return fail(listed.error.message, json);
	const files = listed.data.files.filter(({ path }) => !isHiddenPath(path));
	if (json) {
		writeJson({ at: { moment, seq: listed.data.seq, files } });
		return EXIT.ok;
	}
	writeOut(
		files.length === 0
			? `The folder held no files at ${moment} (change ${listed.data.seq}).`
			: [
					`At change ${listed.data.seq}:`,
					...files.map(
						({ path, version, size }) =>
							`  ${version.slice(0, 10)}  ${String(size ?? 0).padStart(9)}  ${path}`,
					),
				].join('\n'),
	);
	return EXIT.ok;
}

type Change = { path: string; change: 'added' | 'changed' | 'deleted' };

const CHANGE_MARK = { added: 'A', changed: 'M', deleted: 'D' } as const;

function printDiff(changes: Change[], json: boolean, empty: string) {
	changes.sort((a, b) => (a.path < b.path ? -1 : 1));
	if (json) writeJson({ diff: changes });
	else
		writeOut(
			changes.length === 0
				? empty
				: changes
						.map(({ path, change }) => `${CHANGE_MARK[change]}  ${path}`)
						.join('\n'),
		);
	return EXIT.ok;
}

/** Each path whose version differs between `before` and `after`. */
function changed(
	before: ReadonlyMap<string, string>,
	after: ReadonlyMap<string, string>,
): Change[] {
	const out: Change[] = [];
	for (const [path, version] of after)
		if (!before.has(path)) out.push({ path, change: 'added' });
		else if (before.get(path) !== version)
			out.push({ path, change: 'changed' });
	for (const path of before.keys())
		if (!after.has(path)) out.push({ path, change: 'deleted' });
	return out.filter(({ path }) => !isHiddenPath(path));
}

/**
 * `epicenter diff [<dir>] [--since <moment>]`: the files this folder added,
 * changed, or deleted since its last sync, read from the folder alone; or,
 * with `--since`, the files the server changed between that moment and now.
 */
export async function diffCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
) {
	const at = await syncedFolder(dir);
	if (at.error !== null) return fail(at.error, json);
	if (typeof options.since !== 'string') {
		const listed = await at.data.store.list(['']);
		if (listed.error !== null) return fail(listed.error.message, json);
		return printDiff(
			changed(
				new Map(Object.entries(at.data.record.files)),
				new Map(listed.data.map(({ path, version }) => [path, version])),
			),
			json,
			'Nothing changed since the last sync.',
		);
	}
	const [then, now] = await Promise.all([
		at.data.folder.filesAt({ at: options.since }),
		at.data.folder.filesAt(),
	]);
	if (then.error !== null) return fail(then.error.message, json);
	if (now.error !== null) return fail(now.error.message, json);
	const versions = (files: { path: string; version: string }[]) =>
		new Map(files.map(({ path, version }) => [path, version]));
	return printDiff(
		changed(versions(then.data.files), versions(now.data.files)),
		json,
		`Nothing changed since ${options.since}.`,
	);
}

/**
 * `epicenter restore <moment> [<dir>] [--path <path>]`: one change on the
 * server that gives the folder's files (or the one at `--path`) back the
 * versions they held at the moment, removing files made since. It names
 * versions the server holds, so no bytes travel; the next sync brings it
 * here, and the history keeps everything in between.
 */
export async function restoreCommand(
	moment: string,
	dir: string | undefined,
	options: Options,
	json: boolean,
) {
	const at = await syncedFolder(dir);
	if (at.error !== null) return fail(at.error, json);
	const only = typeof options.path === 'string' ? [options.path] : undefined;
	const [then, now] = await Promise.all([
		at.data.folder.filesAt({ at: moment, paths: only }),
		at.data.folder.filesAt({ paths: only }),
	]);
	if (then.error !== null) return fail(then.error.message, json);
	if (now.error !== null) return fail(now.error.message, json);
	const was = new Map(
		then.data.files
			.filter(({ path }) => !isHiddenPath(path))
			.map(({ path, version }) => [path, version]),
	);
	const is = new Map(
		now.data.files
			.filter(({ path }) => !isHiddenPath(path))
			.map(({ path, version }) => [path, version]),
	);
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
	];
	const written = writes.filter(({ version }) => version !== null);
	const removed = writes.filter(({ version }) => version === null);
	if (writes.length === 0) {
		if (json)
			writeJson({
				restored: {
					moment,
					folder: at.data.path,
					written: [],
					removed: [],
					cursor: now.data.cursor,
				},
			});
		else writeOut(`${at.data.path} already holds what it held at ${moment}.`);
		return EXIT.ok;
	}
	const landed = await at.data.folder.commitVersions(writes);
	if (landed.error !== null) return fail(landed.error.message, json);
	if ('missing' in landed.data)
		return fail(
			`Some versions at ${moment} are no longer kept on the server: ${landed.data.missing.join(', ')}`,
			json,
		);
	if ('moved' in landed.data)
		return fail(
			`The folder changed on the server while restoring (${landed.data.moved.map(({ path }) => path).join(', ')}); run restore again.`,
			json,
		);
	if ('refused' in landed.data) return fail(landed.data.reason, json);
	const paths = (list: typeof writes) => list.map(({ path }) => path).sort();
	if (json)
		writeJson({
			restored: {
				moment,
				folder: at.data.path,
				written: paths(written),
				removed: paths(removed),
				cursor: landed.data.cursor,
			},
		});
	else
		writeOut(
			`${at.data.path}: ${count(written.length, 'file')} restored and ${count(removed.length, 'file')} removed on the server as at ${moment}; run epicenter sync to bring it here`,
		);
	return EXIT.ok;
}

/**
 * `epicenter mark [<name>] [<dir>] [--move]`: name the folder's last change
 * on the server, so `log`, `history`, `at`, and `restore` reach it, and the
 * export writes it as a Git tag (ADR-0826). A name that marks another
 * change stays unless `--move`. Without a name, the folder's marks.
 */
export async function markCommand(
	name: string | undefined,
	dir: string | undefined,
	options: Options,
	json: boolean,
) {
	const at = await syncedFolder(dir);
	if (at.error !== null) return fail(at.error, json);
	if (name === undefined) {
		const marks = await at.data.folder.marks();
		if (marks.error !== null) return fail(marks.error.message, json);
		if (json) writeJson({ marks: marks.data });
		else
			writeOut(
				marks.data.length === 0
					? 'No marks yet.'
					: marks.data
							.map(
								({ name, seq, at }) =>
									`${String(seq).padStart(5)}  ${shortTime(at)}  ${name}`,
							)
							.join('\n'),
			);
		return EXIT.ok;
	}
	if (!isMarkName(name))
		return fail(
			`'${name}' cannot be a mark: use letters, digits, ., _ and -, in segments joined by /`,
			json,
		);
	const marked = await at.data.folder.mark(name, {
		move: options.move === true,
	});
	if (marked.error !== null) return fail(marked.error.message, json);
	if ('empty' in marked.data)
		return fail('The folder has no change on the server to mark yet.', json);
	if ('taken' in marked.data)
		return fail(
			`${name} marks change ${marked.data.taken.seq} already; give --move to move it.`,
			json,
		);
	if (json) writeJson({ mark: marked.data.mark });
	else writeOut(`${name} marks change ${marked.data.mark.seq}.`);
	return EXIT.ok;
}
