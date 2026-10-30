/**
 * The runner sends a credential as one `Authorization` header to exactly its
 * remote, through Git configuration in the environment, never in the
 * arguments; it follows no redirect for that remote and sends a credential
 * only to an `https` remote.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
	basicAuthorization,
	credentialEnvironment,
	runGit,
} from './git/native-host.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';

const AUTHORIZATION = basicAuthorization({
	username: 'x-token',
	password: 's3cret',
});

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

test('a credential becomes URL-scoped Git configuration and nothing else', () => {
	const remote = 'https://api.example.test/git/todos.git';
	expect(
		credentialEnvironment({ url: remote, authorization: AUTHORIZATION }),
	).toEqual({
		GIT_CONFIG_COUNT: '4',
		GIT_CONFIG_KEY_0: `http.${remote}.extraHeader`,
		GIT_CONFIG_VALUE_0: `Authorization: ${AUTHORIZATION}`,
		GIT_CONFIG_KEY_1: 'http.followRedirects',
		GIT_CONFIG_VALUE_1: 'false',
		GIT_CONFIG_KEY_2: `http.${remote}.followRedirects`,
		GIT_CONFIG_VALUE_2: 'false',
		GIT_CONFIG_KEY_3: 'credential.helper',
		GIT_CONFIG_VALUE_3: '',
	});
	for (const authorization of [
		'',
		'Token abc',
		'Basic ',
		'Basic abc def',
		'Basic abc\r\nX-Other: 1',
	])
		expect(() =>
			credentialEnvironment({ url: remote, authorization }),
		).toThrow();
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
			credential: { url: remote, authorization: AUTHORIZATION },
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
					credential: { url, authorization: AUTHORIZATION },
				}),
			).rejects.toThrow('a token is sent only to an https remote');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
