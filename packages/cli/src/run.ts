/** The one action run for the command line and MCP (ADR-0842). */
import { createHash } from 'node:crypto';
import {
	lstat,
	readFile,
	readlink,
	realpath,
	rm,
	rmdir,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { holdingFileLock, NothingChanged } from './file-lock.ts';
import { checkedGit, dirtyPaths, git } from './git.ts';
import type { Located } from './home.ts';
import { cacheOnDisk, folderOnDisk } from './places.ts';
import { keychain } from './secrets.ts';

type RunResult =
	| { ok: true; value: unknown; notes: string[] }
	| {
			ok: false;
			code: 'usage' | 'failed';
			error: string;
			next?: string;
			notes: string[];
	  };

function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

async function hash(folder: string, path: string): Promise<string | undefined> {
	const file = join(folder, path);
	const found = await lstat(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return undefined;
		throw error;
	});
	if (!found) return undefined;
	const bytes = found.isSymbolicLink()
		? Buffer.from(await readlink(file))
		: await readFile(file);
	return createHash('sha256').update(bytes).digest('hex');
}

async function undo(folder: string, paths: string[]) {
	const tracked: string[] = [];
	const untracked: string[] = [];
	for (const path of paths) {
		const inHead = await git(folder, 'cat-file', '-e', `HEAD:${path}`);
		(inHead.code === 0 ? tracked : untracked).push(path);
	}
	if (tracked.length)
		await checkedGit(
			folder,
			'restore',
			'--source=HEAD',
			'--staged',
			'--worktree',
			'--',
			...tracked,
		);
	for (const path of untracked) {
		await rm(join(folder, path), { recursive: true, force: true });
		let parent = dirname(join(folder, path));
		while (parent !== folder) {
			try {
				await rmdir(parent);
			} catch (error) {
				if (
					['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(
						(error as NodeJS.ErrnoException).code ?? '',
					)
				)
					break;
				throw error;
			}
			parent = dirname(parent);
		}
	}
}

/** Check the repository before an action starts, then hold its lock through commit or undo. */
export async function runAction(
	located: Located,
	key: string,
	input: Record<string, unknown>,
): Promise<RunResult> {
	const folder = located.realPath;
	const next = `git -C ${folder} init`;
	const top = await git(folder, 'rev-parse', '--show-toplevel');
	if (
		top.code !== 0 ||
		(await realpath(top.stdout.toString().trim())) !== folder
	)
		return {
			ok: false,
			code: 'usage',
			error: `${folder} must be the top level of a Git repository`,
			next,
			notes: [],
		};
	// An action's commit cannot be made in the middle of a merge, so it would
	// run and then leave its changes uncommitted; refuse before it starts.
	if (
		(await git(folder, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).code === 0
	)
		return {
			ok: false,
			code: 'usage',
			error: `${folder} is in the middle of a merge; resolve the conflicts and commit first`,
			notes: [],
		};
	const lock = join(
		dirname(located.cacheDir),
		`${basename(located.cacheDir)}.lock`,
	);
	try {
		return await holdingFileLock(
			lock,
			{ waitMs: 86_400_000, held: `${located.name} is busy` },
			async () => {
				let before: string[];
				const hashes = new Map<string, string | undefined>();
				try {
					before = await dirtyPaths(folder);
					for (const path of before) hashes.set(path, await hash(folder, path));
				} catch (error) {
					return {
						ok: false,
						code: 'usage',
						error: message(error),
						notes: [],
					} as const;
				}
				const dirty = new Set(before);
				const notes = async () => {
					const changed: string[] = [];
					for (const path of before)
						if (hashes.get(path) !== (await hash(folder, path)))
							changed.push(
								`left uncommitted: ${path} (it had changes before the action)`,
							);
					return changed;
				};
				let value: unknown;
				try {
					const action = located.app?.actions[key];
					if (!action) throw new Error(`Unknown action ${located.name} ${key}`);
					value = await action.run(input, {
						folder: folderOnDisk(folder, dirty),
						cache: cacheOnDisk(located.cacheDir),
						secrets: keychain(located.keychain),
					});
				} catch (error) {
					try {
						await undo(
							folder,
							(await dirtyPaths(folder)).filter((path) => !dirty.has(path)),
						);
					} catch (undoError) {
						return {
							ok: false,
							code: 'failed',
							error: `${message(error)}; undo failed: ${message(undoError)}`,
							notes: await notes(),
						};
					}
					return {
						ok: false,
						code: 'failed',
						error: message(error),
						notes: await notes(),
					};
				}
				const changed = (await dirtyPaths(folder)).filter(
					(path) => !dirty.has(path),
				);
				if (changed.length) {
					const subject = `${located.name} ${key}`;
					try {
						await checkedGit(folder, 'add', '-A', '--', ...changed);
						await checkedGit(
							folder,
							'commit',
							'--only',
							'--no-verify',
							'-m',
							subject,
							'-m',
							JSON.stringify(input),
							'--',
							...changed,
						);
						const sha = (
							await checkedGit(folder, 'rev-parse', '--short', 'HEAD')
						)
							.toString()
							.trim();
						return {
							ok: true,
							value,
							notes: [`committed ${sha} ${subject}`, ...(await notes())],
						};
					} catch (error) {
						return {
							ok: false,
							code: 'failed',
							error: message(error),
							notes: await notes(),
						};
					}
				}
				return { ok: true, value, notes: await notes() };
			},
		);
	} catch (error) {
		return {
			ok: false,
			code: error instanceof NothingChanged ? 'usage' : 'failed',
			error: message(error),
			notes: [],
		};
	}
}
