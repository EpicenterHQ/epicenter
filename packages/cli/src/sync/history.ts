/**
 * A folder's history on the command line (ADR-0824, ADR-0826): `epicenter
 * log`, `history <path>`, `show <path>`, `diff`, `at <moment>`, `restore
 * <moment>`, and `mark <name>`, each over its function in
 * `@epicenter/folder/platform` (`history.ts`). This module names the folder
 * from a path on disk and prints the answer.
 *
 * Exit codes: 0 done, 2 what the operation cannot use (not synced here, no
 * such moment, the server out of reach).
 */
import { join, relative, resolve, sep } from 'node:path';
import {
	fileAt,
	fileHistory,
	folderAt,
	folderDiff,
	folderLog,
	folderMarks,
	type HistoryError,
	type HistoryTarget,
	markFolder,
	restoreFolder,
} from '@epicenter/folder/platform';
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

/** The folder `name` in the Epicenter folder, as the history functions name it. */
function targetOf(name: string): HistoryTarget {
	return { root: homeRoot(), account: signedInAccount(authContext()), name };
}

/** The folder `dir` names (this directory by default). */
export async function folderTarget(dir: string | undefined) {
	const name = await folderNameIn(homeRoot(), dir ?? '.');
	if (name.error !== null) return Err(name.error);
	return Ok(targetOf(name.data));
}

/** The folder holding the file `target` names on disk, and the file's path in it. */
function fileIn(target: string) {
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
	return Ok({ target: targetOf(name), path: rest.join('/') });
}

/** What the command line says of a history error: its message, and what to run when that helps. */
export function messageOf(
	error: HistoryError | { message: string },
	{ name }: Partial<HistoryTarget> = {},
): string {
	if (!('name' in error)) return error.message;
	switch (error.name) {
		case 'NotSynced':
			return `${join(homeRoot().path, name ?? '')} is not synced on this computer: run epicenter sync on it first`;
		case 'MarkTaken':
			return `${error.message}; give --move to move it.`;
		case 'RestoreMoved':
			return `${error.message}; run restore again.`;
		default:
			return error.message;
	}
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
	async run({ dir, path, at, limit }) {
		const target = await folderTarget(dir);
		if (target.error !== null) return target;
		const read = await folderLog({ ...target.data, at, path, limit });
		if (read.error !== null) return Err(messageOf(read.error, target.data));
		return Ok({ output: read.data });
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
	async run({ path, at, limit }) {
		const file = fileIn(path);
		if (file.error !== null) return file;
		const { target } = file.data;
		const read = await fileHistory({
			...target,
			path: file.data.path,
			at,
			limit,
		});
		if (read.error !== null) return Err(messageOf(read.error, target));
		return Ok({ output: { history: read.data } });
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
	async run({ path, at }) {
		const file = fileIn(path);
		if (file.error !== null) return file;
		const { target } = file.data;
		const read = await fileAt({ ...target, path: file.data.path, at });
		if (read.error !== null) return Err(messageOf(read.error, target));
		const { bytes, ...shown } = read.data;
		let text: string | undefined;
		try {
			text = strictUtf8.decode(bytes);
		} catch {
			text = undefined;
		}
		return Ok({
			output: {
				show: {
					...shown,
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
		const target = await folderTarget(dir);
		if (target.error !== null) return target;
		const read = await folderAt({ ...target.data, at: moment });
		if (read.error !== null) return Err(messageOf(read.error, target.data));
		return Ok({ output: { at: read.data } });
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

const CHANGE_MARK = { added: 'A', changed: 'M', deleted: 'D' } as const;

/**
 * `epicenter diff [<dir>] [--since <moment>]`: the files this folder added,
 * changed, or deleted since its last sync, read from the folder alone; or,
 * with `--since`, the files the server changed between that moment and now.
 */
export const diff: ImplementationOf<typeof diffOperation> = {
	async run({ dir, since }) {
		const target = await folderTarget(dir);
		if (target.error !== null) return target;
		const read = await folderDiff({ ...target.data, since });
		if (read.error !== null) return Err(messageOf(read.error, target.data));
		return Ok({ output: read.data });
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
 * versions they held at the moment, removing files made since. The next
 * sync brings it here.
 */
export const restore: ImplementationOf<typeof restoreOperation> = {
	async run({ moment, dir, path }) {
		const target = await folderTarget(dir);
		if (target.error !== null) return target;
		const read = await restoreFolder({ ...target.data, at: moment, path });
		if (read.error !== null) return Err(messageOf(read.error, target.data));
		return Ok({ output: { restored: read.data } });
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
		const target = await folderTarget(dir);
		if (target.error !== null) return target;
		if (name === undefined) {
			const marks = await folderMarks(target.data);
			if (marks.error !== null) return Err(messageOf(marks.error, target.data));
			return Ok({ output: { marks: marks.data } });
		}
		const marked = await markFolder({ ...target.data, mark: name, move });
		if (marked.error !== null) return Err(messageOf(marked.error, target.data));
		return Ok({ output: { mark: marked.data } });
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
