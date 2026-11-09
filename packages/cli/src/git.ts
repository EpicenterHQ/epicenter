/**
 * The one way `epicenter` runs Git (ADR-0850). It runs Git's porcelain from
 * an app's folder and passes on Git's messages; it keeps no Git objects,
 * index, or lock of its own. Paths stay arguments, never shell text, and
 * every call shares one environment:
 *
 * - `GIT_LITERAL_PATHSPECS=1`: a path is that path, never a pattern.
 * - `GIT_OPTIONAL_LOCKS=0`: a read such as `git status` never takes the index
 *   lock to refresh it, so a person's `git commit` is not refused because
 *   `epicenter` happened to be looking. Writes take their locks regardless.
 * - `GIT_TERMINAL_PROMPT=0`: a pull or push never waits on a credential
 *   prompt no one can see; it fails, and Git's message says why.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ENVIRONMENT = {
	GIT_LITERAL_PATHSPECS: '1',
	GIT_OPTIONAL_LOCKS: '0',
	GIT_TERMINAL_PROMPT: '0',
};

/** Run `git -C folder ...args`; never throws for a non-zero exit. */
export async function git(folder: string, args: string[]) {
	const child = Bun.spawn(['git', '-C', folder, ...args], {
		env: { ...process.env, ...ENVIRONMENT },
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

/** How long a command waits for someone else's hold on Git's index lock before giving up. */
const INDEX_LOCK_WAIT_MS = 2_000;

/**
 * `checkedGit`, retried while another Git process holds `index.lock`, so a
 * commit that meets an editor's or agent's `git add` waits its turn instead
 * of failing; after about 2 seconds it throws Git's message.
 */
async function gitWaitingForIndex(folder: string, args: string[]) {
	const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
	for (;;) {
		const result = await git(folder, args);
		if (result.code === 0) return result.stdout;
		if (!result.stderr.includes('index.lock') || Date.now() > deadline)
			throw new Error(gitMessage(args, result));
		await Bun.sleep(50);
	}
}

/** Thrown before staging when committing would store whole files that `.gitattributes` routes through LFS. */
const LFS_MISSING =
	'.gitattributes routes files through Git LFS, and this computer has no LFS filter, so Git would store them whole; run: git lfs install';

/**
 * Commit everything changed in `folder`, staged or not, and nothing outside
 * it (ADR-0850): `git add -A -- .`, then `git commit -m <message> -- .`.
 * `message` may be a function of how many files changed, as `sync` names
 * them. Returns that count; 0 means nothing changed and nothing was
 * committed. Throws Git's message when `folder` is in no repository, and
 * throws before staging when its `.gitattributes` mentions `filter=lfs` and
 * `git config filter.lfs.process` is empty (ADR-0856).
 */
export async function commitFolder(
	folder: string,
	message: string | ((files: number) => string),
): Promise<number> {
	const attributes = await readFile(
		join(folder, '.gitattributes'),
		'utf8',
	).catch(() => '');
	if (
		attributes.includes('filter=lfs') &&
		(await git(folder, ['config', '--get', 'filter.lfs.process'])).stdout === ''
	)
		throw new Error(LFS_MISSING);
	await gitWaitingForIndex(folder, ['add', '-A', '--', '.']);
	const staged = await checkedGit(folder, [
		'diff',
		'--cached',
		'--name-only',
		'--',
		'.',
	]);
	const files = staged === '' ? 0 : staged.split('\n').length;
	if (files === 0) return 0;
	await gitWaitingForIndex(folder, [
		'commit',
		'-q',
		'-m',
		typeof message === 'string' ? message : message(files),
		'--',
		'.',
	]);
	return files;
}
