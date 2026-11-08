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
 * The limit, stated: the check and the rename are two steps, so an editor
 * save landing between them can be overwritten. Writes an action makes
 * around `folder` (through `folder.path`) are not recorded and not committed.
 */
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Commit } from './errors.ts';
import { checkedGit, git } from './git.ts';

const ZERO = '0000000000000000000000000000000000000000';

/** A write was refused; nothing was written to `path`. */
export class PathRefused extends Error {
	constructor(
		readonly path: string,
		/** True when the action wrote the path earlier in this run and someone changed it since. */
		readonly during: boolean,
	) {
		super(
			during
				? `${path} changed during the run, so the action did not overwrite it`
				: `${path} has changes you have not committed, so the action did not write it`,
		);
		this.name = 'PathRefused';
	}
}

/** What one run wrote, as Git objects; `null` is a deletion. Ignored paths are written and never recorded. */
export type WriteLog = {
	/** Throws `PathRefused` unless `path` may be written now. Call immediately before the write lands. */
	check(path: string): Promise<void>;
	/** Record the bytes now at `path`, which this run just wrote. */
	wrote(path: string, bytes: Uint8Array): Promise<void>;
	/** Record that this run just deleted `path`. */
	deleted(path: string): Promise<void>;
	/** The paths recorded, in the order first written. */
	readonly writes: ReadonlyMap<string, string | null>;
};

/** The object `git add` would store for the file at `path` now, or `null` when there is none. */
async function onDisk(folder: string, path: string) {
	try {
		await lstat(join(folder, path));
	} catch {
		return null;
	}
	return (await checkedGit(folder, 'hash-object', '--', path))
		.toString()
		.trim();
}

export function createWriteLog(folder: string): WriteLog {
	const writes = new Map<string, string | null>();
	const ignored = new Set<string>();
	return {
		writes,
		async check(path) {
			if (ignored.has(path)) return;
			if (writes.has(path)) {
				if ((await onDisk(folder, path)) !== writes.get(path))
					throw new PathRefused(path, true);
				return;
			}
			// check-ignore answers for a path that does not exist yet, which status does not.
			if ((await git(folder, 'check-ignore', '-q', '--', path)).code === 0) {
				ignored.add(path);
				return;
			}
			const status = await checkedGit(
				folder,
				'status',
				'--porcelain=v1',
				'-z',
				'--untracked-files=all',
				'--',
				path,
			);
			if (status.length) throw new PathRefused(path, false);
		},
		async wrote(path, bytes) {
			if (ignored.has(path)) return;
			const child = Bun.spawn(
				['git', '-C', folder, 'hash-object', '-w', '--stdin', `--path=${path}`],
				{ stdin: bytes, stdout: 'pipe', stderr: 'pipe' },
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (code !== 0)
				throw new Error(stderr.trim() || 'git hash-object failed');
			writes.set(path, stdout.trim());
		},
		async deleted(path) {
			if (!ignored.has(path)) writes.set(path, null);
		},
	};
}

async function revParse(folder: string, rev: string) {
	const found = await git(folder, 'rev-parse', '-q', '--verify', rev);
	return found.code === 0 ? found.stdout.toString().trim() : null;
}

/** Where Git keeps `name` for this repository, as an absolute path. */
export async function gitPath(folder: string, name: string) {
	const path = (await checkedGit(folder, 'rev-parse', '--git-path', name))
		.toString()
		.trim();
	return isAbsolute(path) ? path : join(folder, path);
}

/** Run git with `GIT_INDEX_FILE` set, feeding `stdin`. */
async function withIndex(
	folder: string,
	index: string,
	args: string[],
	stdin?: string,
) {
	const child = Bun.spawn(['git', '-C', folder, ...args], {
		env: { ...process.env, GIT_INDEX_FILE: index },
		stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(stderr.trim() || `git ${args[0]} failed`);
	return stdout.trim();
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
			? (await checkedGit(folder, 'ls-tree', base, '--', path)).toString()
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
	const scratch = await gitPath(folder, `epicenter-index-${randomUUID()}`);
	try {
		let contested: string[] = [];
		for (let attempt = 0; attempt < 20; attempt++) {
			const head = await revParse(folder, 'HEAD');
			// A commit made during the run that touches one of these paths wins; the run's version stays on disk, uncommitted.
			if (head !== startHead && startHead !== null && head !== null)
				contested = (
					await checkedGit(
						folder,
						'diff',
						'--name-only',
						'--no-renames',
						startHead,
						head,
						'--',
						...writes.keys(),
					)
				)
					.toString()
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
			const moved = await git(
				folder,
				'update-ref',
				'-m',
				`epicenter: ${subject}`,
				'HEAD',
				sha,
				head ?? ZERO,
			);
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
