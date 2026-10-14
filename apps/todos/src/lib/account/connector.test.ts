/**
 * Connector Tests
 *
 * Drives the GitHub connector client and the Git relay transport over a
 * recording stand-in for `Account.fetch`. No network.
 *
 * Key behaviors:
 * - Every call goes through the Account's own fetch, to the connector on the
 *   Account's server, without cookies; no credential is added here
 * - The relay rewrites only smart-HTTP requests for a canonical GitHub
 *   clone URL to that repository's relay path, forwards only the headers the
 *   connector admits, and refuses any other URL before sending
 * - The relay asks for the account at each request; with none signed in it
 *   sends nothing and says to sign in
 * - A connector refusal comes back with its status and a reason phrase a
 *   person can read; an Epicenter 401 says to sign in again
 * - Repositories are validated, and only a canonical clone URL names one
 * - The PKCE verifier and state are 43 base64url characters, and the
 *   challenge is the S256 of the verifier
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type ConnectorAccount,
	challengeOf,
	createConnector,
	githubRelay,
	githubRepository,
	randomSecret,
} from './connector.js';

const API = 'https://api.epicenter.test';
const CONNECTOR = `${API}/api/git/github`;
const REMOTE = 'https://github.com/alice/todos.git';
const RELAY = `${CONNECTOR}/repos/alice/todos.git`;

type Sent = { url: string; init: RequestInit | undefined };

/** An Account whose fetch records each request and answers with `reply`. */
function account(reply: (sent: Sent) => Response | Promise<Response>) {
	const sent: Sent[] = [];
	const value: ConnectorAccount = {
		authorityId: API,
		principalId: 'alice' as ConnectorAccount['principalId'],
		baseURL: `${API}/auth`,
		fetch: async (input, init) => {
			const entry = { url: String(input), init };
			sent.push(entry);
			return reply(entry);
		},
	};
	return { account: value, sent };
}

const refusal = (status: number, code: string, extra: object = {}) =>
	Response.json(
		{ error: code, message: 'server words', ...extra },
		{ status, headers: { 'X-Epicenter-Git-Error': code } },
	);

describe('githubRelay', () => {
	test('rewrites a canonical smart-HTTP URL to the relay path of its repository and forwards admitted headers only', async () => {
		const { account: alice, sent } = account(
			() =>
				new Response('advertisement', {
					status: 200,
					headers: {
						'content-type': 'application/x-git-upload-pack-advertisement',
					},
				}),
		);
		const transport = githubRelay(() => alice);
		const response = await transport(
			`${REMOTE}/info/refs?service=git-upload-pack`,
			{
				method: 'GET',
				headers: {
					accept: 'application/x-git-upload-pack-advertisement',
					'git-protocol': 'version=2',
					'user-agent': 'git/isomorphic-git',
					authorization: 'Basic c2VjcmV0',
				},
			},
		);
		expect(await response.text()).toBe('advertisement');
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe(`${RELAY}/info/refs?service=git-upload-pack`);
		const headers = new Headers(sent[0]?.init?.headers);
		expect([...headers.keys()].sort()).toEqual(['accept', 'git-protocol']);
		expect(sent[0]?.init).toMatchObject({
			method: 'GET',
			credentials: 'omit',
			redirect: 'manual',
			cache: 'no-store',
		});
	});

	test('sends a pack request body to the relay path for its service', async () => {
		const { account: alice, sent } = account(() => new Response('result'));
		const body = new Uint8Array([1, 2, 3]);
		await githubRelay(() => alice)(`${REMOTE}/git-receive-pack`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-git-receive-pack-request' },
			body,
		});
		expect(sent[0]?.url).toBe(`${RELAY}/git-receive-pack`);
		expect(sent[0]?.init?.body).toBe(body);
	});

	test('refuses any other URL before sending', async () => {
		const { account: alice, sent } = account(() => new Response('never'));
		const transport = githubRelay(() => alice);
		for (const url of [
			'https://token@github.com/alice/todos.git/info/refs?service=git-upload-pack',
			'https://github.com/-alice/todos.git/info/refs?service=git-upload-pack',
			'https://example.com/alice/todos.git/info/refs?service=git-upload-pack',
			`${REMOTE}/objects/info/packs`,
			`${REMOTE}/info/refs?service=git-upload-pack&x=1`,
			`${API}/api/session`,
		])
			await expect(transport(url, { method: 'GET' })).rejects.toThrow(
				'only to a GitHub repository',
			);
		expect(sent).toEqual([]);
	});

	test('another repository is its own relay path', async () => {
		const { account: alice, sent } = account(() => new Response('ok'));
		await githubRelay(() => alice)(
			'https://github.com/acme/notes.git/info/refs?service=git-upload-pack',
			{ method: 'GET' },
		);
		expect(sent[0]?.url).toBe(
			`${CONNECTOR}/repos/acme/notes.git/info/refs?service=git-upload-pack`,
		);
	});

	test('with nobody signed in it sends nothing and says to sign in', async () => {
		await expect(
			githubRelay(() => undefined)(
				`${REMOTE}/info/refs?service=git-upload-pack`,
				{ method: 'GET' },
			),
		).rejects.toThrow('Sign in to Epicenter');
	});

	test('a connector refusal keeps its status and says what to do', async () => {
		const { account: alice } = account(() =>
			refusal(403, 'github_authorization_required'),
		);
		const response = await githubRelay(() => alice)(
			`${REMOTE}/info/refs?service=git-receive-pack`,
			{ method: 'GET' },
		);
		expect(response.status).toBe(403);
		expect(response.statusText).toContain('Connect GitHub again');
	});

	test('an Epicenter 401 says to sign in again', async () => {
		const { account: alice } = account(
			() => new Response(null, { status: 401 }),
		);
		const response = await githubRelay(() => alice)(
			`${REMOTE}/info/refs?service=git-upload-pack`,
			{ method: 'GET' },
		);
		expect(response.status).toBe(401);
		expect(response.statusText).toContain('Sign in again');
	});

	test('a retired account abort says to sign in again', async () => {
		const { account: alice } = account(() => {
			throw new DOMException('Session retired', 'AbortError');
		});
		await expect(
			githubRelay(() => alice)(`${REMOTE}/info/refs?service=git-upload-pack`, {
				method: 'GET',
			}),
		).rejects.toThrow('Sign in again');
	});
});

describe('createConnector', () => {
	test('a refusal carries its code and install link', async () => {
		const { account: alice } = account(() =>
			refusal(403, 'repository_unavailable', {
				installUrl:
					'https://github.com/apps/epicenter-folder-sync/installations/new',
			}),
		);
		const error = expectErr(await createConnector(alice).repositories());
		expect(error).toMatchObject({
			name: 'Refused',
			code: 'repository_unavailable',
			installUrl:
				'https://github.com/apps/epicenter-folder-sync/installations/new',
		});
	});

	test("a thrown AccountUnavailable is the session's refusal", async () => {
		const { account: alice } = account(() => {
			throw Object.assign(new Error('paused'), { name: 'AccountUnavailable' });
		});
		expect(expectErr(await createConnector(alice).repositories()).name).toBe(
			'Session',
		);
	});
});

test('a canonical GitHub clone URL names its repository, and nothing else does', () => {
	expect(githubRepository(REMOTE)).toEqual({ owner: 'alice', name: 'todos' });
	for (const url of [
		'https://github.com/alice/todos',
		'https://github.com/alice/todos.git/',
		'https://token@github.com/alice/todos.git',
		'http://github.com/alice/todos.git',
		'https://github.com:443/alice/todos.git',
		'https://github.com/alice/todos.git?x=1',
		'https://github.com/a/b/c.git',
		'https://github.com/-alice/todos.git',
		'https://github.com/alice/...git',
		'git@github.com:alice/todos.git',
	])
		expect(githubRepository(url)).toBeUndefined();
});

test('state and verifier are 43 base64url characters, and the challenge is their S256', async () => {
	const verifier = randomSecret();
	expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(randomSecret()).not.toBe(verifier);
	const challenge = await challengeOf(verifier);
	expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(challenge).toBe(
		createHash('sha256').update(verifier).digest('base64url'),
	);
});
