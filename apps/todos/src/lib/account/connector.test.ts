/**
 * Connector Tests
 *
 * Drives the GitHub connector client and the Git relay transport over a
 * recording stand-in for `Account.fetch`. No network.
 *
 * Key behaviors:
 * - Every call goes through the Account's own fetch, to the connector on the
 *   Account's server, without cookies; no credential is added here
 * - The relay rewrites only smart-HTTP requests for the pairing's canonical
 *   URL to the pinned revision, forwards only the headers the connector
 *   admits, and refuses any other URL before sending
 * - A connector refusal comes back with its status and a reason phrase a
 *   person can read; an Epicenter 401 says to sign in again
 * - Pairings and repositories are validated; a pairing whose remote is not a
 *   canonical GitHub clone URL is refused as malformed
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
	type Pairing,
	randomSecret,
	relayFetch,
} from './connector.js';

const API = 'https://api.epicenter.test';
const CONNECTOR = `${API}/api/git/github`;
const REVISION = 'AbCdEfGhIjKlMnOpQrStUv';
const pairing: Pairing = {
	folderId: 'so.epicenter.todos',
	revision: REVISION,
	status: 'ready',
	repository: { id: 9001, installationId: 7001, fullName: 'alice/todos' },
	remote: { url: 'https://github.com/alice/todos.git', branch: 'main' },
};

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

describe('relayFetch', () => {
	test('rewrites the canonical smart-HTTP URL to the pinned revision and forwards admitted headers only', async () => {
		const { account: alice, sent } = account(
			() =>
				new Response('advertisement', {
					status: 200,
					headers: {
						'content-type': 'application/x-git-upload-pack-advertisement',
					},
				}),
		);
		const transport = relayFetch(alice, pairing);
		const response = await transport(
			`${pairing.remote.url}/info/refs?service=git-upload-pack`,
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
		expect(sent[0]?.url).toBe(
			`${CONNECTOR}/git/so.epicenter.todos/${REVISION}/info/refs?service=git-upload-pack`,
		);
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
		await relayFetch(alice, pairing)(`${pairing.remote.url}/git-receive-pack`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-git-receive-pack-request' },
			body,
		});
		expect(sent[0]?.url).toBe(
			`${CONNECTOR}/git/so.epicenter.todos/${REVISION}/git-receive-pack`,
		);
		expect(sent[0]?.init?.body).toBe(body);
	});

	test('refuses any other URL before sending', async () => {
		const { account: alice, sent } = account(() => new Response('never'));
		const transport = relayFetch(alice, pairing);
		for (const url of [
			'https://github.com/mallory/todos.git/info/refs?service=git-upload-pack',
			`${pairing.remote.url}/objects/info/packs`,
			`${pairing.remote.url}/info/refs?service=git-upload-pack&x=1`,
			`${API}/api/session`,
		])
			await expect(transport(url, { method: 'GET' })).rejects.toThrow(
				'only to the repository it is connected to',
			);
		expect(sent).toEqual([]);
	});

	test('a connector refusal keeps its status and says what to do', async () => {
		const { account: alice } = account(() =>
			refusal(403, 'github_authorization_required'),
		);
		const response = await relayFetch(alice, pairing)(
			`${pairing.remote.url}/info/refs?service=git-receive-pack`,
			{ method: 'GET' },
		);
		expect(response.status).toBe(403);
		expect(response.statusText).toContain('Connect GitHub again');
	});

	test('an Epicenter 401 says to sign in again', async () => {
		const { account: alice } = account(
			() => new Response(null, { status: 401 }),
		);
		const response = await relayFetch(alice, pairing)(
			`${pairing.remote.url}/info/refs?service=git-upload-pack`,
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
			relayFetch(alice, pairing)(
				`${pairing.remote.url}/info/refs?service=git-upload-pack`,
				{ method: 'GET' },
			),
		).rejects.toThrow('Sign in again');
	});
});

describe('createConnector', () => {
	test('reads the folder pairing from the list and validates it', async () => {
		const { account: alice, sent } = account(() =>
			Response.json({
				pairings: [
					{ ...pairing, folderId: 'other.folder' },
					{
						folderId: pairing.folderId,
						revision: REVISION,
						status: 'github_authorization_required',
						repository: pairing.repository,
						remote: pairing.remote,
					},
				],
			}),
		);
		const found = expectOk(
			await createConnector(alice).pairing('so.epicenter.todos'),
		);
		expect(found).toEqual({
			...pairing,
			status: 'github_authorization_required',
		});
		expect(sent[0]?.url).toBe(`${CONNECTOR}/pairings`);
		expect(sent[0]?.init).toMatchObject({ method: 'GET', credentials: 'omit' });
	});

	test('a folder with no pairing reads as undefined', async () => {
		const { account: alice } = account(() => Response.json({ pairings: [] }));
		expect(
			expectOk(await createConnector(alice).pairing('so.epicenter.todos')),
		).toBeUndefined();
	});

	test('a pairing whose remote is not a canonical GitHub clone URL is malformed', async () => {
		const { account: alice } = account(() =>
			Response.json({
				pairings: [
					{
						...pairing,
						remote: {
							url: 'https://token@github.com/alice/todos.git',
							branch: 'main',
						},
					},
				],
			}),
		);
		expect(
			expectErr(await createConnector(alice).pairing('so.epicenter.todos'))
				.name,
		).toBe('Malformed');
	});

	test('pairing sends numeric ids and never asks to replace', async () => {
		const { account: alice, sent } = account(() => Response.json({ pairing }));
		expectOk(
			await createConnector(alice).pair('so.epicenter.todos', {
				id: 9001,
				installationId: 7001,
			}),
		);
		expect(sent[0]?.url).toBe(`${CONNECTOR}/pairings/so.epicenter.todos`);
		expect(sent[0]?.init?.method).toBe('PUT');
		expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({
			repositoryId: 9001,
			installationId: 7001,
		});
	});

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
