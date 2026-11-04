/**
 * One round of `epicenter sync` for one data folder, over the
 * system `git` (decisions 21, 31, 33, 41, 44, 52):
 *
 *   guards -> fetch and check unrelated history -> stage and commit local files
 *   -> fetch LFS bytes -> merge related history, or place first-sync files
 *      in one commit on remote main -> git lfs push -> push
 *   (a rejected push fetches, merges, and pushes again)
 *
 * Epicenter sync is the only desktop committer (decision 31), and it commits
 * only its own repository. Rounds are
 * serialized per repository by a lock file in its Git directory, so the
 * desktop app's `--watch` and a person's `epicenter sync` take turns.
 *
 * The merge takes no lock on the folder: an app save that read a file
 * before the merge finds it changed and is refused, and one that lands in
 * the instant between Git's check and its rewrite is kept in history, since
 * the round committed it first (ADR-0562, ADR-0568). The LFS bytes the
 * merge checks out are fetched before it starts.
 *
 * It never calls `git pull`: the rewrite check (decision 33) needs the
 * fetched remote before any merge. `refs/epicenter/last-seen` names the
 * remote `main` this clone last merged or pushed; a remote `main` that no
 * longer contains it was rewritten, and sync stops rather than push the
 * replaced history back.
 *
 * A round ends `synced`, `retry` (transient: a lock another program holds,
 * the network, a push still rejected after every attempt; run it again), or
 * `stopped` (a person or agent must act: a merge in progress, a rewrite,
 * conflicts Epicenter does not settle, a clone not set up).
 */

import { existsSync, statSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { isNotePath } from '@epicenter/definition/contract';
import {
	conflictSibling,
	lfsOid,
	parsePointer,
	settle,
} from '@epicenter/definition/merge';
import { type GitCredential, STATE_DIRECTORY } from '@epicenter/folder/bun';
import { holdingFileLock, NothingChanged } from '../file-lock.ts';
import {
	type CredentialFor,
	config,
	type GitOptions,
	git,
	must,
	originPushUrl,
	withSyncDriver,
} from './git.ts';
import { repositoryProblem } from './repository-state.ts';
import { identity, repositoryRoot } from './setup.ts';

const LAST_SEEN = 'refs/epicenter/last-seen';
const REMOTE_MAIN = 'refs/remotes/origin/main';
/**
 * A ref status line of `git push`'s report: ` ! [rejected] HEAD -> main
 * (fetch first)` or ` ! [remote rejected] HEAD -> main (<reason>)`. Ref
 * names hold no spaces, and the reason runs to the line's last `)`.
 */
const REF_STATUS =
	/^ ! \[(rejected|remote rejected)\] +\S+ -> \S+ \((.*)\)[ \t]*$/gm;
/**
 * Git's own report that the server refused this account a fetch or a push
 * (HTTP 403): a read-only grant pushing, or a revoked one. Running again
 * cannot help until the owner changes the grant.
 */
const FORBIDDEN =
	/^fatal: unable to access '[^'\n]*': The requested URL returned error: 403$/m;
/** A remote's reason that means it moved first: the receiver's own, or stock Git's on a lost ref race. */
const MOVED_REASON =
	/^(?:stale\b|non-fast-forward\b|fetch first\b|cannot lock ref\b|failed to update ref\b|failed to lock\b)/;

/**
 * What a failed `git push` means for the round, read only from the ref
 * status lines and their reasons, never from other text (which can hold
 * paths, such as a refused file named `stale-notes.md`).
 *
 * - `moved`: the remote moved first (Git's own `[rejected]`, or a remote
 *   reason that starts `stale`, `non-fast-forward`, or a lost race on the
 *   ref update); fetch, merge, and push again.
 * - `refused`: any other `[remote rejected]` reason: the remote's policy
 *   turned the push down (a raw file where an LFS pointer belongs, a ref
 *   other than `main`), or Git's own report that the server refused this
 *   account the push (HTTP 403: a read-only or revoked grant). Pushing again
 *   cannot help, so the round stops for a person or an agent.
 * - `failed`: no ref status at all, such as the network; run the round
 *   again later.
 */
export function classifyPush(stderr: string): 'moved' | 'refused' | 'failed' {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: color.push=always colors the report
	const plain = stderr.replace(/\x1b\[[0-9;]*m/g, '');
	const statuses = [...plain.matchAll(REF_STATUS)].map(([, kind, reason]) =>
		kind === 'rejected' || MOVED_REASON.test(reason ?? '')
			? ('moved' as const)
			: ('refused' as const),
	);
	if (statuses.includes('refused') || FORBIDDEN.test(plain)) return 'refused';
	if (statuses.includes('moved')) return 'moved';
	return 'failed';
}

/** Fetch, merge, and push attempts in one round before a rejected push is a `retry`. */
const ATTEMPTS = 5;
/** How long a round waits for another round in the same repository. */
const TURN_WAIT_MS = 120_000;

export type SyncStatus = 'synced' | 'retry' | 'stopped';

export type SyncResult = {
	readonly folder: string;
	readonly status: SyncStatus;
	/** The commit the folder's repository is at when the round ends. */
	readonly head?: string;
	/** What the round did, one line each, in order. */
	readonly notes: string[];
	/** Why the round ended `retry` or `stopped`. */
	readonly message?: string;
};

export type SyncOptions = {
	/** The token for the remote, asked for by its URL. */
	readonly credential?: CredentialFor;
};

class Stop extends Error {
	constructor(
		message: string,
		readonly status: 'retry' | 'stopped',
	) {
		super(message);
	}
}

/** Run one sync round for the folder at `input`. Never throws for a stop. */
export async function syncFolder(
	input: string,
	options: SyncOptions = {},
): Promise<SyncResult> {
	return withSyncDriver(async () => {
		const notes: string[] = [];
		const folder = resolve(input);
		let target = folder;
		try {
			if (!existsSync(folder) || !statSync(folder).isDirectory())
				throw new Stop(
					`${folder} does not exist. Run epicenter forget ${folder} if it is gone for good.`,
					'stopped',
				);
			target = await realpath(folder);
			const root = await repositoryRoot(target);
			if (root === null)
				throw new Stop(
					`${folder} is not in a Git repository. Run epicenter init ${folder}.`,
					'stopped',
				);
			// A boolean in an enclosing repository's config cannot authorize its subfolder.
			if (
				root !== target ||
				(await config(target, 'epicenter.synced')) !== 'true'
			)
				throw new Stop(
					`${folder} is not its own synced repository. Run epicenter init ${folder} again.`,
					'stopped',
				);
			const common = resolve(
				target,
				(await must(target, ['rev-parse', '--git-common-dir'])).trim(),
			);
			const head = await holdingFileLock(
				join(common, 'epicenter-sync.lock'),
				{
					waitMs: TURN_WAIT_MS,
					held: `another epicenter sync of ${root} ran for more than ${TURN_WAIT_MS / 1000} seconds; nothing was changed.`,
				},
				() => round(target, root, options, notes),
			).catch((cause: unknown) => {
				if (cause instanceof Stop) throw cause;
				// The lock could not be taken: another round is still running.
				if (cause instanceof NothingChanged)
					throw new Stop(cause.message, 'retry');
				throw cause;
			});
			return { folder, status: 'synced', head, notes };
		} catch (cause) {
			if (!(cause instanceof Stop)) throw cause;
			const head = await git(target, [
				'rev-parse',
				'-q',
				'--verify',
				'HEAD',
			]).catch(() => undefined);
			return {
				folder,
				status: cause.status,
				...(head?.code === 0 ? { head: head.stdout.trim() } : {}),
				notes,
				message: cause.message,
			};
		}
	});
}

const has = async (cwd: string, ref: string) =>
	(await git(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])).code ===
	0;
const sha = async (cwd: string, ref: string) =>
	(await must(cwd, ['rev-parse', ref])).trim();

/** The index lock's path, and how long ago it was taken when another program holds it. */
async function indexLock(cwd: string): Promise<string | null> {
	const path = resolve(
		cwd,
		(await must(cwd, ['rev-parse', '--git-path', 'index.lock'])).trim(),
	);
	if (!existsSync(path)) return null;
	const age = Math.round((Date.now() - statSync(path).mtimeMs) / 1000);
	return `another program holds ${path} (taken ${age}s ago); nothing was changed. Run sync again; if it is still there and no git is running, delete it.`;
}

type Stage = { mode: string; sha: string };

/** Unmerged index entries by path (relative to `root`): stage 1 base, 2 ours, 3 theirs. */
async function unmerged(root: string) {
	const byPath = new Map<string, Map<number, Stage>>();
	for (const entry of (await must(root, ['ls-files', '-u', '-z']))
		.split('\0')
		.filter(Boolean)) {
		const tab = entry.indexOf('\t');
		const [mode = '', blob = '', stage = ''] = entry.slice(0, tab).split(' ');
		const path = entry.slice(tab + 1);
		const stages = byPath.get(path) ?? new Map<number, Stage>();
		stages.set(Number(stage), { mode, sha: blob });
		byPath.set(path, stages);
	}
	return byPath;
}

/** A git step that must succeed: a lock makes it a `retry`, anything else a `stop`. */
async function step(
	cwd: string,
	args: readonly string[],
	what: string,
	options: GitOptions = {},
) {
	const ran = await git(cwd, args, options);
	if (ran.code === 0) return ran.stdout;
	const locked = await indexLock(cwd);
	throw new Stop(
		locked ?? `${what} failed: ${ran.stderr.trim()}`,
		locked === null ? 'stopped' : 'retry',
	);
}

/** Paths are literal: a file named `*.md` names only itself. */
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

/**
 * What a round commits, and what `epicenter status` reports changed: the
 * data folder's own paths (the working directory `git` runs in), never its
 * unfinished writes in `STATE_DIRECTORY`, whatever the folder's
 * `.gitignore` says. The exclusion matches that directory at any depth, as
 * init's `.gitignore` line does. It starts with a wildcard on purpose:
 * `git add` fails on an exclusion that names an ignored path literally
 * (`:(exclude).epicenter` while `.gitignore` lists it). It is pathspec magic, so these are never given with `LITERAL`,
 * and `GIT_LITERAL_PATHSPECS` from the environment is turned off for them.
 */
export const COMMITTED = ['--', '.', `:(exclude,glob)**/${STATE_DIRECTORY}/**`];
export const MAGIC = { env: { GIT_LITERAL_PATHSPECS: '0' } };

/** The round itself, holding the repository's sync lock. Returns the head it ends at. */
async function round(
	folder: string,
	root: string,
	{ credential }: SyncOptions,
	notes: string[],
): Promise<string> {
	const problem = await repositoryProblem(root);
	if (problem !== null) throw new Stop(problem, 'stopped');
	// LFS filters must be installed before git add can store pointers.
	if ((await config(folder, 'filter.lfs.process')) === null)
		throw new Stop(
			`this clone is not set up (LFS filters missing). Run epicenter init ${folder}, then sync.`,
			'stopped',
		);
	// Commit what the apps wrote in this folder, through the filters, and
	// nothing else: never an unfinished write.
	const who = await identity(root);
	const url = await config(root, 'remote.origin.url');
	const auth = url === null ? undefined : await credential?.(url);
	if (url !== null) {
		if ((await originPushUrl(root)) !== url)
			throw new Stop(
				'origin pushes to a different URL than it fetches. Inspect git remote -v before syncing.',
				'stopped',
			);
		const fetched = await git(root, ['fetch', '-q', 'origin'], {
			credential: auth,
		});
		if (fetched.code !== 0)
			throw new Stop(
				`git fetch failed: ${fetched.stderr.trim()}`,
				FORBIDDEN.test(fetched.stderr) ? 'stopped' : 'retry',
			);
		if (
			(await has(root, 'HEAD')) &&
			(await has(root, REMOTE_MAIN)) &&
			(await git(root, ['merge-base', 'HEAD', REMOTE_MAIN])).code !== 0
		) {
			const subjects = (await must(root, ['log', '--format=%s', 'HEAD']))
				.trim()
				.split('\n');
			const foreign = subjects.find(
				(subject) =>
					subject !== 'epicenter: attributes and ignore rules' &&
					!/^epicenter sync \d{4}-/.test(subject),
			);
			if (foreign !== undefined)
				throw new Stop(
					`${folder} has unrelated Git history that Epicenter did not make (including "${foreign}"). Run git rebase --root --onto origin/main in that folder, resolve any conflicts, then sync again.`,
					'stopped',
				);
		}
	}
	await step(folder, ['add', '-A', ...COMMITTED], 'git add', MAGIC);
	if (
		(await git(folder, ['diff', '--cached', '--quiet', ...COMMITTED], MAGIC))
			.code !== 0
	) {
		await step(
			folder,
			[
				'commit',
				'-q',
				'-m',
				`epicenter sync ${new Date().toISOString()}`,
				...COMMITTED,
			],
			'git commit',
			{ env: { ...who, ...MAGIC.env } },
		);
		notes.push('committed local changes');
	}

	if (url === null) {
		notes.push('no remote: committed locally');
		return sha(root, 'HEAD');
	}
	for (let attempt = 1; ; attempt++) {
		if (attempt > 1) {
			const fetched = await git(root, ['fetch', '-q', 'origin'], {
				credential: auth,
			});
			if (fetched.code !== 0)
				throw new Stop(
					`git fetch failed: ${fetched.stderr.trim()}`,
					FORBIDDEN.test(fetched.stderr) ? 'stopped' : 'retry',
				);
		}
		if (await has(root, REMOTE_MAIN)) await mergeRemote(root, auth, who, notes);
		if (
			(await has(root, REMOTE_MAIN)) &&
			(await sha(root, 'HEAD')) === (await sha(root, REMOTE_MAIN))
		)
			return sha(root, 'HEAD');
		const uploaded = await git(root, ['lfs', 'push', 'origin', 'HEAD'], {
			credential: auth,
		});
		if (uploaded.code !== 0)
			throw new Stop(`git lfs push failed: ${uploaded.stderr.trim()}`, 'retry');
		const pushed = await git(
			root,
			['push', '-q', 'origin', 'HEAD:refs/heads/main'],
			{ credential: auth },
		);
		if (pushed.code === 0) {
			const at = await sha(root, 'HEAD');
			await must(root, ['update-ref', REMOTE_MAIN, at]);
			await must(root, ['update-ref', LAST_SEEN, at]);
			notes.push(`pushed ${at.slice(0, 7)}`);
			return at;
		}
		const outcome = classifyPush(pushed.stderr);
		if (outcome === 'refused')
			throw new Stop(
				`the remote refused the push: ${pushed.stderr.trim()}`,
				'stopped',
			);
		if (outcome === 'failed')
			throw new Stop(`git push failed: ${pushed.stderr.trim()}`, 'retry');
		if (attempt >= ATTEMPTS)
			throw new Stop(
				`the remote moved during each of ${ATTEMPTS} pushes; nothing was lost. Run sync again.`,
				'retry',
			);
		notes.push('push rejected: the remote moved; fetching again');
	}
}

/** Check, then merge the fetched remote main, settling what Git leaves unmerged. */
async function mergeRemote(
	root: string,
	auth: GitCredential | undefined,
	who: Record<string, string>,
	notes: string[],
) {
	const firstContact = !(await has(root, LAST_SEEN));
	// The rewrite check (decision 33): the remote main must still contain the last one this clone saw.
	if (
		!firstContact &&
		(await git(root, ['merge-base', '--is-ancestor', LAST_SEEN, REMOTE_MAIN]))
			.code !== 0
	)
		throw new Stop(
			`the remote main was rewritten: it no longer contains ${(await sha(root, LAST_SEEN)).slice(0, 7)}, the main this clone last saw ` +
				`(remote main is now ${(await sha(root, REMOTE_MAIN)).slice(0, 7)}). Not merging, so the replaced history is not pushed back. ` +
				`Move your unsynced work onto origin/main (for example: git rebase --onto origin/main ${LAST_SEEN}), then: git update-ref ${LAST_SEEN} origin/main`,
			'stopped',
		);
	const behind =
		(await git(root, ['merge-base', '--is-ancestor', REMOTE_MAIN, 'HEAD']))
			.code !== 0;
	if (behind) {
		// The bytes the merge checks out, fetched before it starts.
		const fetched = await git(root, ['lfs', 'fetch', 'origin', REMOTE_MAIN], {
			credential: auth,
		});
		if (fetched.code !== 0)
			throw new Stop(
				`git lfs fetch failed: ${fetched.stderr.trim()}`,
				FORBIDDEN.test(fetched.stderr) ? 'stopped' : 'retry',
			);
		if ((await git(root, ['merge-base', 'HEAD', REMOTE_MAIN])).code === 0)
			await merge(root, auth, who, notes);
		else if (firstContact) await layerFirstSync(root, who, notes);
		else
			throw new Stop(
				'local and remote history no longer share an ancestor. Inspect git log --all --graph before syncing.',
				'stopped',
			);
	}
	await must(root, ['update-ref', LAST_SEEN, REMOTE_MAIN]);
	notes.push(
		`merged origin/main ${(await sha(root, REMOTE_MAIN)).slice(0, 7)}`,
	);
}

/** Put the local tree on the remote's parent without retaining a second root. */
async function layerFirstSync(
	root: string,
	who: Record<string, string>,
	notes: string[],
) {
	const entries = async (ref: string) => {
		const tree = new Map<string, Stage>();
		for (const entry of (await must(root, ['ls-tree', '-r', '-z', ref]))
			.split('\0')
			.filter(Boolean)) {
			const tab = entry.indexOf('\t');
			const [mode = '', kind = '', sha = ''] = entry.slice(0, tab).split(' ');
			if (kind !== 'blob')
				throw new Stop(
					`${ref} contains a Git submodule; sync only supports files.`,
					'stopped',
				);
			tree.set(entry.slice(tab + 1), { mode, sha });
		}
		return tree;
	};
	const local = await entries('HEAD');
	const remote = await entries(REMOTE_MAIN);
	for (const path of remote.keys()) {
		if (path.split('/').includes(STATE_DIRECTORY))
			throw new Stop(
				`origin/main contains ${path} inside Epicenter's local state directory.`,
				'stopped',
			);
	}
	for (const path of local.keys()) {
		if (
			[...remote.keys()].some(
				(other) => other.startsWith(`${path}/`) || path.startsWith(`${other}/`),
			)
		)
			throw new Stop(
				`${path} is a file on this computer and a directory on the remote, or the reverse. Resolve the paths before syncing.`,
				'stopped',
			);
	}
	const common = resolve(
		root,
		(await must(root, ['rev-parse', '--git-common-dir'])).trim(),
	);
	const temporary = await mkdtemp(join(common, 'epicenter-first-sync-'));
	const index = { GIT_INDEX_FILE: join(temporary, 'index') };
	try {
		await step(root, ['read-tree', REMOTE_MAIN], 'read remote tree', {
			env: index,
		});
		const localName = (await config(root, 'user.name')) || 'local';
		const remoteParty = (
			await must(root, ['log', '-1', '--format=%an%x00%aI', REMOTE_MAIN])
		)
			.trim()
			.split('\0');
		const parties = {
			current: {
				author: remoteParty[0] || 'remote',
				time: remoteParty[1] || '-',
			},
			incoming: { author: localName, time: new Date().toISOString() },
		};
		for (const [path, ours] of local) {
			const theirs = remote.get(path);
			if (theirs?.sha === ours.sha) continue;
			let destination = path;
			let stage = ours;
			if (theirs !== undefined) {
				if (
					['.gitignore', '.gitattributes', '.lfsconfig'].includes(
						path.split('/').at(-1) ?? '',
					)
				)
					throw new Stop(
						`${path} differs on this computer and the remote. Resolve this Git control file before syncing.`,
						'stopped',
					);
				if (isNotePath(path)) {
					const [current, incoming] = await Promise.all([
						must(root, ['cat-file', 'blob', theirs.sha]),
						must(root, ['cat-file', 'blob', ours.sha]),
					]);
					const merged = settle(null, current, incoming, { parties });
					const text = merged.text ?? current;
					stage = {
						mode: ours.mode,
						sha: (
							await step(
								root,
								['hash-object', '-w', '--stdin'],
								`write ${path}`,
								{ input: text },
							)
						).trim(),
					};
					notes.push(
						`${path}: merged two additions${merged.blocks ? ' with a conflict block' : ''}`,
					);
				} else {
					const blob = await git(root, ['cat-file', 'blob', ours.sha]);
					const oid =
						parsePointer(blob.stdout)?.oid ?? (await lfsOid(blob.bytes));
					destination = conflictSibling(path, oid);
					if (local.has(destination) || remote.has(destination))
						throw new Stop(
							`${destination} already exists; rename one of the files before syncing.`,
							'stopped',
						);
					notes.push(`conflict copy: ${destination}`);
				}
			}
			await step(
				root,
				[
					'update-index',
					'--add',
					'--cacheinfo',
					`${stage.mode},${stage.sha},${destination}`,
				],
				`stage ${destination}`,
				{ env: index },
			);
		}
		const tree = (
			await step(root, ['write-tree'], 'write combined tree', { env: index })
		).trim();
		const remoteHead = await sha(root, REMOTE_MAIN);
		const machine = hostname().replace(/\.local$/i, '') || 'this computer';
		const commit = (
			await step(
				root,
				['commit-tree', tree, '-p', remoteHead, '-m', `Added from ${machine}`],
				'commit first sync',
				{ env: who },
			)
		).trim();
		const moved = await git(root, ['reset', '--keep', commit]);
		if (moved.code !== 0)
			throw new Stop(
				`Could not put remote files beside local edits: ${moved.stderr.trim()}. Run sync again after saving the folder.`,
				'retry',
			);
		notes.push(
			`added this computer's files on origin/main ${remoteHead.slice(0, 7)}`,
		);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

/** Merge the fetched remote main and commit it. */
async function merge(
	root: string,
	auth: GitCredential | undefined,
	who: Record<string, string>,
	notes: string[],
) {
	const merged = await git(root, ['merge', '--no-edit', '-q', REMOTE_MAIN], {
		credential: auth,
		env: who,
	});
	for (const line of merged.stderr.split('\n'))
		if (line.startsWith('[epicenter merge] '))
			notes.push(line.slice('[epicenter merge] '.length));
	if (merged.code !== 0) {
		if (!(await has(root, 'MERGE_HEAD'))) {
			const locked = await indexLock(root);
			if (locked !== null) throw new Stop(locked, 'retry');
			// An app saved a file the merge would overwrite after this round committed: the next round commits it.
			if (/would be overwritten/.test(merged.stderr))
				throw new Stop(
					`git merge refused: a file changed during sync. Run sync again.\n  ${merged.stderr.trim()}`,
					'retry',
				);
			throw new Stop(
				`git merge refused before starting:\n  ${merged.stderr.trim()}`,
				'stopped',
			);
		}
		await settleUnmerged(root, auth, notes);
		await step(root, ['commit', '-q', '--no-edit'], 'git commit (merge)', {
			env: who,
		});
	}
}

/**
 * What the merge driver cannot settle, by the server's rules: an edit beats
 * a delete, keeping the side that edited; a file both sides replaced or
 * created that is not a note keeps the remote's (the earlier arrival) at its
 * path and lands the local one beside it as `<stem> (conflict <hash7>)<ext>`
 * (decision 44). Git control files and anything else these rules cannot
 * settle stop with Git's conflict state in place.
 */
async function settleUnmerged(
	root: string,
	auth: GitCredential | undefined,
	notes: string[],
) {
	const left: string[] = [];
	const literal = { env: LITERAL, credential: auth };
	for (const [path, stages] of await unmerged(root)) {
		if (
			['.gitignore', '.gitattributes', '.lfsconfig'].includes(
				path.split('/').at(-1) ?? '',
			)
		) {
			left.push(path);
			continue;
		}
		const base = stages.has(1);
		const ours = stages.get(2);
		const theirs = stages.get(3);
		if (base && ours !== undefined && theirs === undefined) {
			await step(
				root,
				['checkout', '--ours', '--', path],
				`keep the local edit of ${path}`,
				literal,
			);
			await step(root, ['add', '--', path], `stage ${path}`, literal);
			notes.push(`edit beats delete: kept ${path} (local edit)`);
		} else if (base && theirs !== undefined && ours === undefined) {
			await step(
				root,
				['checkout', '--theirs', '--', path],
				`keep the remote edit of ${path}`,
				literal,
			);
			await step(root, ['add', '--', path], `stage ${path}`, literal);
			notes.push(`edit beats delete: kept ${path} (remote edit)`);
		} else if (
			ours !== undefined &&
			theirs !== undefined &&
			!isNotePath(path)
		) {
			const blob = await git(root, ['cat-file', 'blob', ours.sha]);
			const oid = parsePointer(blob.stdout)?.oid ?? (await lfsOid(blob.bytes));
			const sibling = conflictSibling(path, oid);
			await step(
				root,
				[
					'update-index',
					'--add',
					'--cacheinfo',
					`${ours.mode},${ours.sha},${sibling}`,
				],
				`stage ${sibling}`,
				literal,
			);
			await step(
				root,
				['checkout', '--theirs', '--', path],
				`keep the remote ${path}`,
				literal,
			);
			await step(root, ['add', '--', path], `stage ${path}`, literal);
			await step(
				root,
				['checkout', '--', sibling],
				`write ${sibling}`,
				literal,
			);
			notes.push(`conflict copy: ${sibling}`);
		} else left.push(path);
	}
	if (left.length > 0)
		throw new Stop(
			`the merge left conflicts Epicenter does not settle: ${left.join(', ')}. Git's conflict state is in place; resolve and commit, then sync.`,
			'stopped',
		);
}
