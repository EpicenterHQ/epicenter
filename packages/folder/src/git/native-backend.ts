/**
 * Native Git storage: a real repository in `<root>/.git`.
 *
 * isomorphic-git writes immutable objects for checkpoints (atomically, via a
 * scratch file and rename). Everything that mutates shared state uses the
 * real `git` CLI, whose `index.lock` and ref locks other Git processes
 * respect: `update-ref` with an expected old value is the branch
 * compare-and-swap, `reset` and `update-index` update index entries, and
 * staging runs `git add`. A staged commit is written as objects and moved
 * onto the branch by compare-and-swap (below). isomorphic-git never writes
 * the native index.
 *
 * A merge with conflicts is never left in the folder: the folder never
 * writes `MERGE_HEAD`, and one another Git program began blocks commits and
 * incoming updates until it is finished or abandoned with Git.
 *
 * A staged commit pins its parent first, the branch head. It then writes, as
 * objects, the index's tree and a commit naming that parent, and moves the
 * branch from it by compare-and-swap. `git commit`
 * would take whatever `HEAD` names when it runs. Like a whole-folder commit,
 * a staged commit runs no commit hooks and is not signed.
 *
 * The backend reaches the machine only through its host: a `git` runner and
 * directory primitives. `native-host.ts` supplies them in Bun and Node; the
 * desktop app supplies them through its shell (`tauri-directory.ts`).
 */
import type { FileBoundary } from '../boundary.js';
import type { DirectoryPrimitives } from '../directory-handle.js';
import { byCodePoint, NORMALIZING } from './attributes.js';
import type {
	GitBackend,
	GitRemote,
	PathStatus,
	PublishResult,
	StatusCode,
} from './backend.js';
import { capturedIndexMatchesHead } from './captured-index.js';
import { createMutex } from './mutex.js';
import { nativeCheckpointProblem } from './native-checkpoint.js';
import {
	type CommitSummary,
	commitTree,
	EMPTY_TREE,
	type ObjectAccess,
	writeCommitObject,
} from './objects.js';
import { primitiveFs } from './primitive-fs.js';

const ZERO = '0000000000000000000000000000000000000000';
const REMOTE_NAME = 'origin';

export class GitCommandError extends Error {
	constructor(
		readonly args: readonly string[],
		readonly code: number | null,
		readonly stderr: string,
	) {
		super(
			stderr.trim() === ''
				? `git ${args[0]} exited with ${code}`
				: `git ${args[0]}: ${stderr.trim()}`,
		);
		this.name = 'GitCommandError';
	}
}

export type GitRun = (
	args: readonly string[],
	options?: {
		input?: Uint8Array | string;
		signal?: AbortSignal;
		allowFailure?: boolean;
		env?: Readonly<Record<string, string>>;
	},
) => Promise<{ code: number | null; stdout: Uint8Array; stderr: string }>;

/** How the backend reaches the machine. */
export type NativeGitHost = {
	/** Runs `git` in the folder's root, with the repository-pinning environment. */
	readonly run: GitRun;
	/** The file system, with absolute paths. */
	readonly files: DirectoryPrimitives;
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export async function createNativeGitBackend({
	root,
	branch,
	remote,
	boundary,
	host,
	exclusive,
}: {
	root: string;
	branch: string;
	remote: GitRemote | undefined;
	boundary: FileBoundary;
	host: NativeGitHost;
	/**
	 * Serializes this folder's index and branch work across every handle that
	 * shares it, such as the windows of one app. Omitted, each handle orders
	 * only its own work, and other processes are met at Git's lock files.
	 */
	exclusive?: GitBackend['exclusive'];
}): Promise<GitBackend> {
	const { run, files } = host;
	const gitdir = `${root}/.git`;
	// Objects are stored by `git hash-object -w`, which names and checks
	// each one; nothing writes an object file by hand.
	const access: ObjectAccess = {
		fs: primitiveFs(files, {
			gitdir,
			async write(type, content) {
				const { stdout } = await run(
					['hash-object', '-w', '-t', type, '--stdin'],
					{ input: content },
				);
				return text(stdout).trim();
			},
		}),
		gitdir,
	};
	const branchRef = `refs/heads/${branch}`;
	const trackingRef = `refs/remotes/${REMOTE_NAME}/${remote?.branch ?? branch}`;

	const isRepository = (await files.lstat(`${gitdir}/HEAD`)) !== undefined;
	if (!isRepository)
		await run(['init', '--quiet', `--initial-branch=${branch}`]);

	// This handle's own work only. Another process is met at Git's lock
	// files, where a held lock fails the command instead of delaying it.
	const queue = createMutex();
	const serialized: GitBackend['exclusive'] = exclusive ?? queue.run;

	async function resolve(ref: string): Promise<string | undefined> {
		const result = await run(
			['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
			{
				allowFailure: true,
			},
		);
		if (result.code !== 0) return undefined;
		return text(result.stdout).trim();
	}

	const literal = ['--literal-pathspecs'];

	/** Reset the named index entries without changing working files. */
	async function syncIndex(commit: string, paths: readonly string[]) {
		if (paths.length === 0) return;
		await run(
			[
				...literal,
				'reset',
				'--quiet',
				commit,
				'--pathspec-from-file=-',
				'--pathspec-file-nul',
			],
			{ input: `${paths.join('\0')}\0` },
		);
	}

	/** A private Git file's bytes, or `undefined` when there is none. */
	async function readPrivate(name: string): Promise<Uint8Array | undefined> {
		const path = `${gitdir}/${name}`;
		if ((await files.lstat(path)) === undefined) return undefined;
		return files.readFile(path);
	}

	/**
	 * The tree the index names now, by Git's own rules: an unmerged path
	 * fails it, and an intent-to-add entry (`git add -N`) is left out.
	 * `write-tree` runs on a private copy, because on the live index it
	 * rewrites the cached trees: a commit the compare-and-swap refuses then
	 * leaves the index byte for byte as it was.
	 */
	async function indexTree(): Promise<string> {
		const copy = `${gitdir}/index.tmp-${crypto.randomUUID()}`;
		try {
			// No index is an empty one.
			const index = await readPrivate('index');
			if (index !== undefined)
				await files.writeFile(copy, index, { createNew: true });
			// Keep the scratch index from creating an unreferenced shared index.
			const written = await run(['-c', 'core.splitIndex=false', 'write-tree'], {
				env: { GIT_INDEX_FILE: copy },
			});
			return text(written.stdout).trim();
		} finally {
			if ((await files.lstat(copy).catch(() => undefined)) !== undefined)
				await files.remove(copy).catch(() => {});
		}
	}

	function parsePorcelain(output: Uint8Array): PathStatus[] {
		const tokens = text(output).split('\0');
		const result: PathStatus[] = [];
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index]!;
			if (token.length < 4) continue;
			const indexCode = token[0] as StatusCode;
			const worktreeCode = token[1] as StatusCode;
			const path = token.slice(3);
			if (indexCode === 'R' || indexCode === 'C') index++;
			result.push({ path, index: indexCode, worktree: worktreeCode });
		}
		return result;
	}

	const backend: GitBackend = {
		branch,
		remote,
		async withObjects(work) {
			return work(access);
		},
		exclusive: serialized,
		readBranch: () => resolve(branchRef),
		readRemoteTracking: () => resolve(trackingRef),
		async casBranch(expected, next) {
			const result = await run(
				[
					'update-ref',
					'-m',
					'epicenter: commit',
					branchRef,
					next,
					expected ?? ZERO,
				],
				{ allowFailure: true },
			);
			if (result.code === 0) return { ok: true };
			const actual = await resolve(branchRef);
			if (actual !== expected) return { ok: false, actual };
			throw new GitCommandError(['update-ref'], result.code, result.stderr);
		},
		async blocked() {
			const head = await run(['symbolic-ref', '--quiet', 'HEAD'], {
				allowFailure: true,
			});
			if (head.code !== 0) return 'HEAD is detached';
			if (text(head.stdout).trim() !== branchRef)
				return `HEAD is not on ${branch}`;
			// The folder never begins a merge; one another Git program began is
			// finished or abandoned with Git.
			for (const marker of [
				'MERGE_HEAD',
				'CHERRY_PICK_HEAD',
				'REVERT_HEAD',
				'rebase-merge',
				'rebase-apply',
				'BISECT_LOG',
			]) {
				const present =
					(await files.lstat(`${gitdir}/${marker}`)) !== undefined;
				if (present) return `a Git operation is in progress (${marker})`;
			}
			return undefined;
		},
		async checkpointProblem() {
			return nativeCheckpointProblem({
				root,
				run,
				files,
				head: await resolve(branchRef),
				ignored: (paths) => backend.ignoredPaths(paths, new Map()),
			});
		},
		async incomingAttribute(commit, files) {
			if (files.size === 0) return undefined;
			// Git's own attribute matching, against the commit's tree alone. A
			// Git too old for `--source` fails here, before anything is written.
			const result = await run(
				['check-attr', `--source=${commit}`, '--stdin', '-z', ...NORMALIZING],
				{ input: `${[...files.keys()].sort(byCodePoint).join('\0')}\0` },
			);
			const records = text(result.stdout).split('\0');
			for (let index = 0; index + 2 < records.length; index += 3) {
				const [path, attribute, value] = records.slice(index, index + 3);
				if (value !== 'unspecified' && value !== 'unset')
					return {
						path: path!,
						attribute: value === 'set' ? attribute! : `${attribute}=${value}`,
					};
			}
			return undefined;
		},
		async reconcileIndex(commit) {
			// `diff-index --cached` lists every index entry that differs from the
			// tree, including staged-only additions and deletions.
			const differing = await run([
				'diff-index',
				'--cached',
				'--name-only',
				'--no-renames',
				'-z',
				commit,
			]);
			const paths = text(differing.stdout).split('\0').filter(Boolean);
			await syncIndex(commit, paths);
		},
		async ignoredPaths(candidates) {
			// `--no-index` evaluates the rules alone; the caller keeps tracked files.
			const result = await run(
				['check-ignore', '--no-index', '--stdin', '-z'],
				{ input: `${candidates.join('\0')}\0`, allowFailure: true },
			);
			if (result.code !== 0 && result.code !== 1)
				throw new GitCommandError(['check-ignore'], result.code, result.stderr);
			return new Set(text(result.stdout).split('\0').filter(Boolean));
		},
		async indexMatchesHead(captured) {
			return backend.withObjects((access) =>
				capturedIndexMatchesHead(access, captured),
			);
		},
		readIndex: () => readPrivate('index'),
		async pathStatus() {
			const result = await run([
				'status',
				'--porcelain=v1',
				'-z',
				'--untracked-files=all',
			]);
			return parsePorcelain(result.stdout);
		},
		async stage(paths) {
			if (paths === 'all') await run(['add', '--all']);
			else await run([...literal, 'add', '--all', '--', ...paths]);
		},
		async commitIndex(message, author) {
			// The parent is pinned before anything is written; the branch moves
			// only from it.
			const parent = await resolve(branchRef);
			const tree = await indexTree();
			if (
				tree ===
				(parent === undefined ? EMPTY_TREE : await commitTree(access, parent))
			)
				return { status: 'nothing' };
			const oid = await writeCommitObject(access, {
				tree,
				parents: parent === undefined ? [] : [parent],
				message,
				author,
			});
			const moved = await backend.casBranch(parent, oid);
			if (!moved.ok)
				return {
					status: 'branchMoved',
					expected: parent,
					actual: moved.actual,
				};
			return { status: 'committed', oid, parent };
		},
		async diff({ staged, paths }) {
			const result = await run([
				...literal,
				'diff',
				'--no-color',
				'--no-ext-diff',
				// No textconv driver runs, whatever attributes name one.
				'--no-textconv',
				...(staged ? ['--cached'] : []),
				'--',
				...paths,
			]);
			return text(result.stdout);
		},
		async log(depth): Promise<CommitSummary[]> {
			if ((await resolve(branchRef)) === undefined) return [];
			const result = await run([
				'log',
				`-n${depth}`,
				'--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x1e',
				branchRef,
			]);
			return text(result.stdout)
				.split('\x1e')
				.map((record) => record.replace(/^\n/, ''))
				.filter((record) => record.trim() !== '')
				.map((record) => {
					const [oid, parents, name, email, timestamp, message] =
						record.split('\x1f');
					return {
						oid: oid!,
						parents: parents ? parents.split(' ') : [],
						message: message ?? '',
						author: {
							name: name!,
							email: email!,
							timestamp: Number(timestamp),
						},
					};
				});
		},
		async push(oid, signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			await run(
				[
					'push',
					'--porcelain',
					remote.url,
					`${oid}:refs/heads/${remote.branch}`,
				],
				{ signal },
			);
			await run(['update-ref', trackingRef, oid]);
		},
		async fetch(signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			const result = await run(
				[
					'fetch',
					'--no-tags',
					'--quiet',
					remote.url,
					`+refs/heads/${remote.branch}:${trackingRef}`,
				],
				{ signal, allowFailure: true },
			);
			if (result.code !== 0) {
				if (/couldn't find remote ref/i.test(result.stderr)) return undefined;
				throw new GitCommandError(['fetch'], result.code, result.stderr);
			}
			return resolve(trackingRef);
		},
		// The baseline is not checked here: each step carries its own file
		// condition, and other programs are met only at Git's lock files.
		async publishIncoming(plan): Promise<PublishResult> {
			const { error: applyError } = await boundary.apply(plan.changes);
			if (applyError !== null) {
				if (applyError.name === 'Partial')
					return {
						status: 'partial',
						applied: applyError.applied,
						error: applyError.error,
					};
				return { status: 'refused', error: applyError };
			}
			try {
				await syncIndex(plan.nextHead, plan.paths);
			} catch (cause) {
				return {
					status: 'indexFailed',
					error: cause instanceof Error ? cause.message : String(cause),
				};
			}
			const moved = await backend.casBranch(plan.expectedHead, plan.nextHead);
			if (!moved.ok)
				return {
					status: 'branchMoved',
					actual: moved.actual,
					filesApplied: true,
				};
			return { status: 'published' };
		},
	};
	return backend;
}
