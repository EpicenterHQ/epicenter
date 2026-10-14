/**
 * The native Git backend's host in Bun and Node: the system `git` and
 * `node:fs`.
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
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
 *
 * Trace variables are removed too, and Trace2 is switched off, because a
 * trace records Git's configuration and requests, credential headers
 * included, to stderr or to any file it names. The desktop shell's runner
 * removes the same (`page_git.rs`).
 */
const REPOSITORY_ENV =
	/^GIT_(DIR|WORK_TREE|IMPLICIT_WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|GRAFT_FILE|SHALLOW_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|TRACE\w*|CURL_VERBOSE)$/;

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

export function createGitRunner(root: string): GitRun {
	return (args, options = {}) =>
		new Promise((resolve, reject) => {
			const child = spawn('git', [...args], {
				cwd: root,
				env: {
					...gitEnvironment(root),
					...options.env,
					...(options.credential && credentialEnvironment(options.credential)),
				},
				stdio: ['pipe', 'pipe', 'pipe'],
				signal: options.signal,
			});
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
}

/** The system `git` in `root`, and `node:fs`. */
export function nodeGitHost(root: string): NativeGitHost {
	return { run: createGitRunner(root), files: nodeDirectoryPrimitives };
}
