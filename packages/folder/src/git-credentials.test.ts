/**
 * The runner sends a token as one `Authorization: Bearer` header to exactly
 * its remote, through Git configuration in the environment, never in the
 * arguments; it follows no redirect for that remote and sends a token only
 * to an `https` remote.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { credentialEnvironment, runGit } from './git/native-host.js';
import { GIT_ENV, git, scratch } from './git.test-support.js';

const TOKEN = 's3cret.token-value';

const originalEnv = { ...process.env };
beforeAll(() => {
	// No person's credential helper answers for these servers.
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

/** `runGit` in `root`, as the CLI's sync verbs run it. */
const createGitRunner =
	(root: string) =>
	(args: string[], options: Parameters<typeof runGit>[1] = {}) =>
		runGit(args, { cwd: root, ...options });

test('a token becomes one URL-scoped Bearer header in Git configuration, and nothing else', () => {
	const remote = 'https://api.example.test/git/todos.git';
	expect(credentialEnvironment({ url: remote, token: TOKEN })).toEqual({
		GIT_CONFIG_COUNT: '4',
		GIT_CONFIG_KEY_0: `http.${remote}.extraHeader`,
		GIT_CONFIG_VALUE_0: `Authorization: Bearer ${TOKEN}`,
		GIT_CONFIG_KEY_1: 'http.followRedirects',
		GIT_CONFIG_VALUE_1: 'false',
		GIT_CONFIG_KEY_2: `http.${remote}.followRedirects`,
		GIT_CONFIG_VALUE_2: 'false',
		GIT_CONFIG_KEY_3: 'credential.helper',
		GIT_CONFIG_VALUE_3: '',
	});
	for (const token of ['', 'abc def', 'abc\r\nX-Other: 1', 'caf\u00e9'])
		expect(() => credentialEnvironment({ url: remote, token })).toThrow();
});

test('a credential refuses redirects even where the repository allows them for that remote', async () => {
	const root = await scratch('folder-credentials-redirects-');
	const remote = 'https://api.example.test/git/todos.git';
	try {
		await git(root, 'init', '--quiet');
		await git(root, 'config', `http.${remote}.followRedirects`, 'true');
		const run = createGitRunner(root);
		const ask = ['config', '--get-urlmatch', 'http.followRedirects', remote];
		expect(new TextDecoder().decode((await run(ask)).stdout).trim()).toBe(
			'true',
		);
		const scoped = await run(ask, {
			credential: { url: remote, token: TOKEN },
		});
		expect(new TextDecoder().decode(scoped.stdout).trim()).toBe('false');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a credential is never sent to a remote that is not https', async () => {
	const root = await scratch('folder-credentials-plain-');
	try {
		await git(root, 'init', '--quiet');
		const run = createGitRunner(root);
		for (const url of [
			'http://127.0.0.1:9/remote.git',
			'http://git.example.test/remote.git',
			'ssh://git@git.example.test/remote.git',
			'git@git.example.test:remote.git',
		])
			await expect(
				run(['ls-remote', url], {
					credential: { url, token: TOKEN },
				}),
			).rejects.toThrow('a token is sent only to an https remote');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
