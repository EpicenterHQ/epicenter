/**
 * The commit rule (ADR-0850): every writer commits exactly what it wrote.
 *
 * An action's folder writes through a `WriteLog`. Immediately before each
 * write lands, the log checks that the path still holds what Git or this
 * action last put there, and refuses it otherwise; once the write lands, it
 * stores the bytes as a Git object (`git hash-object -w --path`, so the
 * path's filters apply as `git add` would). When the action ends, returned or
 * thrown, `commitWrites` builds a commit from HEAD plus exactly those objects
 * in a temporary index and moves the branch only if it still points where
 * the commit was built (compare-and-swap). What is on disk when Git looks is
 * never what gets committed, so an edit someone saves after the action's
 * write stays an uncommitted change on top, and is named.
 *
 * A path marked for Git LFS is refused before it lands unless `git-lfs` is
 * installed and its filter set up, since Git without the filter stores the
 * whole file (ADR-0856).
 *
 * The limit, stated: the check and the rename are two steps, so an editor
 * save landing between them can be overwritten. Writes an action makes
 * around `folder` (through `folder.path`) are not recorded and not committed.
 */
import { randomUUID } from 'node:crypto';
import {
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkedGit, git, gitPath, revParse } from './git.ts';
import type { Commit, PathState, RefusalReason, Refused } from './report.ts';

const ZERO = '0000000000000000000000000000000000000000';

/** A refused write, with its one message and the command that resolves it. */
function refusal(folder: string, path: string, reason: RefusalReason): Refused {
	const status = `git -C ${folder} status -- ${path}`;
	switch (reason) {
		case 'uncommitted':
			return {
				path,
				reason,
				message: `${path} has changes you have not committed, so the action did not write it`,
				next: status,
			};
		case 'changed-during':
			return {
				path,
				reason,
				message: `${path} changed during the run, so the action did not overwrite it`,
				next: status,
			};
		case 'symlink':
			return {
				path,
				reason,
				message: `${path} is a symbolic link, so the action did not write through it`,
			};
		case 'lfs-not-installed':
			return {
				path,
				reason,
				message: `${path} goes through Git LFS, which is not installed, so the action did not write it`,
				next: 'brew install git-lfs',
			};
		case 'lfs-not-set-up':
			return {
				path,
				reason,
				message: `${path} goes through Git LFS, whose filter is not set up in ${folder}, so the action did not write it`,
				next: `git -C ${folder} lfs install --local`,
			};
	}
}

/** Why Git cannot store `path` through LFS here, or `undefined` when it can (ADR-0856). */
async function lfsProblem(folder: string) {
	if (!Bun.which('git-lfs')) return 'lfs-not-installed' as const;
	const filterProcess = await git(folder, [
		'config',
		'--get',
		'filter.lfs.process',
	]);
	const clean = await git(folder, ['config', '--get', 'filter.lfs.clean']);
	if (filterProcess.code !== 0 && clean.code !== 0)
		return 'lfs-not-set-up' as const;
	return undefined;
}

/**
 * Whether Git ignores `path`, which may not exist yet: `check-ignore` answers
 * for a missing path, which `status` does not. Its arguments are path names,
 * not pathspecs, and it refuses the literal magic every other call gets.
 */
async function isIgnored(folder: string, path: string) {
	const checked = await git(folder, ['check-ignore', '-q', '--', path], {
		env: { GIT_LITERAL_PATHSPECS: '0' },
	});
	if (checked.code > 1)
		throw new Error(checked.stderr || 'git check-ignore failed');
	return checked.code === 0;
}

/**
 * One path the run wrote, recorded in full when it was first checked and
 * written: the blob HEAD held for it then (`null` when it had none), its mode
 * there, and the object the action's bytes became (`null` for a deletion).
 * At commit time those three answer everything about the path.
 */
export type Written = {
	base: string | null;
	mode: string;
	object: string | null;
};

/** What one run wrote. Ignored paths are written and never recorded. */
export type WriteLog = {
	/**
	 * Throws unless `path` may be written now, recording the refusal in
	 * `refused` first, so an action that catches or wraps the throw cannot
	 * hide it. Call immediately before the write lands.
	 */
	check(path: string): Promise<void>;
	/** Record the bytes now at `path`, which this run just wrote. */
	wrote(path: string, bytes: Uint8Array): Promise<void>;
	/** Record that this run just deleted `path`. */
	deleted(path: string): Promise<void>;
	/**
	 * Where to stage the bytes for `target` before they are renamed into
	 * place: under the repository's Git directory when that is on the same
	 * filesystem, so a run killed mid-write leaves nothing in the working
	 * tree for `git add -A` to sweep in; otherwise beside the target.
	 */
	tempFor(target: string): Promise<string>;
	/** Every path recorded, sorted. */
	written(): [path: string, Written][];
	/** Every write refused this run, in order. */
	readonly refused: readonly Refused[];
};

/** The object `git add` would store for the file at `path` now, or `null` when there is none. */
async function onDisk(folder: string, path: string) {
	try {
		await lstat(join(folder, path));
	} catch {
		return null;
	}
	return checkedGit(folder, ['hash-object', '--', path]);
}

async function isSymlink(folder: string, path: string) {
	try {
		return (await lstat(join(folder, path))).isSymbolicLink();
	} catch {
		return false;
	}
}

export function createWriteLog(folder: string): WriteLog {
	/** What the first check of each path found: its base and mode, or that Git ignores it. */
	const checked = new Map<string, Omit<Written, 'object'> | 'ignored'>();
	const written = new Map<string, Written>();
	const refused: Refused[] = [];
	const refuse = (path: string, reason: RefusalReason) => {
		const record = refusal(folder, path, reason);
		refused.push(record);
		throw new Error(record.message);
	};
	const record = (path: string, object: string | null) => {
		const found = checked.get(path);
		if (found && found !== 'ignored') written.set(path, { ...found, object });
	};
	// Decided once, at the run's first write: the Git directory, when a rename from it into the folder stays on one filesystem.
	let staging: Promise<string | undefined> | undefined;
	const stagingDir = () => {
		staging ??= gitPath(folder, 'epicenter-tmp').then(async (dir) => {
			await mkdir(dir, { recursive: true });
			return (await stat(dir)).dev === (await stat(folder)).dev
				? dir
				: undefined;
		});
		return staging;
	};
	return {
		refused,
		written: () =>
			[...written].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		async tempFor(target) {
			return join(
				(await stagingDir()) ?? dirname(target),
				`.${randomUUID()}.tmp`,
			);
		},
		async check(path) {
			if (checked.get(path) === 'ignored') return;
			// A write replaces the link with a file; one through it would change a file outside history.
			if (await isSymlink(folder, path)) refuse(path, 'symlink');
			const mine = written.get(path);
			if (mine) {
				if ((await onDisk(folder, path)) !== mine.object)
					refuse(path, 'changed-during');
				return;
			}
			if (await isIgnored(folder, path)) {
				checked.set(path, 'ignored');
				return;
			}
			const filter = await checkedGit(folder, [
				'check-attr',
				'filter',
				'--',
				path,
			]);
			if (filter.endsWith(': lfs')) {
				const problem = await lfsProblem(folder);
				if (problem) refuse(path, problem);
			}
			const status = await checkedGit(folder, [
				'status',
				'--porcelain=v1',
				'-z',
				'--untracked-files=all',
				'--',
				path,
			]);
			if (status.length) refuse(path, 'uncommitted');
			// Clean, so the index holds what HEAD holds: `<mode> <object> <stage>\t<path>`, or nothing.
			const staged = await checkedGit(folder, ['ls-files', '-s', '--', path]);
			const [mode, base] = staged ? staged.split(' ') : [];
			checked.set(path, { base: base ?? null, mode: mode ?? '100644' });
		},
		async wrote(path, bytes) {
			if (checked.get(path) === 'ignored') return;
			record(
				path,
				await checkedGit(
					folder,
					['hash-object', '-w', '--stdin', `--path=${path}`],
					{ stdin: bytes },
				),
			);
		},
		async deleted(path) {
			record(path, null);
		},
	};
}

/** Run git with `GIT_INDEX_FILE` set to `index`, feeding `stdin`. */
function withIndex(
	folder: string,
	index: string,
	args: string[],
	stdin?: string,
) {
	return checkedGit(folder, args, { stdin, env: { GIT_INDEX_FILE: index } });
}

/**
 * Take Git's own index lock, the file every Git command creates before it
 * changes the index, so no `git add` or `git commit` interleaves with moving
 * the branch and updating the index. Waits while another Git command holds it.
 */
async function lockIndex(indexPath: string) {
	const lock = `${indexPath}.lock`;
	for (let attempt = 0; ; attempt++) {
		try {
			await (await open(lock, 'wx')).close();
			return lock;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 400)
				throw error;
			await Bun.sleep(25);
		}
	}
}

/** The blob `commit` holds at each of `paths`; a path it lacks is absent. */
async function blobsAt(folder: string, commit: string | null, paths: string[]) {
	const blobs = new Map<string, string>();
	if (commit === null) return blobs;
	const listed = await checkedGit(folder, [
		'ls-tree',
		'-r',
		'-z',
		commit,
		'--',
		...paths,
	]);
	for (const entry of listed.split('\0').filter(Boolean)) {
		const [meta = '', path = ''] = entry.split('\t');
		blobs.set(path, meta.split(' ')[2] ?? '');
	}
	return blobs;
}

/**
 * What became of each written path, against `head`: HEAD already holding the
 * action's bytes is `already-in-history`; HEAD still holding what the path
 * held when the action first wrote it is the run's to commit; anything else
 * is a commit made during the run that changed it too, which wins.
 */
function sortAgainst(written: [string, Written][], blobs: Map<string, string>) {
	const mine: [string, Written][] = [];
	const states = new Map<string, PathState>();
	for (const [path, entry] of written) {
		const now = blobs.get(path) ?? null;
		if (now === entry.object) states.set(path, 'already-in-history');
		else if (now === entry.base) {
			mine.push([path, entry]);
			states.set(path, 'committed');
		} else states.set(path, 'contested');
	}
	return { mine, states };
}

/** `mode object\tpath` lines for `update-index --index-info`; a deletion is mode 0. */
function indexLines(entries: [string, Written][]) {
	return `${entries
		.map(([path, { mode, object }]) =>
			object === null ? `0 ${ZERO}\t${path}` : `${mode} ${object}\t${path}`,
		)
		.join('\n')}\n`;
}

/**
 * Commit exactly what `written` holds onto HEAD, named `subject` with
 * `body`, and say what became of each path (see `PathState`). Nothing is ever
 * merged. The commit is `null` when nothing of the run's remains to commit.
 */
export async function commitWrites(
	folder: string,
	{
		written,
		subject,
		body,
	}: { written: [string, Written][]; subject: string; body: string },
): Promise<{ commit: Commit | null; states: Map<string, PathState> }> {
	if (written.length === 0) return { commit: null, states: new Map() };
	const paths = written.map(([path]) => path);
	const indexPath = await gitPath(folder, 'index');
	const lock = await lockIndex(indexPath);
	// Once renamed over the index the lock is released, and the name may already be another Git command's lock.
	let held = true;
	const scratch = join(tmpdir(), `epicenter-index-${randomUUID()}`);
	try {
		for (let attempt = 0; attempt < 20; attempt++) {
			const head = await revParse(folder, 'HEAD');
			const { mine, states } = sortAgainst(
				written,
				await blobsAt(folder, head, paths),
			);
			if (mine.length === 0) {
				await markChangedAfter(folder, head, states);
				return { commit: null, states };
			}
			await rm(scratch, { force: true });
			await withIndex(
				folder,
				scratch,
				head ? ['read-tree', head] : ['read-tree', '--empty'],
			);
			const lines = indexLines(mine);
			await withIndex(folder, scratch, ['update-index', '--index-info'], lines);
			const tree = await withIndex(folder, scratch, ['write-tree']);
			const sha = await withIndex(
				folder,
				scratch,
				['commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'],
				`${subject}\n\n${body}\n`,
			);
			const moved = await git(folder, [
				'update-ref',
				'-m',
				`epicenter: ${subject}`,
				'HEAD',
				sha,
				head ?? ZERO,
			]);
			if (moved.code !== 0) continue;
			// The index, under the same lock, now says what HEAD says for these paths, so `git status` shows only later edits.
			// Written into the lock file, never copied onto it: Bun's `copyFile`
			// replaces a large destination, which frees the lock for an instant
			// in which an agent's `git add` can take it.
			try {
				await writeFile(lock, await readFile(indexPath));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				await withIndex(folder, lock, ['read-tree', sha]);
			}
			await withIndex(folder, lock, ['update-index', '--index-info'], lines);
			await rename(lock, indexPath);
			held = false;
			await markChangedAfter(folder, sha, states);
			return {
				commit: { sha, subject, paths: mine.map(([path]) => path) },
				states,
			};
		}
		throw new Error('HEAD kept moving while epicenter committed');
	} finally {
		await rm(scratch, { force: true });
		if (held) await rm(lock, { force: true });
	}
}

/** A path in history as the action left it, whose file on disk someone has changed since, is `changed-after`. */
async function markChangedAfter(
	folder: string,
	tip: string | null,
	states: Map<string, PathState>,
) {
	const settled = [...states]
		.filter(
			([, state]) => state === 'committed' || state === 'already-in-history',
		)
		.map(([path]) => path);
	if (tip === null || settled.length === 0) return;
	const changed = await checkedGit(folder, [
		'diff',
		'--name-only',
		'-z',
		'--no-renames',
		tip,
		'--',
		...settled,
	]);
	for (const path of changed.split('\0').filter(Boolean))
		states.set(path, 'changed-after');
}
