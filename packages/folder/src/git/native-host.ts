/**
 * The native Git backend's host in Bun and Node: the system `git` and
 * `node:fs`.
 */
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nodeDirectoryPrimitives } from '../directory-node.js';
import {
	credentialEnvironment,
	GitCommandError,
	type GitRun,
	type NativeGitHost,
} from './native-backend.js';

/**
 * Inherited variables that would point Git at another repository, index, or
 * object store: the names `git rev-parse --local-env-vars` lists, plus the
 * ref namespace. Each command addresses the repository in its working
 * directory, whatever the parent process had set. The ceiling stops discovery
 * at the root, so a root whose `.git` is missing never resolves to a
 * repository in a directory above it. `GIT_OPTIONAL_LOCKS=0` keeps read-only
 * commands such as `status` and `diff` from taking `index.lock` to refresh
 * the index, so observing the folder never looks like a change to it.
 * `GIT_SSH_COMMAND` goes too, so SSH runs as Git's configuration says.
 *
 * Trace variables are removed too, and Trace2 is switched off, because a
 * trace records Git's configuration and requests, credential headers
 * included, to stderr or to any file it names. The desktop shell's runner
 * removes the same (`is_removed_env` in `page_git.rs`).
 */
const REPOSITORY_ENV =
	/^GIT_(DIR|WORK_TREE|IMPLICIT_WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|GRAFT_FILE|SHALLOW_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*|TRACE.*|CURL_VERBOSE|SSH_COMMAND)$/;

function gitEnvironment(root: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env))
		if (!REPOSITORY_ENV.test(name)) env[name] = value;
	return {
		...env,
		GIT_CEILING_DIRECTORIES: dirname(root),
		GIT_OPTIONAL_LOCKS: '0',
		GIT_TERMINAL_PROMPT: '0',
		GIT_TRACE2: '0',
		GIT_TRACE2_EVENT: '0',
		GIT_TRACE2_PERF: '0',
		LC_ALL: 'C',
	};
}

/**
 * The directory `core.hooksPath` names for every command: no hook is found
 * there on any platform, whatever the repository or the person configures,
 * the desktop shell's rule (`no_hooks_directory` in `page_git.rs`). It is
 * made when missing, and before each command it must be a real, empty
 * directory, since a hook another program planted there would run on
 * `git add`. Before the repository exists it is only named: `git init` runs
 * no hook, and the next command makes it.
 */
async function noHooksDirectory(root: string): Promise<string> {
	const git = join(root, '.git');
	const epicenter = join(git, 'epicenter');
	const noHooks = join(epicenter, 'no-hooks');
	const kind = (path: string) =>
		lstat(path).catch((cause: { code?: string }) => {
			if (cause.code === 'ENOENT') return undefined;
			throw cause;
		});
	if (!(await kind(git))?.isDirectory()) return noHooks;
	// `mkdir` would follow a linked `.git/epicenter` out of the folder.
	const parent = await kind(epicenter);
	if (parent !== undefined && !parent.isDirectory())
		throw new Error(
			`'${epicenter}' must be a directory, because every Git command looks for hooks inside it; remove it, and it is made again`,
		);
	await mkdir(noHooks, { recursive: true });
	const found = await kind(noHooks);
	if (!found?.isDirectory() || (await readdir(noHooks)).length > 0)
		throw new Error(
			`'${noHooks}' must be an empty directory, because every Git command looks for hooks there; remove it, and it is made again empty`,
		);
	return noHooks;
}

/**
 * Run the system `git` in `root` under the desktop shell's controls
 * (`execute` and `validate_authorization` in `page_git.rs`): no hook and no
 * fsmonitor, whatever the repository configures, the environment above, and
 * a credential sent only to an `https` URL, never in the clear. The shell also refuses
 * any command but the folder engine's own and checks `.git`'s layout before
 * each; those guard the shell from its pages, and this runner serves the
 * process that calls it.
 */
export function createGitRunner(root: string): GitRun {
	return async (args, options = {}) => {
		if (
			options.credential !== undefined &&
			!options.credential.url.startsWith('https://')
		)
			throw new Error(
				`a token is sent only to an https remote, and ${options.credential.url} is not one; connect it with its https URL, or leave the token out so Git uses your own sign-in`,
			);
		const noHooks = await noHooksDirectory(root);
		return new Promise((resolve, reject) => {
			const child = spawn(
				'git',
				[
					'-c',
					`core.hooksPath=${noHooks}`,
					'-c',
					'core.fsmonitor=false',
					...args,
				],
				{
					cwd: root,
					env: {
						...gitEnvironment(root),
						...options.env,
						...(options.credential &&
							credentialEnvironment(options.credential)),
					},
					stdio: ['pipe', 'pipe', 'pipe'],
					signal: options.signal,
				},
			);
			const stdout: Uint8Array[] = [];
			const stderr: Uint8Array[] = [];
			child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));
			child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));
			child.on('error', reject);
			child.on('close', (code) => {
				const out = Buffer.concat(stdout);
				const err = Buffer.concat(stderr).toString('utf8');
				if (code !== 0 && !options.allowFailure)
					reject(new GitCommandError(args, code, err));
				else resolve({ code, stdout: new Uint8Array(out), stderr: err });
			});
			child.stdin.on('error', () => {});
			if (options.input !== undefined) child.stdin.end(options.input);
			else child.stdin.end();
		});
	};
}

/** The system `git` in `root`, and `node:fs`. */
export function nodeGitHost(root: string): NativeGitHost {
	return { run: createGitRunner(root), files: nodeDirectoryPrimitives };
}
