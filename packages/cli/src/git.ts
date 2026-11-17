import { realpath } from 'node:fs/promises';

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
 * - `GIT_TERMINAL_PROMPT=0`: a fetch never waits on a credential
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
	{ input }: { input?: string } = {},
) {
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
	return { stdout: stdout.trimEnd(), stderr: stderr.trim(), code };
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

/** Accept a root only when Git's top is that folder, including through a symlink. */
export async function isRepositoryTop(root: string) {
	const top = await git(root, ['rev-parse', '--show-toplevel']);
	return (
		top.code === 0 && (await realpath(top.stdout)) === (await realpath(root))
	);
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
