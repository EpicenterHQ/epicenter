/**
 * The `git` the sync verbs run: `runGit` from `@epicenter/folder/bun` (the
 * system `git` that `locateGit` finds, no hooks, no fsmonitor, no `ext` or
 * `fd` transports, and an `Authorization` header sent only to its `https`
 * remote), with text output and a working directory.
 *
 * Hooks never run here, so Git LFS's `pre-push` hook does not either: sync
 * runs `git lfs push` itself before it pushes. The clean and smudge filters
 * are configuration, not hooks, so `git add` and checkouts still store and
 * restore LFS pointers.
 */

import { runGit } from '@epicenter/folder/bun';

export type Ran = {
	code: number;
	stdout: string;
	stderr: string;
	/** Stdout as Git wrote it, for a blob that may not be text. */
	bytes: Uint8Array;
};

/** An `Authorization` header for exactly one remote URL. */
export type RemoteCredential = {
	readonly url: string;
	readonly authorization: string;
};

export type GitOptions = {
	readonly env?: Readonly<Record<string, string>>;
	readonly input?: string | Uint8Array;
	readonly credential?: RemoteCredential;
};

/** Run `git` in `cwd`, never throwing on its exit code. */
export async function git(
	cwd: string | undefined,
	args: readonly string[],
	options: GitOptions = {},
): Promise<Ran> {
	const ran = await runGit(args, { cwd, allowFailure: true, ...options });
	return {
		code: ran.code ?? 1,
		stdout: new TextDecoder().decode(ran.stdout),
		bytes: ran.stdout,
		stderr: ran.stderr,
	};
}

/** Run `git` in `cwd` and return its stdout, throwing with its stderr when it fails. */
export async function must(
	cwd: string | undefined,
	args: readonly string[],
	options: GitOptions = {},
): Promise<string> {
	const ran = await git(cwd, args, options);
	if (ran.code !== 0)
		throw new Error(
			`git ${args.join(' ')} failed (${ran.code}): ${ran.stderr.trim()}`,
		);
	return ran.stdout;
}

/** A configuration value in `scope`, or null when unset. */
export async function config(
	cwd: string | undefined,
	key: string,
	scope: '--local' | '--global' = '--local',
): Promise<string | null> {
	const ran = await git(cwd, ['config', scope, '--get', key]);
	return ran.code === 0 ? ran.stdout.trim() : null;
}

/** Every value of a multi-valued key in `scope`, empty ones included. */
export async function configAll(
	cwd: string | undefined,
	key: string,
	scope: '--local' | '--global' = '--local',
): Promise<string[]> {
	const ran = await git(cwd, ['config', scope, '--null', '--get-all', key]);
	return ran.code === 0 ? ran.stdout.split('\0').slice(0, -1) : [];
}
