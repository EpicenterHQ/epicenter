/**
 * The Bun and Node `git` runner applies the desktop shell's rule for every
 * command (`execute` in `page_git.rs`): a repository's hooks and fsmonitor
 * never run, whatever its configuration says.
 *
 * Key behaviors:
 * - A hook in `.git/hooks`, or in a directory the repository's
 *   `core.hooksPath` names, does not run on `update-ref` or `add`, though
 *   plain `git` runs it
 * - A configured `core.fsmonitor` program does not run on `status`
 * - A file planted in the empty hooks directory refuses every command
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GIT_ENV, git, scratch } from '../git-http.test-support.js';
import { createGitRunner } from './native-host.js';

const originalEnv = { ...process.env };
beforeAll(() => {
	// This machine's Git configuration must not change outcomes.
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

/** A shell script at `path` that records its name in `marker` when run. */
async function plant(path: string, marker: string) {
	await writeFile(path, `#!/bin/sh\necho "$(basename "$0")" >> '${marker}'\n`);
	await chmod(path, 0o755);
}

const ran = (marker: string) =>
	readFile(marker, 'utf8').then(
		(text) => text.split('\n').filter(Boolean),
		() => [],
	);

/** A repository with one commit, whose ID is returned. */
async function repository(root: string) {
	await git(root, 'init', '--quiet', '--initial-branch=main');
	await writeFile(join(root, 'a.md'), 'a\n');
	await git(root, 'add', '--all');
	await git(root, 'commit', '--quiet', '--no-verify', '-m', 'first');
	return git(root, 'rev-parse', 'HEAD');
}

for (const where of ['.git/hooks', 'core.hooksPath'] as const) {
	test.skipIf(process.platform === 'win32')(
		`a hook in ${where} runs for plain git and never for the runner`,
		async () => {
			const root = await scratch('native-host-hooks-');
			try {
				const head = await repository(root);
				const marker = `${root}.ran`;
				let hooks = join(root, '.git', 'hooks');
				if (where === 'core.hooksPath') {
					hooks = `${root}-planted`;
					await mkdir(hooks, { recursive: true });
					await git(root, 'config', 'core.hooksPath', hooks);
				}
				for (const hook of ['reference-transaction', 'post-index-change'])
					await plant(join(hooks, hook), marker);

				// The hooks are live: plain `git` runs both.
				await git(root, 'update-ref', 'refs/heads/plain', head);
				await writeFile(join(root, 'b.md'), 'b\n');
				await git(root, 'add', '--all');
				expect(new Set(await ran(marker))).toEqual(
					new Set(['reference-transaction', 'post-index-change']),
				);
				await rm(marker);

				const run = createGitRunner(root);
				await run(['update-ref', 'refs/heads/runner', head]);
				await writeFile(join(root, 'c.md'), 'c\n');
				await run(['add', '--all']);
				expect(await ran(marker)).toEqual([]);
				expect(await git(root, 'rev-parse', 'refs/heads/runner')).toBe(head);
				expect(await git(root, 'ls-files')).toContain('c.md');
			} finally {
				await rm(root, { recursive: true, force: true });
				await rm(`${root}.ran`, { force: true });
				await rm(`${root}-planted`, { recursive: true, force: true });
			}
		},
	);
}

test.skipIf(process.platform === 'win32')(
	'a configured fsmonitor runs for plain git status and never for the runner',
	async () => {
		const root = await scratch('native-host-fsmonitor-');
		const monitor = `${root}-fsmonitor`;
		const marker = `${root}.ran`;
		try {
			await repository(root);
			await plant(monitor, marker);
			await git(root, 'config', 'core.fsmonitor', monitor);

			await git(root, 'status', '--porcelain');
			expect(await ran(marker)).not.toEqual([]);
			await rm(marker);

			await createGitRunner(root)([
				'status',
				'--porcelain=v1',
				'-z',
				'--untracked-files=all',
			]);
			expect(await ran(marker)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(monitor, { force: true });
			await rm(marker, { force: true });
		}
	},
);

test('a file planted in the empty hooks directory refuses every command', async () => {
	const root = await scratch('native-host-planted-');
	try {
		await repository(root);
		const run = createGitRunner(root);
		await run(['status', '--porcelain=v1', '-z']);
		const noHooks = join(root, '.git', 'epicenter', 'no-hooks');
		await writeFile(join(noHooks, 'post-index-change'), '#!/bin/sh\n');
		await expect(run(['add', '--all'])).rejects.toThrow(
			'must be an empty directory',
		);
		await rm(join(noHooks, 'post-index-change'));
		await run(['add', '--all']);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
