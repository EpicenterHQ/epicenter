/**
 * `epicenter merge-driver %O %A %B %P`: Git's merge driver for `*.md`
 * (decision 42), running `settle` from `@epicenter/definition/merge`, the
 * same note merge the server runs.
 *
 * Which side arrives later (decision 28: the last arrival at the server
 * wins a front matter key). The server's `current` is what `main` already
 * holds, and `incoming` is the write landing after it.
 *
 * - `git merge origin/main` (what `epicenter sync` runs, and `git pull`):
 *   %A is ours, the local commit not yet on the server, and %B is theirs,
 *   already there. The merge commit carries ours to the server after
 *   theirs, so ours is the later arrival: current = %B, incoming = %A.
 * - `git pull --rebase` (a person's own Git): the sides swap. %A is the
 *   upstream being replayed onto and %B the local commit being replayed,
 *   so current = %A, incoming = %B. A rebase state directory tells.
 * - `cherry-pick`, `stash pop`, or merging another branch have no arrival
 *   order; the merge rule applies.
 *
 * Writes the merged note to %A and exits 0, conflict block or not: the
 * conflict lives in the file (decision 24), and the note always parses
 * because the front matter never gets a block. A failure exits 1, which
 * leaves Git's ordinary conflict state, and `epicenter sync` stops on it.
 * It says what it did on one stderr line, `[epicenter merge] ...`.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { settle } from '@epicenter/definition/merge';
import { git } from './git.ts';

/** Whether Git is replaying commits (`rebase-merge` or `rebase-apply` exists). */
async function rebasing(cwd: string): Promise<boolean> {
	for (const name of ['rebase-merge', 'rebase-apply']) {
		const path = (
			await git(cwd, ['rev-parse', '--git-path', name])
		).stdout.trim();
		if (path !== '' && existsSync(resolve(cwd, path))) return true;
	}
	return false;
}

/** Author and time of a commit, for a conflict label. */
async function partyOf(cwd: string, rev: string, fallback: string) {
	const shown = await git(cwd, ['log', '-1', '--format=%an%x00%aI', rev]);
	const [author, time] = shown.stdout.trim().split('\0');
	return shown.code === 0 && author && time
		? { author, time }
		: { author: fallback, time: '-' };
}

/** Run the driver. Returns its exit code: 0 merged, 1 failed. */
export async function mergeDriver(
	basePath: string,
	oursPath: string,
	theirsPath: string,
	name: string | undefined,
): Promise<number> {
	const cwd = process.cwd();
	const label = name ?? oursPath;
	try {
		const [baseText, ours, theirs] = await Promise.all(
			[basePath, oursPath, theirsPath].map((path) => readFile(path, 'utf8')),
		);
		// Git passes an empty base for add/add: two creates, not an edit of an empty note.
		const base = baseText === '' ? null : (baseText as string);
		const rebase = await rebasing(cwd);
		// The commit being merged in: Git names it in a GITHEAD_<sha> variable.
		const mergedIn = Object.keys(process.env)
			.find((key) => key.startsWith('GITHEAD_'))
			?.slice('GITHEAD_'.length);
		const localName = (await git(cwd, ['config', 'user.name'])).stdout.trim();
		const local = {
			author: localName || 'local',
			time: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
		};
		const remote = await partyOf(
			cwd,
			rebase ? 'HEAD' : (mergedIn ?? 'MERGE_HEAD'),
			'remote',
		);
		const [current, incoming] = rebase
			? [ours as string, theirs as string]
			: [theirs as string, ours as string];
		const settled = settle(base, current, incoming, {
			parties: { current: remote, incoming: local },
		});
		await writeFile(oursPath, settled.text ?? current);
		process.stderr.write(
			`[epicenter merge] ${label}: ${rebase ? 'rebase' : 'merge'}; incoming=${rebase ? '%B' : '%A'}; ${settled.blocks ? 'conflict block written' : 'clean'}\n`,
		);
		return 0;
	} catch (error) {
		process.stderr.write(
			`[epicenter merge] ${label}: failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}
