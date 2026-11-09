/**
 * The one way `epicenter` runs Git on an app's repository (ADR-0850). Paths
 * stay arguments, never shell text, and every call shares one environment:
 *
 * - `GIT_LITERAL_PATHSPECS=1`: a path an action wrote, such as `[d].md`, is
 *   that path, never a pattern matching others.
 * - `GIT_OPTIONAL_LOCKS=0`: a read such as `git status` never takes the index
 *   lock to refresh it, so a person's `git commit` is not refused because
 *   `epicenter` happened to be looking. Writes take their locks regardless.
 * - `GIT_TERMINAL_PROMPT=0`: a push never waits on a credential prompt no one
 *   can see; it fails, and the report says so.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

type Options = {
	/** Bytes or text fed to Git's stdin. */
	stdin?: string | Uint8Array;
	/** Extra environment, such as `GIT_INDEX_FILE`. */
	env?: Record<string, string>;
};

const ENVIRONMENT = {
	GIT_LITERAL_PATHSPECS: '1',
	GIT_OPTIONAL_LOCKS: '0',
	GIT_TERMINAL_PROMPT: '0',
};

/** Run `git -C folder ...args`; never throws for a non-zero exit. */
export async function git(
	folder: string,
	args: string[],
	{ stdin, env }: Options = {},
) {
	const child = Bun.spawn(['git', '-C', folder, ...args], {
		env: { ...process.env, ...ENVIRONMENT, ...env },
		stdin:
			typeof stdin === 'string'
				? new TextEncoder().encode(stdin)
				: (stdin ?? 'ignore'),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).arrayBuffer(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout: Buffer.from(stdout), stderr: stderr.trim(), code };
}

/**
 * Run Git and return its stdout as text without the final newline, throwing
 * with its stderr when it fails. Leading whitespace is kept: in porcelain
 * output it is a status column.
 */
export async function checkedGit(
	folder: string,
	args: string[],
	options?: Options,
) {
	const result = await git(folder, args, options);
	if (result.code !== 0)
		throw new Error(
			result.stderr ||
				result.stdout.toString().trim() ||
				`git ${args[0]} failed`,
		);
	return result.stdout.toString().trimEnd();
}

/** The commit `rev` names, or `null` when it names none (an unborn branch, no merge in progress). */
export async function revParse(folder: string, rev: string) {
	const found = await git(folder, ['rev-parse', '-q', '--verify', rev]);
	return found.code === 0 ? found.stdout.toString().trim() : null;
}

/** Where Git keeps `name` for this repository, as an absolute path. */
export async function gitPath(folder: string, name: string) {
	const path = await checkedGit(folder, ['rev-parse', '--git-path', name]);
	return isAbsolute(path) ? path : join(folder, path);
}

/** Whether `folder`, a real path, is the top level of its own Git repository. */
export async function isRepositoryTop(folder: string) {
	const top = await git(folder, ['rev-parse', '--show-toplevel']);
	return (
		top.code === 0 && (await realpath(top.stdout.toString().trim())) === folder
	);
}
