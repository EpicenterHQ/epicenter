/** Attach an initialized folder to an ordinary Git origin. Sync owns transfers. */

import { join, resolve } from 'node:path';
import { holdingFileLock } from '../file-lock.ts';
import { config, configAll, git, must, originPushUrl } from './git.ts';
import { Refused } from './setup.ts';
import { folderStatus } from './status.ts';

export async function connect(input: string, url: string) {
	const status = await folderStatus(input);
	if (status === null || !status.adopted || !status.registered)
		throw new Refused(
			`${input} is not registered for sync. Run epicenter init ${input} first.`,
		);
	const common = resolve(
		status.repository,
		(await must(status.repository, ['rev-parse', '--git-common-dir'])).trim(),
	);
	return holdingFileLock(
		join(common, 'epicenter-sync.lock'),
		{
			waitMs: 120_000,
			held: `another sync of ${status.repository} is still running`,
		},
		() => attach(status.folder, status.repository, url),
	);
}

async function attach(folder: string, root: string, url: string) {
	const current = await config(root, 'remote.origin.url');
	if (current !== null) {
		if (current !== url)
			throw new Refused(
				`origin is already ${current}. Inspect it with git remote -v before changing it.`,
			);
		if ((await originPushUrl(root)) !== url)
			throw new Refused(
				'origin has a different effective push URL. Inspect it with git remote -v.',
			);
		const fetch = await configAll(root, 'remote.origin.fetch');
		if (fetch.length === 0) {
			await must(root, [
				'config',
				'--local',
				'--add',
				'remote.origin.fetch',
				'+refs/heads/*:refs/remotes/origin/*',
			]);
			return { folder, url, changed: true };
		}
		return { folder, url, changed: false };
	}

	await must(root, ['remote', 'add', 'origin', url]);
	if ((await originPushUrl(root)) !== url) {
		await must(root, ['remote', 'remove', 'origin']);
		throw new Refused(
			'origin would push to a different URL. Inspect your Git URL rewrite rules.',
		);
	}
	await git(root, ['update-ref', '-d', 'refs/epicenter/last-seen']);
	return { folder, url, changed: true };
}
