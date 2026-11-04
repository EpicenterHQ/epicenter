/**
 * The system `git` that `epicenter status` and the merge driver still run:
 * `runGit` from `@epicenter/folder/bun` (the `git` that `locateGit` finds,
 * no hooks, no fsmonitor, no `ext` or `fd` transports), with text output and
 * a working directory. Sync, init, clone, and connect run in the sync core
 * and start no `git`.
 */

import { runGit } from '@epicenter/folder/bun';

export type Ran = {
	code: number;
	stdout: string;
	stderr: string;
};

/** Run `git` in `cwd`, never throwing on its exit code. */
export async function git(
	cwd: string,
	args: readonly string[],
	options: { readonly env?: Readonly<Record<string, string>> } = {},
): Promise<Ran> {
	const ran = await runGit(args, { cwd, allowFailure: true, ...options });
	return {
		code: ran.code ?? 1,
		stdout: new TextDecoder().decode(ran.stdout),
		stderr: ran.stderr,
	};
}
