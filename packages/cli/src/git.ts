import { spawn } from 'node:child_process';

/**
 * The one way `epicenter` runs Git (ADR-0850). It runs Git's porcelain from
 * a repository folder and passes on Git's messages; it keeps no Git objects,
 * index, lock, or status file of its own. Paths stay
 * arguments, never shell text, and every call shares one environment:
 *
 * - `GIT_LITERAL_PATHSPECS=1`: a path is that path, never a pattern.
 * - `GIT_OPTIONAL_LOCKS=0`: a read such as `git status` never takes the index
 *   lock to refresh it, so a person's `git commit` is not refused because
 *   `epicenter` happened to be looking. Writes take their locks regardless.
 * - `GIT_TERMINAL_PROMPT=0`: a push never waits on a credential
 *   prompt no one can see; it fails, and Git's message says why.
 */
const ENVIRONMENT = {
	GIT_LITERAL_PATHSPECS: '1',
	GIT_OPTIONAL_LOCKS: '0',
	GIT_TERMINAL_PROMPT: '0',
};

// From `git rev-parse --local-env-vars`, excluding caller config injection.
const REPOSITORY_ENVIRONMENT = [
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_CONFIG',
	'GIT_OBJECT_DIRECTORY',
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_IMPLICIT_WORK_TREE',
	'GIT_GRAFT_FILE',
	'GIT_INDEX_FILE',
	'GIT_NO_REPLACE_OBJECTS',
	'GIT_REPLACE_REF_BASE',
	'GIT_PREFIX',
	'GIT_SHALLOW_FILE',
	'GIT_COMMON_DIR',
];

function gitEnvironment() {
	const env: NodeJS.ProcessEnv = { ...process.env, ...ENVIRONMENT };
	for (const name of REPOSITORY_ENVIRONMENT) delete env[name];
	return env;
}

/** Run Git with literal path arguments and optional stdin; nonzero exits are data. */
export async function git(
	folder: string,
	args: string[],
	{ input, timeoutMs }: { input?: string; timeoutMs?: number } = {},
) {
	if (timeoutMs !== undefined)
		return boundedGit(folder, args, timeoutMs, input);

	const child = Bun.spawn(['git', '-C', folder, ...args], {
		env: gitEnvironment(),
		stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return {
		stdout: stdout.trimEnd(),
		stderr: stderr.trim(),
		code,
		timedOut: false,
	};
}

/** Git's own message for a failed command: its stderr, else its stdout. */
export function gitMessage(
	args: string[],
	result: { stdout: string; stderr: string },
) {
	return result.stderr || result.stdout.trim() || `git ${args[0]} failed`;
}

/** Run Git and return its stdout, throwing with Git's message when it fails. */
export async function checkedGit(folder: string, args: string[]) {
	const result = await git(folder, args);
	if (result.code !== 0) throw new Error(gitMessage(args, result));
	return result.stdout;
}

/**
 * The repository's backup: `null` when it has no `origin` remote; otherwise the
 * branch checked out (empty on a detached HEAD) and how many commits it is
 * ahead of its `origin` tracking ref, absent when there is no tracking ref
 * yet. It reads only what is local; nothing here fetches.
 */
export async function originOf(
	folder: string,
): Promise<{ branch: string; ahead?: number } | null> {
	if ((await git(folder, ['remote', 'get-url', 'origin'])).code !== 0)
		return null;
	const branch = (await git(folder, ['symbolic-ref', '-q', '--short', 'HEAD']))
		.stdout;
	if (branch === '') return { branch };
	const counted = await git(folder, [
		'rev-list',
		'--count',
		`refs/remotes/origin/${branch}..HEAD`,
	]);
	return counted.code === 0
		? { branch, ahead: Number(counted.stdout) }
		: { branch };
}

/** A detached POSIX group lets the push deadline kill SSH, hooks, and remote helpers too. */
async function boundedGit(
	folder: string,
	args: string[],
	timeoutMs: number,
	input?: string,
) {
	const child = spawn('git', ['-C', folder, ...args], {
		env: gitEnvironment(),
		detached: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.stdin.end(input);
	let stdout = '';
	let stderr = '';
	let timedOut = false;
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	const completion = Promise.withResolvers<number>();
	let exited = false;
	let exitCode = 1;
	let grace: ReturnType<typeof setTimeout> | undefined;
	const finishAfterExit = () => {
		if (timedOut && exited && !grace)
			grace = setTimeout(() => completion.resolve(exitCode), 2_000);
	};
	child.once('error', completion.reject);
	child.once('close', (code) => completion.resolve(code ?? 1));
	child.once('exit', (code) => {
		exited = true;
		exitCode = code ?? 1;
		finishAfterExit();
	});
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.pid) {
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
					child.kill('SIGKILL');
			}
		}
		// Git may already have exited while an escaped descendant holds its pipes.
		finishAfterExit();
	}, timeoutMs);
	try {
		// Normally collect all output through close. After a deadline, escaped
		// descendants get only a short pipe grace once Git itself has exited.
		const code = await completion.promise;
		return { stdout: stdout.trimEnd(), stderr: stderr.trim(), code, timedOut };
	} finally {
		clearTimeout(timer);
		clearTimeout(grace);
		if (timedOut) {
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
		}
	}
}
