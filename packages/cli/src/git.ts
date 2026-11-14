/**
 * The one way `epicenter` runs Git (ADR-0850). It runs Git's porcelain from
 * an app's folder and passes on Git's messages; it keeps no Git objects,
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

/**
 * Run `git -C folder ...args`; never throws for a non-zero exit. `magic`
 * lets a commit name each path with `:(literal)` or `:(top,literal)`
 * (`snapshot.ts`); every other call reads paths literally.
 */
export async function git(folder: string, args: string[], magic = false) {
	const child = spawnGit(['-C', folder, ...args], {
		...process.env,
		...ENVIRONMENT,
		...(magic ? { GIT_LITERAL_PATHSPECS: '0' } : {}),
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout: stdout.trimEnd(), stderr: stderr.trim(), code };
}

/** Said when there is no `git` to run. */
const GIT_MISSING =
	'git is not installed, or not on PATH. Install Git (on Ubuntu or Debian: sudo apt install git).';

/** Spawn `git ...args` with `env`, throwing `GIT_MISSING` when there is no `git`. */
function spawnGit(args: string[], env: Record<string, string | undefined>) {
	try {
		return Bun.spawn(['git', ...args], {
			env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			throw new Error(GIT_MISSING);
		throw error;
	}
}

/**
 * Why Git could not commit now, or `undefined` when it could: Git says who
 * commits from `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, then its configuration,
 * then a guess from the computer's name, which fails on a server whose name
 * has no domain. With `configOnly`, only Git's configuration counts, as for a
 * job that has none of the shell's variables and should not commit as a guess.
 */
export async function identityProblem({ configOnly }: { configOnly: boolean }) {
	const env: Record<string, string | undefined> = { ...process.env };
	if (configOnly)
		for (const name of [
			'GIT_AUTHOR_NAME',
			'GIT_AUTHOR_EMAIL',
			'GIT_COMMITTER_NAME',
			'GIT_COMMITTER_EMAIL',
			'EMAIL',
		])
			delete env[name];
	const child = spawnGit(
		[
			...(configOnly ? ['-c', 'user.useConfigOnly=true'] : []),
			'var',
			'GIT_AUTHOR_IDENT',
		],
		env,
	);
	if ((await child.exited) === 0) return undefined;
	return 'Git does not know who you are, so nothing could be committed. Set your name and email for Git:\n  git config --global user.name "Your Name"\n  git config --global user.email "you@example.com"';
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
 * The app's backup: `null` when it has no `origin` remote; otherwise the
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
