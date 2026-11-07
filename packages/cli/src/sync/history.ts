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
 * Exit codes: 0 done, 2 what the operation cannot use (not synced here, no
 * such moment, the server out of reach).
 */
import { join, relative, resolve, sep } from 'node:path';
import { isHiddenPath } from '@epicenter/definition/contract';
import { isMarkName } from '@epicenter/definition/site';
import { identify } from '@epicenter/folder/platform';
import { folderRepository } from '@epicenter/folder/sync';
import { Err, Ok } from 'wellcrafted/result';
import { authContext } from '../auth.ts';
import { folderNameIn, homeRoot } from '../folder-commands.ts';
import type { ImplementationOf } from '../operation.ts';
import type {
	at as atOperation,
	diff as diffOperation,
	history as historyOperation,
	log as logOperation,
	mark as markOperation,
	restore as restoreOperation,
	show as showOperation,
} from '../operations.ts';
import { count, writeOut } from '../output.ts';
import { signedInAccount } from './account.ts';

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

/** A change's time, as a person reads it: `2026-11-07 09:15`. */
const shortTime = (at: string) => at.slice(0, 16).replace('T', ' ');

/** An author without their email, for a line of the log. */
const nameOf = (author: string) => author.replace(/\s*<[^>]*>$/, '') || author;

/**
 * `epicenter log [<dir>] [--path <path>] [--at <moment>] [--limit <n>]`:
 * the folder's changes, newest first, from `--at` (the last when absent),
 * each with its marks; with `--path`, only the changes to that file.
 */
export const log: ImplementationOf<typeof logOperation> = {
	async run({ dir, path, at: moment, limit = 20 }) {
		const at = await syncedFolder(dir);
		if (at.error !== null) return at;
		const changes = await at.data.folder.log({ limit, at: moment, path });
		if (changes.error !== null) return Err(changes.error.message);
		const cursor = at.data.record.cursor;
		const here =
			cursor === null ? null : Number(cursor.split('.')[1] ?? Number.NaN);
		return Ok({ output: { log: changes.data, here } });
	},
	print({ log: changes, here }) {
		if (changes.length === 0) {
			writeOut('No history yet.');
			return;
		}
		writeOut(
			changes
				.map((change) => {
					const [only] = change.files;
					const what =
						change.files.length === 1
							? `${only?.version === null ? 'deleted ' : ''}${only?.path}`
							: count(change.files.length, 'file');
					const marks = change.marks.map((mark) => `  [${mark}]`).join('');
					const subject = change.message?.split('\n')[0];
					return `${String(change.seq).padStart(5)}  ${shortTime(change.at)}  ${nameOf(change.author)}  ${what}${subject ? `  ${subject}` : ''}${marks}${change.seq === here ? '  (this folder)' : ''}`;
				})
				.join('\n'),
		);
	},
};

/**
 * `epicenter history <path> [--at <moment>] [--limit <n>]`: each version
 * of one file, newest first, who wrote it, and when.
 */
export const history: ImplementationOf<typeof historyOperation> = {
	async run({ path, at: moment, limit = 50 }) {
		const at = await fileIn(path);
		if (at.error !== null) return at;
		const changes = await at.data.folder.log({
			limit,
			path: at.data.file,
			at: moment,
		});
		if (changes.error !== null) return Err(changes.error.message);
		return Ok({
			output: {
				history: {
					path: at.data.file,
					versions: changes.data.map(
						({ seq, at, author, via, files, marks }) => ({
							seq,
							at,
							author,
							via,
							version: files[0]?.version ?? null,
							size: files[0]?.size ?? null,
							marks,
						}),
					),
				},
			},
		});
	},
	print({ history: { path, versions } }) {
		writeOut(
			versions.length === 0
				? `${path} has no history on the server.`
				: versions
						.map(({ seq, at, author, version, size, marks }) => {
							const what =
								version === null
									? 'deleted'
									: `${version.slice(0, 10)}  ${count(size ?? 0, 'byte')}`;
							return `${String(seq).padStart(5)}  ${shortTime(at)}  ${nameOf(author)}  ${what}${marks.map((mark) => `  [${mark}]`).join('')}`;
						})
						.join('\n'),
		);
	},
};

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * `epicenter show <path> [--at <moment>]`: the file's bytes on the server,
 * as they are or as they were at a moment, on stdout.
 */
export const show: ImplementationOf<typeof showOperation> = {
	async run({ path, at: moment }) {
		const at = await fileIn(path);
		if (at.error !== null) return at;
		const listed = await at.data.folder.filesAt({
			at: moment,
			paths: [at.data.file],
		});
		if (listed.error !== null) return Err(listed.error.message);
		const [file] = listed.data.files;
		if (file === undefined)
			return Err(
				`${at.data.file} held nothing${moment === undefined ? '' : ` at ${moment}`}`,
			);
		const read = await at.data.folder.blobs([file.version]);
		if (read.error !== null) return Err(read.error.message);
		const [bytes] = read.data;
		if (bytes == null)
			return Err(
				`${at.data.file}'s bytes at ${moment ?? 'its last change'} are no longer kept`,
			);
		let text: string | undefined;
		try {
			text = strictUtf8.decode(bytes);
		} catch {
			text = undefined;
		}
		return Ok({
			output: {
				show: {
					path: file.path,
					seq: listed.data.seq,
					version: file.version,
					size: file.size,
					...(text === undefined
						? { base64: Buffer.from(bytes).toString('base64') }
						: { text }),
				},
			},
		});
	},
	print({ show: { text, base64 } }) {
		process.stdout.write(
			text === undefined ? Buffer.from(base64 ?? '', 'base64') : text,
		);
	},
};

/**
 * `epicenter at <moment> [<dir>]`: the folder's files as they were at a
 * moment, each with its size and version.
 */
export const at: ImplementationOf<typeof atOperation> = {
	async run({ moment, dir }) {
		const at = await syncedFolder(dir);
		if (at.error !== null) return at;
		const listed = await at.data.folder.filesAt({ at: moment });
		if (listed.error !== null) return Err(listed.error.message);
		const files = listed.data.files.filter(({ path }) => !isHiddenPath(path));
		return Ok({ output: { at: { moment, seq: listed.data.seq, files } } });
	},
	print({ at: { moment, seq, files } }) {
		writeOut(
			files.length === 0
				? `The folder held no files at ${moment} (change ${seq}).`
				: [
						`At change ${seq}:`,
						...files.map(
							({ path, version, size }) =>
								`  ${version.slice(0, 10)}  ${String(size ?? 0).padStart(9)}  ${path}`,
						),
					].join('\n'),
		);
	},
};

type Change = { path: string; change: 'added' | 'changed' | 'deleted' };

const CHANGE_MARK = { added: 'A', changed: 'M', deleted: 'D' } as const;

/** Each path whose version differs between `before` and `after`, by path. */
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
	return out
		.filter(({ path }) => !isHiddenPath(path))
		.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * `epicenter diff [<dir>] [--since <moment>]`: the files this folder added,
 * changed, or deleted since its last sync, read from the folder alone; or,
 * with `--since`, the files the server changed between that moment and now.
 */
export const diff: ImplementationOf<typeof diffOperation> = {
	async run({ dir, since }) {
		const at = await syncedFolder(dir);
		if (at.error !== null) return at;
		if (since === undefined) {
			const listed = await at.data.store.list(['']);
			if (listed.error !== null) return Err(listed.error.message);
			return Ok({
				output: {
					since: null,
					diff: changed(
						new Map(Object.entries(at.data.record.files)),
						new Map(listed.data.map(({ path, version }) => [path, version])),
					),
				},
			});
		}
		const [then, now] = await Promise.all([
			at.data.folder.filesAt({ at: since }),
			at.data.folder.filesAt(),
		]);
		if (then.error !== null) return Err(then.error.message);
		if (now.error !== null) return Err(now.error.message);
		const versions = (files: { path: string; version: string }[]) =>
			new Map(files.map(({ path, version }) => [path, version]));
		return Ok({
			output: {
				since,
				diff: changed(versions(then.data.files), versions(now.data.files)),
			},
		});
	},
	print({ diff: changes, since }) {
		writeOut(
			changes.length === 0
				? `Nothing changed since ${since ?? 'the last sync'}.`
				: changes
						.map(({ path, change }) => `${CHANGE_MARK[change]}  ${path}`)
						.join('\n'),
		);
	},
};

/**
 * `epicenter restore <moment> [<dir>] [--path <path>]`: one change on the
 * server that gives the folder's files (or the one at `--path`) back the
 * versions they held at the moment, removing files made since. It names
 * versions the server holds, so no bytes travel; the next sync brings it
 * here, and the history keeps everything in between.
 */
export const restore: ImplementationOf<typeof restoreOperation> = {
	async run({ moment, dir, path }) {
		const at = await syncedFolder(dir);
		if (at.error !== null) return at;
		const only = path === undefined ? undefined : [path];
		const [then, now] = await Promise.all([
			at.data.folder.filesAt({ at: moment, paths: only }),
			at.data.folder.filesAt({ paths: only }),
		]);
		if (then.error !== null) return Err(then.error.message);
		if (now.error !== null) return Err(now.error.message);
		const visible = (files: { path: string; version: string }[]) =>
			new Map(
				files
					.filter(({ path }) => !isHiddenPath(path))
					.map(({ path, version }) => [path, version]),
			);
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
				.map((path) => ({
					path,
					expect: is.get(path) ?? null,
					version: null,
				})),
		];
		const paths = (list: typeof writes) => list.map(({ path }) => path).sort();
		const restored = (cursor: string | null) => ({
			moment,
			folder: at.data.path,
			written: paths(writes.filter(({ version }) => version !== null)),
			removed: paths(writes.filter(({ version }) => version === null)),
			cursor,
		});
		if (writes.length === 0)
			return Ok({ output: { restored: restored(now.data.cursor) } });
		const landed = await at.data.folder.commitVersions(writes as never);
		if (landed.error !== null) return Err(landed.error.message);
		if ('missing' in landed.data)
			return Err(
				`Some versions at ${moment} are no longer kept on the server: ${landed.data.missing.join(', ')}`,
			);
		if ('moved' in landed.data)
			return Err(
				`The folder changed on the server while restoring (${landed.data.moved.map(({ path }) => path).join(', ')}); run restore again.`,
			);
		if ('refused' in landed.data) return Err(landed.data.reason);
		return Ok({ output: { restored: restored(landed.data.cursor) } });
	},
	print({ restored: { moment, folder, written, removed } }) {
		writeOut(
			written.length + removed.length === 0
				? `${folder} already holds what it held at ${moment}.`
				: `${folder}: ${count(written.length, 'file')} restored and ${count(removed.length, 'file')} removed on the server as at ${moment}; run epicenter sync to bring it here`,
		);
	},
};

/**
 * `epicenter mark [<name>] [<dir>] [--move]`: name the folder's last change
 * on the server, so `log`, `history`, `at`, and `restore` reach it, and the
 * export writes it as a Git tag (ADR-0826). A name that marks another
 * change stays unless `--move`. Without a name, the folder's marks.
 */
export const mark: ImplementationOf<typeof markOperation> = {
	async run({ name, dir, move = false }) {
		const at = await syncedFolder(dir);
		if (at.error !== null) return at;
		if (name === undefined) {
			const marks = await at.data.folder.marks();
			if (marks.error !== null) return Err(marks.error.message);
			return Ok({ output: { marks: marks.data } });
		}
		if (!isMarkName(name))
			return Err(
				`'${name}' cannot be a mark: use letters, digits, ., _ and -, in segments joined by /`,
			);
		const marked = await at.data.folder.mark(name, { move });
		if (marked.error !== null) return Err(marked.error.message);
		if ('empty' in marked.data)
			return Err('The folder has no change on the server to mark yet.');
		if ('taken' in marked.data)
			return Err(
				`${name} marks change ${marked.data.taken.seq} already; give --move to move it.`,
			);
		return Ok({ output: { mark: marked.data.mark } });
	},
	print(output) {
		if (output.mark !== undefined) {
			writeOut(`${output.mark.name} marks change ${output.mark.seq}.`);
			return;
		}
		const marks = output.marks ?? [];
		writeOut(
			marks.length === 0
				? 'No marks yet.'
				: marks
						.map(
							({ name, seq, at }) =>
								`${String(seq).padStart(5)}  ${shortTime(at)}  ${name}`,
						)
						.join('\n'),
		);
	},
};
