/**
 * `epicenter clone <namespace>/<name> | <url> | <path> [<dir>]`: `git clone`,
 * then `epicenter init`, which installs the LFS filters and the merge
 * driver, pulls the LFS bytes the clone checked out as pointers, and
 * registers the folder for sync.
 *
 * The clone skips LFS's smudge filter even where a person installed it
 * globally, so the bytes always come from init's one `git lfs pull`, with
 * the same credential as the clone. The committed `.gitattributes` is kept
 * as it is: its `filter=lfs` is what keeps bytes out of history.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { git } from './git.ts';
import { type Initialized, type InitOptions, init } from './setup.ts';

export type CloneSource = {
	/** What `git clone` is given: a URL or an absolute path. */
	readonly url: string;
	/** The repository's name, the default folder's name. */
	readonly name: string;
};

/** A local repository named by its path, as plain `git clone` takes one. */
export function localSource(source: string): CloneSource | undefined {
	if (
		!isAbsolute(source) &&
		!source.startsWith('./') &&
		!source.startsWith('../')
	)
		return undefined;
	const url = resolve(source);
	return { url, name: basename(url, '.git') };
}

export async function clone(
	{ url, name }: CloneSource,
	dir: string,
	options: Omit<InitOptions, 'allowEnclosing'>,
): Promise<Initialized> {
	if (name === '') throw new Error(`'${url}' names no repository`);
	const target = resolve(dir);
	if (existsSync(target) && readdirSync(target).length > 0)
		throw new Error(`${target} already exists and is not empty`);
	const cloned = await git(
		undefined,
		[
			'clone',
			'-q',
			'--no-recurse-submodules',
			'--template=',
			'--',
			url,
			target,
		],
		{
			env: { GIT_LFS_SKIP_SMUDGE: '1' },
			credential: await options.credential?.(url),
		},
	);
	if (cloned.code !== 0)
		throw new Error(cloned.stderr.trim() || `git clone exited ${cloned.code}`);
	return init(target, options);
}
