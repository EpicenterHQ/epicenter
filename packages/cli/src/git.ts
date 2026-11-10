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
	const child = Bun.spawn(['git', '-C', folder, ...args], {
		env: {
			...process.env,
			...ENVIRONMENT,
			...(magic ? { GIT_LITERAL_PATHSPECS: '0' } : {}),
		},
		stdin: 'ignore',
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
