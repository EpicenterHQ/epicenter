/**
 * `@epicenter/app/files/terminal`: a just-bash shell over an opened folder.
 *
 * The shell reads and writes the same files as the app through the folder's
 * file boundary; there is no scratch copy. A shell write is an external-writer
 * edit: it saves immediately and requests no automatic commit. A command that
 * rewrites a file it read in the same command writes against the version it
 * read, so an intervening replacement is refused; a plain redirection is a
 * deliberate overwrite.
 *
 * `git` is a real command over the folder's history: status, diff, log, add,
 * commit -m, push, fetch, and pull --ff-only. Other Git commands are refused.
 */
import {
	Bash,
	type CommandName,
	defineCommand,
	type IFileSystem,
} from 'just-bash';
import type { DataDefinition } from '../data/definition/declaration.js';
import type { ApplyError, FileError } from './errors.js';
import type { Folder } from './folder.js';
import type { FileExpectation, FileVersion } from './version.js';

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

type TerminalFolder = Pick<Folder<DataDefinition>, 'files' | 'git'>;

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

class ShellFailure extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
	}
}

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
						: error.name === 'Conflict'
							? 'ESTALE'
							: 'EIO';
	throw new ShellFailure(error.message, code);
}

export function createFolderTerminal(
	folder: TerminalFolder,
	{ cwd: initialCwd = '/' }: { cwd?: string } = {},
): FolderTerminal {
	let cwd = initialCwd;
	let files = new Map<string, number>();
	let directories = new Set<string>(['']);
	/** Versions read during the current command, by folder-relative path. */
	const observed = new Map<string, FileVersion>();

	async function refresh() {
		const listing = await folder.files.list();
		if (listing.error) fail(listing.error);
		files = new Map(listing.data.files.map((file) => [file.path, file.size]));
		directories = new Set(['', ...listing.data.directories]);
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

	async function readBytes(path: string): Promise<Uint8Array> {
		const name = relative(path);
		const read = await folder.files.read(name);
		if (read.error) fail(read.error);
		observed.set(name, read.data.version);
		return read.data.bytes;
	}

	async function writeBytes(path: string, content: string | Uint8Array) {
		const name = relative(path);
		const bytes =
			typeof content === 'string' ? new TextEncoder().encode(content) : content;
		// A rewrite of bytes this command read is conditional; otherwise the
		// shell deliberately overwrites or creates the path.
		const expected: FileExpectation = observed.get(name) ?? 'any';
		const written = await folder.files.write(name, bytes, { expected });
		if (written.error) fail(written.error);
		observed.set(name, written.data);
		await refresh();
	}

	function latin1(bytes: Uint8Array): string {
		let value = '';
		for (let offset = 0; offset < bytes.length; offset += 16384)
			value += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
		return value;
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
			if (encoding === 'binary' || encoding === 'latin1') return latin1(bytes);
			return new TextDecoder().decode(bytes);
		},
		readFileBuffer: readBytes,
		writeFile: async (path, content) => writeBytes(path, content),
		async appendFile(path, content) {
			const prior = isFile(path) ? await readBytes(path) : new Uint8Array();
			const addition =
				typeof content === 'string'
					? new TextEncoder().encode(content)
					: content;
			const next = new Uint8Array(prior.length + addition.length);
			next.set(prior);
			next.set(addition, prior.length);
			await writeBytes(path, next);
		},
		exists: async (path) => isFile(path) || isDirectory(path),
		async stat(path) {
			const file = isFile(path);
			if (!file && !isDirectory(path))
				throw new ShellFailure(`No such file or directory: ${path}`, 'ENOENT');
			return {
				isFile: file,
				isDirectory: !file,
				isSymbolicLink: false,
				mode: file ? 0o100644 : 0o40755,
				size: file ? (files.get(relative(path)) ?? 0) : 0,
				mtime: new Date(0),
			};
		},
		lstat: (path) => fs.stat(path),
		async realpath(path) {
			if (!(await fs.exists(path)))
				throw new ShellFailure(`No such file or directory: ${path}`, 'ENOENT');
			return resolvePath('/', path);
		},
		async mkdir(path, options) {
			const name = relative(path);
			if (isDirectory(path)) {
				if (options?.recursive) return;
				throw new ShellFailure(`File exists: ${path}`, 'EEXIST');
			}
			const made = await folder.files.mkdir(name);
			if (made.error) fail(made.error);
			await refresh();
		},
		async readdir(path) {
			if (!isDirectory(path))
				throw new ShellFailure(`Not a directory: ${path}`, 'ENOTDIR');
			const listed = await folder.files.children(relative(path));
			if (listed.error) fail(listed.error);
			return [...listed.data.directories, ...listed.data.files].sort();
		},
		async rm(path, options) {
			const name = relative(path);
			if (isFile(path)) {
				const removed = await folder.files.remove(name, {
					expected: observed.get(name) ?? 'any',
				});
				if (removed.error) fail(removed.error);
				observed.delete(name);
				await refresh();
				return;
			}
			if (!isDirectory(path)) {
				if (options?.force) return;
				throw new ShellFailure(`No such file or directory: ${path}`, 'ENOENT');
			}
			const prefix = `${name}/`;
			const nestedFiles = [...files.keys()].filter((file) =>
				file.startsWith(prefix),
			);
			const nestedDirectories = [...directories]
				.filter((directory) => directory.startsWith(prefix))
				.sort((a, b) => b.length - a.length);
			if (
				(nestedFiles.length > 0 || nestedDirectories.length > 0) &&
				!options?.recursive
			)
				throw new ShellFailure(`Directory not empty: ${path}`, 'ENOTEMPTY');
			for (const file of nestedFiles) {
				const removed = await folder.files.remove(file, {
					expected: observed.get(file) ?? 'any',
				});
				if (removed.error) fail(removed.error);
			}
			for (const directory of [...nestedDirectories, name]) {
				const removed = await folder.files.rmdir(directory);
				// Directories derived only from files disappear with their files.
				if (removed.error && removed.error.name !== 'NotFound')
					fail(removed.error);
			}
			await refresh();
		},
		async cp(source, destination, options) {
			if (isDirectory(source)) {
				if (!options?.recursive)
					throw new ShellFailure(
						`Copying a directory requires -r: ${source}`,
						'EISDIR',
					);
				const prefix = `${relative(source)}/`;
				for (const file of [...files.keys()].filter((path) =>
					path.startsWith(prefix),
				))
					await writeBytes(
						resolvePath('/', `${destination}/${file.slice(prefix.length)}`),
						await readBytes(`/${file}`),
					);
				return;
			}
			await writeBytes(destination, await readBytes(source));
		},
		async mv(source, destination) {
			const from = relative(source);
			const to = relative(destination);
			if (isFile(source)) {
				const moved = await folder.files.move(from, to, {
					expected: observed.get(from) ?? 'any',
				});
				if (moved.error) fail(moved.error);
				await refresh();
				return;
			}
			await fs.cp(source, destination, { recursive: true });
			await fs.rm(source, { recursive: true });
		},
		async chmod(path) {
			if (!(await fs.exists(path)))
				throw new ShellFailure(`No such file or directory: ${path}`, 'ENOENT');
		},
		async utimes(path) {
			if (!(await fs.exists(path)))
				throw new ShellFailure(`No such file or directory: ${path}`, 'ENOENT');
		},
		async symlink() {
			throw new ShellFailure(
				'Symbolic links are not portable folder files',
				'EPERM',
			);
		},
		async link() {
			throw new ShellFailure(
				'Hard links are not portable folder files',
				'EPERM',
			);
		},
		async readlink(path) {
			throw new ShellFailure(`Not a symbolic link: ${path}`, 'EINVAL');
		},
	};

	const gitCommand = defineCommand('git', async (args, context) =>
		runGit(folder, args, (path) =>
			relative(context.fs.resolvePath(context.cwd, path)),
		),
	);

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

const short = (oid: string | undefined) =>
	oid === undefined ? '(none)' : oid.slice(0, 7);

async function runGit(
	folder: TerminalFolder,
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
			const paths = await folder.git.paths();
			if (paths.error) return error(paths.error.message);
			const snapshot = folder.git.snapshot;
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
			const lines = paths.data.map((path) =>
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
			const diff = await folder.git.diff({
				staged,
				paths: paths.map((path) => path || '.'),
			});
			if (diff.error) return error(diff.error.message);
			return ok(diff.data);
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
			const log = await folder.git.log(depth);
			if (log.error) return error(log.error.message);
			if (log.data.length === 0)
				return error(
					`fatal: your current branch '${folder.git.snapshot.branch}' does not have any commits yet`,
					128,
				);
			if (oneline)
				return ok(
					log.data
						.map(
							(commit) =>
								`${short(commit.oid)} ${commit.message.split('\n')[0]}`,
						)
						.join('\n') + '\n',
				);
			return ok(
				log.data
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
			const staged = await folder.git.stage(target);
			if (staged.error) return error(`fatal: ${staged.error.message}`, 128);
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
			const committed = await folder.git.commitStaged(messages.join('\n\n'));
			if (committed.error) {
				if (committed.error.name === 'NothingToCommit')
					return error('nothing added to commit', 1);
				return error(committed.error.message);
			}
			const subject = messages[0]!.split('\n')[0];
			return ok(
				`[${folder.git.snapshot.branch} ${short(committed.data.oid)}] ${subject}\n`,
			);
		}
		case 'push': {
			if (rest.length > 0)
				return error(
					'git push: arguments are not supported; the folder pushes its branch to its configured remote',
					129,
				);
			const pushed = await folder.git.push();
			switch (pushed.status) {
				case 'pushed':
					return ok(
						`To ${folder.git.snapshot.remote?.url}\n   ${short(pushed.oid)} -> ${folder.git.snapshot.remote?.branch}\n`,
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
			const fetched = await folder.git.fetch();
			if (fetched.error) return error(fetched.error.message);
			const remote = folder.git.snapshot.remote;
			if (fetched.data.oid === undefined)
				return ok(`The remote has no ${remote?.branch} branch yet\n`);
			return ok(
				`From ${remote?.url}\n * ${remote?.branch} -> origin/${remote?.branch} (${short(fetched.data.oid)})\n`,
			);
		}
		case 'pull': {
			if (
				!rest.includes('--ff-only') ||
				rest.some((arg) => arg !== '--ff-only')
			)
				return error('git pull: only `git pull --ff-only` is supported', 129);
			const fetched = await folder.git.fetch();
			if (fetched.error) return error(fetched.error.message);
			const pulled = await folder.git.pullFastForward();
			if (pulled.error) return error(`fatal: ${pulled.error.message}`, 128);
			switch (pulled.data.status) {
				case 'upToDate':
					return ok('Already up to date.\n');
				case 'ahead':
					return ok(
						'Already up to date. Local commits are ahead of the remote.\n',
					);
				case 'fastForwarded':
					return ok(
						`Updating ${short(pulled.data.from)}..${short(pulled.data.to)}\nFast-forward\n${pulled.data.changedPaths
							.map((path) => ` ${path}`)
							.join(
								'\n',
							)}\n ${pulled.data.changedPaths.length} files changed\n`,
					);
			}
			return error('pull did not complete');
		}
		case undefined:
		case 'help':
		case '--help':
			return ok(
				'Supported: git status, git diff [--cached] [paths], git log [-n N] [--oneline], git add <paths>|-A, git commit -m <message>, git push, git fetch, git pull --ff-only\n',
			);
		default:
			return error(
				`git: '${subcommand}' is not supported in this folder terminal`,
				1,
			);
	}
}
