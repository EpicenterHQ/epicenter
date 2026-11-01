/** Repository states in which neither init nor sync may change files. */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { git, must } from './git.ts';

export async function repositoryProblem(root: string): Promise<string | null> {
	for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
		const path = (await must(root, ['rev-parse', '--git-path', name])).trim();
		if (existsSync(resolve(root, path)))
			return `${name} exists: finish or abort it before running Epicenter.`;
	}
	for (const name of ['rebase-merge', 'rebase-apply']) {
		const path = (await must(root, ['rev-parse', '--git-path', name])).trim();
		if (existsSync(resolve(root, path)))
			return 'a rebase is in progress. Finish or abort it before running Epicenter.';
	}
	const unmerged = await must(root, ['ls-files', '-u']);
	if (unmerged.trim() !== '')
		return 'unmerged entries exist. Resolve them before running Epicenter.';
	const branch = await git(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
	if (branch.code !== 0)
		return 'HEAD is detached. Check out main before running Epicenter.';
	if (branch.stdout.trim() !== 'main')
		return `this repository is on ${branch.stdout.trim()}, but Epicenter syncs only main. Check out main before running Epicenter.`;
	return null;
}
