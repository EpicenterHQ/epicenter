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
	copyFile,
	lstat,
	mkdir,
	open,
	rename,
	rm,
	stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkedGit, git, gitPath, revParse } from './git.ts';
import type { Commit, Refused, RefusalReason } from './report.ts';

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

/** What one run wrote, as Git objects; `null` is a deletion. Ignored paths are written and never recorded. */
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
	/** The paths recorded, in the order first written. */
	readonly writes: ReadonlyMap<string, string | null>;
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

export function createWriteLog(folder: string): WriteLog {
	const writes = new Map<string, string | null>();
	const ignored = new Set<string>();
	const refused: Refused[] = [];
	const refuse = (path: string, reason: RefusalReason) => {
		const record = refusal(folder, path, reason);
		refused.push(record);
		throw new Error(record.message);
	};
	// Decided once per run: the Git directory, when a rename from it into the folder stays on one filesystem.
	const staging = gitPath(folder, 'epicenter-tmp').then(async (dir) => {
		await mkdir(dir, { recursive: true });
		return (await stat(dir)).dev === (await stat(folder)).dev ? dir : undefined;
	});
	return {
		writes,
		refused,
		async tempFor(target) {
			return join((await staging) ?? dirname(target), `.${randomUUID()}.tmp`);
		},
		async check(path) {
			if (ignored.has(path)) return;
			if (writes.has(path)) {
				if ((await onDisk(folder, path)) !== writes.get(path))
					refuse(path, 'changed-during');
				return;
			}
			if (await isIgnored(folder, path)) {
				ignored.add(path);
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
		},
		async wrote(path, bytes) {
			if (ignored.has(path)) return;
			writes.set(
				path,
				await checkedGit(
					folder,
					['hash-object', '-w', '--stdin', `--path=${path}`],
					{ stdin: bytes },
				),
			);
		},
		async deleted(path) {
			if (!ignored.has(path)) writes.set(path, null);
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

/** `mode object\tpath` lines for `update-index --index-info`, keeping each path's mode at `base`. */
async function indexLines(
	folder: string,
	base: string | null,
	writes: ReadonlyMap<string, string | null>,
) {
	const lines: string[] = [];
	for (const [path, object] of writes) {
		if (object === null) {
			lines.push(`0 ${ZERO}\t${path}`);
			continue;
		}
		const tree = base
			? await checkedGit(folder, ['ls-tree', base, '--', path])
			: '';
		const mode = /^(100755|120000) /.exec(tree)?.[1] ?? '100644';
		lines.push(`${mode} ${object}\t${path}`);
	}
	return `${lines.join('\n')}\n`;
}

/**
 * Commit exactly `writes` onto HEAD, named `subject` with `body`. A path that
 * a commit made during the run also changed is left out and returned in
 * `contested`; nothing is ever merged. Returns `null` for the commit when
 * nothing of the run's remains to commit.
 */
export async function commitWrites(
	folder: string,
	{
		startHead,
		writes,
		subject,
		body,
	}: {
		startHead: string | null;
		writes: ReadonlyMap<string, string | null>;
		subject: string;
		body: string;
	},
): Promise<{ commit: Commit | null; contested: string[] }> {
	if (writes.size === 0) return { commit: null, contested: [] };
	const indexPath = await gitPath(folder, 'index');
	const lock = await lockIndex(indexPath);
	// Once renamed over the index the lock is released, and the name may already be another Git command's lock.
	let held = true;
	const scratch = join(tmpdir(), `epicenter-index-${randomUUID()}`);
	try {
		let contested: string[] = [];
		for (let attempt = 0; attempt < 20; attempt++) {
			const head = await revParse(folder, 'HEAD');
			// A commit made during the run that touches one of these paths wins; the run's version stays on disk, uncommitted.
			if (head !== startHead && startHead !== null && head !== null)
				contested = (
					await checkedGit(folder, [
						'diff',
						'--name-only',
						'--no-renames',
						startHead,
						head,
						'--',
						...writes.keys(),
					])
				)
					.split('\n')
					.filter(Boolean);
			const mine = new Map(
				[...writes].filter(([path]) => !contested.includes(path)),
			);
			if (mine.size === 0) return { commit: null, contested };
			await rm(scratch, { force: true });
			await withIndex(
				folder,
				scratch,
				head ? ['read-tree', head] : ['read-tree', '--empty'],
			);
			const lines = await indexLines(folder, head, mine);
			await withIndex(folder, scratch, ['update-index', '--index-info'], lines);
			const tree = await withIndex(folder, scratch, ['write-tree']);
			if (head && tree === (await revParse(folder, `${head}^{tree}`)))
				return { commit: null, contested };
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
			try {
				await copyFile(indexPath, lock);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				await withIndex(folder, lock, ['read-tree', sha]);
			}
			await withIndex(folder, lock, ['update-index', '--index-info'], lines);
			await rename(lock, indexPath);
			held = false;
			return {
				commit: { sha, subject, paths: [...mine.keys()].sort() },
				contested,
			};
		}
		throw new Error('HEAD kept moving while epicenter committed');
	} finally {
		await rm(scratch, { force: true });
		if (held) await rm(lock, { force: true });
	}
}

/** Paths whose bytes on disk are no longer what the run wrote: someone changed them after. */
export async function changedSince(
	folder: string,
	writes: ReadonlyMap<string, string | null>,
) {
	const changed: string[] = [];
	for (const [path, object] of writes)
		if ((await onDisk(folder, path)) !== object) changed.push(path);
	return changed;
}
