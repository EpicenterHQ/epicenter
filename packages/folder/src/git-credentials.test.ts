/**
 * A folder asks its `credentials` for each push and fetch and sends what it
 * gets as one `Authorization` header to exactly that remote: in the browser
 * through isomorphic-git, and in Bun through the system `git`, whose
 * configuration comes from its environment, not its arguments.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { defineFolder, field, openFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
} from './browser-storage.test-support.js';
import { openFolder as openBunFolder } from './bun.js';
import {
	basicAuthorization,
	type GitCredentials,
	type HttpFetch,
} from './git/http.js';
import { credentialEnvironment } from './git/native-backend.js';
import { createGitRunner } from './git/native-host.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	gitHttpFetch,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';

const definition = defineFolder({
	kv: { language: field.string() },
	tables: {},
});
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

/** Smart HTTP over `root` that answers 401 without the expected header. */
async function guardedGit(root: string) {
	const serveGit = await gitHttpFetch(root);
	const seen: {
		url: string;
		authorization: string | null;
		init?: RequestInit;
	}[] = [];
	const serve = (request: Request, init?: RequestInit) => {
		const authorization = request.headers.get('authorization');
		seen.push({ url: request.url, authorization, init });
		if (authorization !== AUTHORIZATION)
			return new Response('Token required', { status: 401 });
		const url = new URL(request.url);
		return serveGit(
			new Request(`http://git.test${url.pathname}${url.search}`, request),
		);
	};
	return { serve, seen };
}

test('a browser folder sends the credential it is given to that remote alone, for every transfer', async () => {
	const root = await scratch('folder-credentials-browser-');
	const bare = await createBareRemote(root);
	const { serve, seen } = await guardedGit(root);
	const remote = 'https://git.example.test/remote.git';
	const httpFetch: HttpFetch = async (input, init) =>
		serve(new Request(input, init), init);
	const asked: string[] = [];
	const credentials: GitCredentials = async (url) => {
		asked.push(url);
		return { username: 'x-token', password: 's3cret' };
	};
	const folder = expectOk(
		await openFolder({
			id: 'com.example.credentials',
			definition,
			credentials,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				httpFetch,
				...browserStorage(createTestStorage()),
			},
		}),
	);
	try {
		expectOk(await folder.kv.set('language', 'Chinese'));
		expect(expectOk(await folder.sync.connect(remote)).kind).toBe('synced');
		expect(await git(bare, 'rev-parse', 'main')).toMatch(/^[0-9a-f]{40}$/);
		// Asked once per transfer, always with the exact remote.
		expect(asked.length).toBeGreaterThanOrEqual(2);
		expect(new Set(asked)).toEqual(new Set([remote]));
		expect(seen.length).toBeGreaterThan(0);
		for (const request of seen) {
			expect(request.authorization).toBe(AUTHORIZATION);
			expect(request.init?.credentials).toBe('omit');
			expect(request.init?.redirect).toBe('error');
		}
		// The credential is kept nowhere in the folder.
		expect(folder.git.snapshot.remote).toEqual({ url: remote, branch: 'main' });
	} finally {
		await folder.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('a browser folder without a credential is refused by a server that needs one', async () => {
	const root = await scratch('folder-credentials-refused-');
	await createBareRemote(root);
	const { serve, seen } = await guardedGit(root);
	const folder = expectOk(
		await openFolder({
			id: 'com.example.refused',
			definition,
			credentials: async () => undefined,
			browser: {
				httpFetch: async (input, init) => serve(new Request(input, init), init),
				...browserStorage(createTestStorage()),
			},
		}),
	);
	try {
		expectOk(await folder.kv.set('language', 'Chinese'));
		const connected = await folder.sync.connect(
			'https://git.example.test/remote.git',
		);
		expect(connected.error).not.toBeNull();
		expect(seen.every((request) => request.authorization === null)).toBe(true);
		expect(seen.every((request) => request.init?.redirect === 'follow')).toBe(
			true,
		);
	} finally {
		await folder.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('a Bun folder passes its credential to `git` through configuration, scoped to the remote', async () => {
	const root = await scratch('folder-credentials-bun-');
	const bare = await createBareRemote(root);
	const { serve, seen } = await guardedGit(root);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: (request) => serve(request),
	});
	const remote = `http://127.0.0.1:${server.port}/remote.git`;
	const directory = join(root, 'folder');
	await mkdir(directory);
	await initWithOrigin(directory, remote);
	const asked: string[] = [];
	const folder = expectOk(
		await openBunFolder({
			root: directory,
			definition,
			git: {
				author: { name: 'Test', email: 'test@example.test' },
				credentials: async (url) => {
					asked.push(url);
					return { username: 'x-token', password: 's3cret' };
				},
			},
		}),
	);
	try {
		expectOk(await folder.kv.set('language', 'Chinese'));
		expectOk(await folder.sync.run());
		expect(await git(bare, 'rev-parse', 'main')).toBe(
			await git(directory, 'rev-parse', 'main'),
		);
		expect(new Set(asked)).toEqual(new Set([remote]));
		expect(
			seen.some((request) => request.url.endsWith('/git-receive-pack')),
		).toBe(true);
		// Nothing reached the repository's configuration.
		expect(await git(directory, 'config', '--list', '--local')).not.toContain(
			's3cret',
		);
		// Inherited trace settings would print the header; the runner drops them.
		const traces = {
			GIT_TRACE: '1',
			GIT_TRACE_CURL: '1',
			GIT_CURL_VERBOSE: '1',
			GIT_TRACE_REDACT: '0',
			GIT_TRACE2_EVENT: '1',
			GIT_TRACE2_CONFIG_PARAMS: 'http.*.extraheader',
		};
		const saved = Object.fromEntries(
			Object.keys(traces).map((name) => [name, process.env[name]]),
		);
		Object.assign(process.env, traces);
		try {
			const listed = await createGitRunner(directory)(['ls-remote', remote], {
				allowFailure: true,
				credential: { url: remote, authorization: AUTHORIZATION },
			});
			expect(listed.code).toBe(0);
			expect(listed.stderr).not.toContain(AUTHORIZATION.slice('Basic '.length));
		} finally {
			for (const [name, value] of Object.entries(saved))
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
		}
	} finally {
		await folder.close();
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});

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
