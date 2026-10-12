/**
 * A just-bash shell over an opened folder, reached through `folder.terminal()`.
 *
 * The shell reads and writes the same files as the app through the folder's
 * accounted storage; there is no scratch copy. Redirection and `rm` act on
 * whatever is at a path. A write makes no commit (ADR-0529). A command that
 * rewrites a file it read in the same command writes against the sha256 it
 * read, so an intervening replacement is refused; a plain redirection is a
 * deliberate overwrite.
 *
 * `git` is a real command over the folder's history: status, diff, log, add,
 * commit -m, push, fetch, pull --ff-only, and merge. `git merge` merges the
 * already fetched remote head when it fast-forwards or merges cleanly; a
 * conflict writes nothing and exits 1, pointing to Sync. Other Git commands
 * are refused.
 */
import { Buffer } from 'buffer/';
import {
	Bash,
	type CommandName,
	defineCommand,
	type IFileSystem,
} from 'just-bash';
import type { FileChange, FolderStorage } from './boundary.js';
import { hashBytes, ownBytes } from './capture.js';
import type { ApplyError, FileError } from './errors.js';
import type { FolderGit } from './folder.js';
import { CONFLICTS_NEED_SYNC, type MergeConflict } from './git/errors.js';

export type TerminalResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

export type FolderTerminal = {
	/** The working directory the next command starts in. */
	readonly cwd: string;
	exec(
		command: string,
		options?: { signal?: AbortSignal },
	): Promise<TerminalResult>;
};

const COMMANDS: CommandName[] = [
	'cat',
	'ls',
	'pwd',
	'sed',
	'awk',
	'echo',
	'printf',
	'grep',
	'rg',
	'head',
	'tail',
	'wc',
	'find',
	'tree',
	'mkdir',
	'rmdir',
	'cp',
	'mv',
	'rm',
	'stat',
	'touch',
	'diff',
	'sort',
	'uniq',
	'cut',
	'tr',
	'tee',
	'basename',
	'dirname',
	'true',
	'false',
	'sha256sum',
	'help',
	'clear',
];

/** Just Bash recognizes filesystem codes in the message, not an error property. */
const failure = (message: string, code: string) =>
	new Error(`${code}: ${message}`);

function fail(error: FileError | ApplyError): never {
	const code =
		error.name === 'NotFound'
			? 'ENOENT'
			: error.name === 'NotAFile'
				? 'EISDIR'
				: error.name === 'NotADirectory'
					? 'ENOTDIR'
					: error.name === 'DirectoryNotEmpty'
						? 'ENOTEMPTY'
						: error.name === 'Exists'
							? 'EEXIST'
							: error.name === 'Conflict'
								? 'ESTALE'
								: 'EIO';
	throw failure(error.message, code);
}

export function createTerminal(
	{ storage, git }: { storage: FolderStorage; git: FolderGit },
	{ cwd: initialCwd = '/' }: { cwd?: string } = {},
): FolderTerminal {
	let cwd = initialCwd;
	let files = new Map<string, number>();
	let directories = new Set<string>(['']);
	/** Versions read during the current command, by folder-relative path. */
	const observed = new Map<string, string>();

	async function refresh() {
		const { data: listing, error: listError } = await storage.list();
		if (listError !== null) fail(listError);
		files = new Map(listing.files.map((file) => [file.path, file.size]));
		directories = new Set(['', ...listing.directories]);
	}

	function resolvePath(base: string, path: string): string {
		const parts = path.startsWith('/') ? [] : base.split('/').filter(Boolean);
		for (const part of path.split('/')) {
			if (part === '' || part === '.') continue;
			if (part === '..') parts.pop();
			else parts.push(part);
		}
		return `/${parts.join('/')}`;
	}
	const relative = (path: string) => resolvePath('/', path).slice(1);

	function isFile(path: string) {
		return files.has(relative(path));
	}
	function isDirectory(path: string) {
		return directories.has(relative(path));
	}

	/** Snapshot descendants before a tree operation starts changing storage. */
	function descendantsOf(name: string) {
		const prefix = `${name}/`;
		return {
			prefix,
			files: [...files.keys()].filter((path) => path.startsWith(prefix)),
			directories: [...directories].filter((path) => path.startsWith(prefix)),
		};
	}

	async function readBytes(path: string): Promise<Uint8Array> {
		const name = relative(path);
		const { data: file, error: readError } = await storage.read(name);
		if (readError !== null) fail(readError);
		observed.set(name, file.sha256);
		return file.bytes;
	}

	/**
	 * Maintain command observations for every confirmed step, including
	 * partial progress.
	 */
	async function applyChanges(changes: readonly FileChange[]) {
		if (changes.length === 0) return;
		const { error: applyError } = await storage.apply(changes);
		const applied =
			applyError === null
				? changes
				: applyError.name === 'Partial'
					? applyError.applied
					: [];
		for (const step of applied) {
			if (step.kind === 'remove') observed.delete(step.path);
			else if (step.kind === 'move') {
				const sha256 = observed.get(step.from);
				observed.delete(step.from);
				if (sha256 === undefined) observed.delete(step.to);
				else observed.set(step.to, sha256);
			} else {
				const write = changes.find(
					(change) =>
						change.kind !== 'move' &&
						change.kind !== 'remove' &&
						change.path === step.path,
				);
				// A native move can publish its destination before retiring its source fails.
				const move = changes.find(
					(change) => change.kind === 'move' && change.to === step.path,
				);
				const sha256 =
					write && 'sha256' in write
						? write.sha256
						: move?.kind === 'move'
							? observed.get(move.from)
							: undefined;
				if (sha256 === undefined) observed.delete(step.path);
				else observed.set(step.path, sha256);
			}
		}
		if (applyError !== null) {
			if (applied.length > 0 || applyError.name === 'Unconfirmed')
				await refresh().catch(() => {});
			fail(applyError);
		}
		await refresh();
	}

	async function removeDirectories(paths: readonly string[]) {
		for (const path of paths) {
			const { error: removeError } = await storage.rmdir(path);
			if (removeError !== null && removeError.name !== 'NotFound')
				fail(removeError);
			// Derived directories can disappear with their last file.
			directories.delete(path);
		}
		await refresh();
	}

	async function writeBytes(path: string, content: string | Uint8Array) {
		const name = relative(path);
		const bytes = ownBytes(content);
		// A rewrite of bytes this command read is conditional; otherwise the
		// shell deliberately overwrites or creates the path.
		const expectedSha256 = observed.get(name);
		const sha256 = await hashBytes(bytes);
		await applyChanges([
			expectedSha256 === undefined
				? { kind: 'overwrite', path: name, bytes, sha256 }
				: { kind: 'replace', path: name, bytes, sha256, expectedSha256 },
		]);
	}

	const fs: IFileSystem = {
		resolvePath,
		getAllPaths: () =>
			[
				...[...directories].map((directory) => `/${directory}`),
				...[...files.keys()].map((file) => `/${file}`),
			].sort(),
		async readFile(path, options) {
			const bytes = await readBytes(path);
			const encoding =
				typeof options === 'string' ? options : options?.encoding;
			return Buffer.from(bytes).toString(encoding ?? 'utf8');
		},
		readFileBuffer: readBytes,
		writeFile: async (path, content, options) => {
			const encoding =
				typeof options === 'string' ? options : options?.encoding;
			await writeBytes(
				path,
				typeof content === 'string'
					? Buffer.from(content, encoding ?? 'utf8')
					: content,
			);
		},
		async appendFile(path, content, options) {
			const encoding =
				typeof options === 'string' ? options : options?.encoding;
			const addition =
				typeof content === 'string'
					? Buffer.from(content, encoding ?? 'utf8')
					: ownBytes(content);
			const name = relative(path);
			const { data: file, error: readError } = await storage.read(name);
			if (readError !== null) {
				if (readError.name !== 'NotFound') fail(readError);
				await applyChanges([
					{
						kind: 'create',
						path: name,
						bytes: addition,
						sha256: await hashBytes(addition),
					},
				]);
				return;
			}
			observed.set(name, file.sha256);
			if (addition.length === 0) return;
			const next = new Uint8Array(file.bytes.length + addition.length);
			next.set(file.bytes);
			next.set(addition, file.bytes.length);
			await writeBytes(path, next);
		},
		exists: async (path) => isFile(path) || isDirectory(path),
		async stat(path) {
			const file = isFile(path);
			if (!file && !isDirectory(path))
				throw failure(`No such file or directory: ${path}`, 'ENOENT');
			return {
				// Identity belongs to a literal Folder entry, not a native inode.
				identity: resolvePath('/', path),
				isFile: file,
				isDirectory: !file,
				isSymbolicLink: false,
				mode: file ? 0o644 : 0o755,
				size: file ? (files.get(relative(path)) ?? 0) : 0,
				mtime: new Date(0),
			};
		},
		lstat: (path) => fs.stat(path),
		async realpath(path) {
			if (!(await fs.exists(path)))
				throw failure(`No such file or directory: ${path}`, 'ENOENT');
			return resolvePath('/', path);
		},
		async mkdir(path, options) {
			const name = relative(path);
			if (isDirectory(path) && options?.recursive) return;
			if (isFile(path) || isDirectory(path))
				throw failure(`File exists: ${path}`, 'EEXIST');
			const parent = resolvePath(path, '..');
			if (isFile(parent))
				throw failure(`Not a directory: ${parent}`, 'ENOTDIR');
			if (!options?.recursive && !isDirectory(parent))
				throw failure(`No such file or directory: ${parent}`, 'ENOENT');
			const { error: mkdirError } = await storage.mkdir(name);
			if (mkdirError !== null) fail(mkdirError);
			await refresh();
		},
		async readdir(path) {
			if (!isDirectory(path))
				throw isFile(path)
					? failure(`Not a directory: ${path}`, 'ENOTDIR')
					: failure(`No such file or directory: ${path}`, 'ENOENT');
			const name = relative(path);
			const prefix = name === '' ? '' : `${name}/`;
			return [
				...new Set(
					[...directories, ...files.keys()]
						.filter((entry) => entry !== name && entry.startsWith(prefix))
						.map((entry) => entry.slice(prefix.length).split('/')[0]!),
				),
			].sort();
		},
		async rm(path, options) {
			const name = relative(path);
			if (isFile(path)) {
				await applyChanges([
					{ kind: 'remove', path: name, expectedSha256: observed.get(name) },
				]);
				return;
			}
			if (!isDirectory(path)) {
				if (options?.force) return;
				throw failure(`No such file or directory: ${path}`, 'ENOENT');
			}
			const { files: nestedFiles, directories: nestedDirectories } =
				descendantsOf(name);
			nestedDirectories.sort((a, b) => b.length - a.length);
			if (
				(nestedFiles.length > 0 || nestedDirectories.length > 0) &&
				!options?.recursive
			)
				throw failure(`Directory not empty: ${path}`, 'ENOTEMPTY');
			await applyChanges(
				nestedFiles.map((path) => ({
					kind: 'remove',
					path,
					expectedSha256: observed.get(path),
				})),
			);
			await removeDirectories([...nestedDirectories, name]);
		},
		async cp(source, destination, options) {
			if (!isDirectory(source)) {
				await writeBytes(destination, await readBytes(source));
				return;
			}
			if (!options?.recursive)
				throw failure(`Copying a directory requires -r: ${source}`, 'EISDIR');
			const {
				prefix,
				files: sourceFiles,
				directories: sourceDirectories,
			} = descendantsOf(relative(source));
			for (const path of [relative(source), ...sourceDirectories]) {
				const target =
					path === relative(source)
						? destination
						: `${destination}/${path.slice(prefix.length)}`;
				await fs.mkdir(target, { recursive: true });
			}
			for (const file of sourceFiles) {
				// Each copied file is its own save, as a single-file copy is.
				await writeBytes(
					resolvePath('/', `${destination}/${file.slice(prefix.length)}`),
					await readBytes(`/${file}`),
				);
			}
		},
		async mv(source, destination) {
			const from = relative(source);
			const to = relative(destination);
			if (isFile(source)) {
				await applyChanges([
					{ kind: 'move', from, to, expectedSha256: observed.get(from) },
				]);
				return;
			}
			if (!isDirectory(source))
				throw failure(`No such file or directory: ${source}`, 'ENOENT');
			if (isFile(destination) || isDirectory(destination))
				throw failure(`File exists: ${destination}`, 'EEXIST');
			const {
				prefix,
				files: sourceFiles,
				directories: sourceDirectories,
			} = descendantsOf(from);
			for (const path of [from, ...sourceDirectories]) {
				const target =
					path === from ? to : `${to}/${path.slice(prefix.length)}`;
				await fs.mkdir(`/${target}`, { recursive: true });
			}
			await applyChanges(
				sourceFiles.map((path) => ({
					kind: 'move',
					from: path,
					to: `${to}/${path.slice(prefix.length)}`,
					expectedSha256: observed.get(path),
				})),
			);
			await removeDirectories([
				...sourceDirectories.sort((a, b) => b.length - a.length),
				from,
			]);
		},
		async chmod(path) {
			if (!(await fs.exists(path)))
				throw failure(`No such file or directory: ${path}`, 'ENOENT');
		},
		async utimes(path) {
			if (!(await fs.exists(path)))
				throw failure(`No such file or directory: ${path}`, 'ENOENT');
		},
		async symlink() {
			throw failure('Symbolic links are not portable folder files', 'EPERM');
		},
		async link() {
			throw failure('Hard links are not portable folder files', 'EPERM');
		},
		async readlink(path) {
			throw failure(`Not a symbolic link: ${path}`, 'EINVAL');
		},
	};

	const gitCommand = defineCommand('git', async (args, context) => {
		const result = await runGit(git, args, (path) =>
			relative(context.fs.resolvePath(context.cwd, path)),
		);
		// A merge may publish files whether it succeeds or fails partway.
		if ((args[0] === 'pull' && result.exitCode === 0) || args[0] === 'merge')
			await refresh();
		return result;
	});

	const bash = new Bash({
		fs,
		cwd: initialCwd,
		customCommands: [gitCommand],
		commands: COMMANDS,
		defenseInDepth: false,
	});

	let queue: Promise<unknown> = Promise.resolve();

	return {
		get cwd() {
			return cwd;
		},
		exec(command, { signal } = {}) {
			const run = queue.then(async (): Promise<TerminalResult> => {
				observed.clear();
				try {
					await refresh();
				} catch (cause) {
					return {
						stdout: '',
						stderr: `${(cause as Error).message}\n`,
						exitCode: 1,
					};
				}
				const result = await bash.exec(command, { cwd, signal });
				const next = result.env?.PWD;
				if (next !== undefined && isDirectory(next)) cwd = next;
				return {
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
				};
			});
			queue = run.catch(() => {});
			return run;
		},
	};
}

/** Git's own report lines for the conflicts of a refused merge. */
function conflictLines(
	conflicts: readonly MergeConflict[],
	upstream: string,
): string {
	const lines: string[] = [];
	const reported = new Set<string>();
	for (const conflict of conflicts) {
		if (reported.has(conflict.path)) continue;
		reported.add(conflict.path);
		if (conflict.reason === 'deleted')
			lines.push(
				`CONFLICT (modify/delete): ${conflict.path} deleted in ${conflict.deletedBy === 'ours' ? 'HEAD' : upstream} and modified in ${conflict.deletedBy === 'ours' ? upstream : 'HEAD'}.`,
			);
		else if (conflict.reason === 'kvFile')
			lines.push(
				`CONFLICT (modify/delete): ${conflict.path} deleted on one side and modified on the other.`,
			);
		else {
			if (conflict.reason === 'binary')
				lines.push(
					`warning: Cannot merge binary files: ${conflict.path} (HEAD vs. ${upstream})`,
				);
			lines.push(`CONFLICT (content): Merge conflict in ${conflict.path}`);
		}
	}
	return lines.join('\n');
}

const short = (oid: string | undefined) =>
	oid === undefined ? '(none)' : oid.slice(0, 7);

async function runGit(
	git: FolderGit,
	args: string[],
	toPath: (path: string) => string,
): Promise<TerminalResult> {
	const ok = (stdout: string): TerminalResult => ({
		stdout,
		stderr: '',
		exitCode: 0,
	});
	const error = (message: string, exitCode = 1): TerminalResult => ({
		stdout: '',
		stderr: message.endsWith('\n') ? message : `${message}\n`,
		exitCode,
	});
	const [subcommand, ...rest] = args;
	switch (subcommand) {
		case 'status': {
			const unsupported = rest.filter(
				(arg) =>
					!['-s', '--short', '--porcelain', '-b', '--branch'].includes(arg),
			);
			if (unsupported.length > 0)
				return error(`git status: unsupported option ${unsupported[0]}`, 129);
			const { data: paths, error: pathsError } = await git.paths();
			if (pathsError !== null) return error(pathsError.message);
			const snapshot = git.snapshot;
			const sync =
				snapshot.sync.state === 'observed' ? snapshot.sync.value : undefined;
			let header = `## ${snapshot.branch}`;
			if (sync?.remote !== undefined && snapshot.remote !== undefined) {
				header += `...origin/${snapshot.remote.branch}`;
				const counts = [
					sync.ahead > 0 ? `ahead ${sync.ahead}` : '',
					sync.behind > 0 ? `behind ${sync.behind}` : '',
				].filter(Boolean);
				if (counts.length > 0) header += ` [${counts.join(', ')}]`;
			}
			const lines = paths.map((path) =>
				path.index === '?' || path.worktree === '?'
					? `?? ${path.path}`
					: `${path.index}${path.worktree} ${path.path}`,
			);
			if (lines.length === 0)
				return ok(`${header}\nnothing to commit, working tree clean\n`);
			return ok(`${header}\n${lines.join('\n')}\n`);
		}
		case 'diff': {
			let staged = false;
			const paths: string[] = [];
			for (const arg of rest) {
				if (arg === '--cached' || arg === '--staged') staged = true;
				else if (arg === '--') continue;
				else if (arg.startsWith('-'))
					return error(`git diff: unsupported option ${arg}`, 129);
				else paths.push(toPath(arg));
			}
			const { data: diff, error: diffError } = await git.diff({
				staged,
				paths: paths.map((path) => path || '.'),
			});
			if (diffError !== null) return error(diffError.message);
			return ok(diff);
		}
		case 'log': {
			let depth = 20;
			let oneline = false;
			for (let index = 0; index < rest.length; index++) {
				const arg = rest[index]!;
				if (arg === '--oneline') oneline = true;
				else if (arg === '-n') depth = Number(rest[++index]);
				else if (/^-n\d+$/.test(arg)) depth = Number(arg.slice(2));
				else if (/^-\d+$/.test(arg)) depth = Number(arg.slice(1));
				else if (/^--max-count=\d+$/.test(arg))
					depth = Number(arg.split('=')[1]);
				else return error(`git log: unsupported argument ${arg}`, 129);
			}
			if (!Number.isInteger(depth) || depth < 1)
				return error('git log: invalid count', 129);
			const { data: commits, error: logError } = await git.log(depth);
			if (logError !== null) return error(logError.message);
			if (commits.length === 0)
				return error(
					`fatal: your current branch '${git.snapshot.branch}' does not have any commits yet`,
					128,
				);
			if (oneline)
				return ok(
					commits
						.map(
							(commit) =>
								`${short(commit.oid)} ${commit.message.split('\n')[0]}`,
						)
						.join('\n') + '\n',
				);
			return ok(
				commits
					.map((commit) => {
						const date = new Date(commit.author.timestamp * 1000).toISOString();
						const body = commit.message
							.replace(/\n+$/, '')
							.split('\n')
							.map((line) => `    ${line}`)
							.join('\n');
						return `commit ${commit.oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\nDate:   ${date}\n\n${body}\n`;
					})
					.join('\n'),
			);
		}
		case 'add': {
			if (rest.length === 0)
				return error(
					"Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?",
				);
			let all = false;
			const paths: string[] = [];
			for (const arg of rest) {
				if (arg === '-A' || arg === '--all') all = true;
				else if (arg === '--') continue;
				else if (arg.startsWith('-'))
					return error(`git add: unsupported option ${arg}`, 129);
				else paths.push(toPath(arg));
			}
			const target = all || paths.includes('') ? 'all' : paths;
			const { error: stageError } = await git.stage(target);
			if (stageError !== null)
				return error(`fatal: ${stageError.message}`, 128);
			return ok('');
		}
		case 'commit': {
			const messages: string[] = [];
			for (let index = 0; index < rest.length; index++) {
				const arg = rest[index]!;
				if (arg === '-m' || arg === '--message') {
					const value = rest[++index];
					if (value === undefined)
						return error(`error: switch \`m' requires a value`, 129);
					messages.push(value);
				} else if (arg.startsWith('--message='))
					messages.push(arg.slice('--message='.length));
				else if (arg.startsWith('-m') && arg.length > 2)
					messages.push(arg.slice(2));
				else
					return error(
						`git commit: unsupported argument ${arg}; use git add, then git commit -m <message>`,
						129,
					);
			}
			if (messages.length === 0)
				return error(
					'git commit: a message is required: git commit -m <message>',
					129,
				);
			const { data: committed, error: commitError } = await git.commitStaged(
				messages.join('\n\n'),
			);
			if (commitError !== null) {
				if (commitError.name === 'NothingToCommit')
					return error('nothing added to commit', 1);
				return error(commitError.message);
			}
			const subject = messages[0]!.split('\n')[0];
			return ok(
				`[${git.snapshot.branch} ${short(committed.oid)}] ${subject}\n`,
			);
		}
		case 'push': {
			if (rest.length > 0)
				return error(
					'git push: arguments are not supported; the folder pushes its branch to its configured remote',
					129,
				);
			const pushed = await git.push();
			switch (pushed.status) {
				case 'pushed':
					return ok(
						`To ${git.snapshot.remote?.url}\n   ${short(pushed.oid)} -> ${git.snapshot.remote?.branch}\n`,
					);
				case 'noRemote':
					return error('fatal: No configured push destination.', 128);
				case 'nothingToPush':
					return error(
						'error: src refspec does not match any: there are no commits yet',
					);
				case 'failed':
					return error(
						`error: failed to push ${short(pushed.oid)}: ${pushed.error}`,
					);
				case 'unconfirmed':
					return error(`error: push not confirmed: ${pushed.error}`);
				case 'cancelled':
				case 'closed':
				case 'skipped':
					return error(`error: push ${pushed.status}`);
			}
			return error('error: push did not complete');
		}
		case 'fetch': {
			if (rest.length > 0)
				return error(
					'git fetch: arguments are not supported; the folder fetches its configured remote branch',
					129,
				);
			const { data: fetched, error: fetchError } = await git.fetch();
			if (fetchError !== null) return error(fetchError.message);
			const remote = git.snapshot.remote;
			if (fetched.oid === undefined)
				return ok(`The remote has no ${remote?.branch} branch yet\n`);
			return ok(
				`From ${remote?.url}\n * ${remote?.branch} -> origin/${remote?.branch} (${short(fetched.oid)})\n`,
			);
		}
		case 'pull': {
			if (
				!rest.includes('--ff-only') ||
				rest.some((arg) => arg !== '--ff-only')
			)
				return error('git pull: only `git pull --ff-only` is supported', 129);
			const { error: fetchError } = await git.fetch();
			if (fetchError !== null) return error(fetchError.message);
			const { data: pulled, error: pullError } = await git.pullFastForward();
			if (pullError !== null) return error(`fatal: ${pullError.message}`, 128);
			switch (pulled.status) {
				case 'upToDate':
					return ok('Already up to date.\n');
				case 'ahead':
					return ok(
						'Already up to date. Local commits are ahead of the remote.\n',
					);
				case 'fastForwarded':
					return ok(
						`Updating ${short(pulled.from)}..${short(pulled.to)}\nFast-forward\n${pulled.changedPaths
							.map((path) => ` ${path}`)
							.join('\n')}\n ${pulled.changedPaths.length} files changed\n`,
					);
			}
			return error('pull did not complete');
		}
		case 'merge': {
			const remote = git.snapshot.remote;
			const upstream = `origin/${remote?.branch ?? git.snapshot.branch}`;
			const targets = rest.filter((arg) => arg !== '--no-edit');
			if (
				targets.length > 1 ||
				(targets.length === 1 &&
					![upstream, '@{u}', '@{upstream}'].includes(targets[0]!))
			)
				return error(
					`git merge: only the fetched remote branch can be merged: git merge [${upstream}]`,
					129,
				);
			const { data: merged, error: mergeError } = await git.mergeIncoming();
			if (mergeError !== null) {
				if (mergeError.name === 'NoFetchedHead')
					return error(`merge: ${upstream} - not something we can merge`);
				if (mergeError.name === 'Conflicted')
					return error(
						`${conflictLines(mergeError.conflicts, upstream)}\n${CONFLICTS_NEED_SYNC}`,
						1,
					);
				return error(`fatal: ${mergeError.message}`, 128);
			}
			const files = (paths: readonly string[]) =>
				`${paths.map((path) => ` ${path}`).join('\n')}\n ${paths.length} ${paths.length === 1 ? 'file' : 'files'} changed\n`;
			switch (merged.status) {
				case 'upToDate':
				case 'ahead':
					return ok('Already up to date.\n');
				case 'fastForwarded':
					return ok(
						`Updating ${short(merged.from)}..${short(merged.to)}\nFast-forward\n${files(merged.changedPaths)}`,
					);
				case 'merged':
					return ok(
						`Merge made: ${short(merged.to)} (parents ${short(merged.from)} and ${short(merged.fetched)})\n${files(merged.changedPaths)}`,
					);
			}
			return error('merge did not complete');
		}
		case undefined:
		case 'help':
		case '--help':
			return ok(
				'Supported: git status, git diff [--cached] [paths], git log [-n N] [--oneline], git add <paths>|-A, git commit -m <message>, git push, git fetch, git pull --ff-only, git merge\n',
			);
		default:
			return error(
				`git: '${subcommand}' is not supported in this folder terminal`,
				1,
			);
	}
}
