/**
 * GitHub Connect Tests
 *
 * The pending authorization kept across the redirect, over an in-memory
 * session storage and a recording stand-in for `Account.fetch`. No network.
 *
 * Key behaviors:
 * - Starting sends the browser state and S256 challenge with the exact
 *   `/sync` callback, and keeps the verifier in this tab only
 * - Returning completes once, with the kept verifier and callback; a replay,
 *   another tab's state, or an expired attempt completes nothing
 * - A return for a different signed-in account completes nothing
 * - GitHub's refusal is reported with its install link
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type ConnectorAccount, challengeOf } from './connector.js';
import {
	finishGitHubConnect,
	PENDING_CONNECT_KEY,
	startGitHubConnect,
	syncCallback,
} from './github-connect.js';

const API = 'https://api.epicenter.test';
const CALLBACK = syncCallback('http://127.0.0.1:5186');

function memoryStorage() {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
	};
}

function signedIn(principalId: string) {
	const bodies: { url: string; body: unknown }[] = [];
	const account: ConnectorAccount = {
		authorityId: API,
		principalId: principalId as ConnectorAccount['principalId'],
		baseURL: API,
		fetch: async (input, init) => {
			const url = String(input);
			bodies.push({ url, body: JSON.parse(String(init?.body)) });
			if (url.endsWith('/connect'))
				return Response.json({
					authorizeUrl: 'https://github.com/login/oauth/authorize?x=1',
				});
			return Response.json({ user: { id: 101, login: 'alice-gh' } });
		},
	};
	return { account, bodies };
}

async function started(storage = memoryStorage()) {
	const alice = signedIn('alice');
	const authorizeUrl = expectOk(
		await startGitHubConnect({
			account: alice.account,
			redirectUri: CALLBACK,
			storage,
			now: () => 1_000,
		}),
	);
	const sent = alice.bodies[0]?.body as {
		redirectUri: string;
		state: string;
		codeChallenge: string;
	};
	return { alice, storage, authorizeUrl, sent };
}

const returned = (params: Record<string, string>) =>
	new URL(`${CALLBACK}?${new URLSearchParams(params)}`);

test('starting sends state and challenge with the exact callback, and keeps the verifier', async () => {
	const { alice, storage, authorizeUrl, sent } = await started();
	expect(authorizeUrl).toStartWith('https://github.com/');
	expect(CALLBACK).toBe('http://127.0.0.1:5186/sync');
	expect(alice.bodies[0]?.url).toBe(`${API}/api/git/github/connect`);
	expect(sent.redirectUri).toBe(CALLBACK);
	expect(sent.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
	const kept = JSON.parse(storage.map.get(PENDING_CONNECT_KEY) ?? '{}');
	expect(kept).toMatchObject({ state: sent.state, redirectUri: CALLBACK });
	expect(await challengeOf(kept.verifier)).toBe(sent.codeChallenge);
	expect(JSON.stringify(sent)).not.toContain(kept.verifier);
});

test('returning completes once with the kept verifier; a replay completes nothing', async () => {
	const { alice, storage, sent } = await started();
	const kept = JSON.parse(storage.map.get(PENDING_CONNECT_KEY) ?? '{}');
	const url = returned({ github_code: 'code', github_state: sent.state });
	const done = await finishGitHubConnect({
		url,
		account: alice.account,
		storage,
		now: () => 2_000,
	});
	expect(expectOk(done)).toEqual({ login: 'alice-gh' });
	expect(alice.bodies[1]).toEqual({
		url: `${API}/api/git/github/complete`,
		body: { code: 'code', verifier: kept.verifier, redirectUri: CALLBACK },
	});
	expect(storage.map.has(PENDING_CONNECT_KEY)).toBe(false);

	const replay = await finishGitHubConnect({
		url,
		account: alice.account,
		storage,
		now: () => 2_000,
	});
	expect(expectErr(replay).name).toBe('Unknown');
	expect(alice.bodies).toHaveLength(2);
});

test("another tab's state, or an expired attempt, completes nothing", async () => {
	const first = await started();
	expect(
		expectErr(
			await finishGitHubConnect({
				url: returned({ github_code: 'code', github_state: 'x'.repeat(43) }),
				account: first.alice.account,
				storage: first.storage,
			}),
		).name,
	).toBe('Unknown');

	const second = await started();
	expect(
		expectErr(
			await finishGitHubConnect({
				url: returned({ github_code: 'code', github_state: second.sent.state }),
				account: second.alice.account,
				storage: second.storage,
				now: () => 1_000 + 10 * 60 * 1000,
			}),
		).name,
	).toBe('Unknown');
	expect(second.alice.bodies).toHaveLength(1);
});

test('a damaged pending attempt returns a refusal instead of stranding the return page', async () => {
	const alice = signedIn('alice');
	const storage = memoryStorage();
	for (const value of ['null', '42', '[]', '{}', '{bad', '{"state":"x"}']) {
		storage.setItem(PENDING_CONNECT_KEY, value);
		const result = await finishGitHubConnect({
			url: returned({ github_code: 'code', github_state: 'x' }),
			account: alice.account,
			storage,
		});
		expect(expectErr(result).name).toBe('Unknown');
		expect(storage.getItem(PENDING_CONNECT_KEY)).toBeNull();
	}
	expect(alice.bodies).toEqual([]);
});

test('a connection abandoned before the server answers leaves no pending attempt', async () => {
	const storage = memoryStorage();
	const alice = signedIn('alice');
	const result = await startGitHubConnect({
		account: alice.account,
		redirectUri: CALLBACK,
		storage,
		isCurrent: () => false,
	});
	expect(expectErr(result).name).toBe('Session');
	expect(storage.getItem(PENDING_CONNECT_KEY)).toBeNull();
});

test('a return for a different signed-in account completes nothing', async () => {
	const { storage, sent } = await started();
	const bob = signedIn('bob');
	const result = await finishGitHubConnect({
		url: returned({ github_code: 'code', github_state: sent.state }),
		account: bob.account,
		storage,
		now: () => 2_000,
	});
	expect(expectErr(result).name).toBe('AccountChanged');
	expect(bob.bodies).toEqual([]);
});

test("GitHub's refusal is reported with its install link", async () => {
	const { alice, storage, sent } = await started();
	const result = await finishGitHubConnect({
		url: returned({
			github_error: 'repository_unavailable',
			github_state: sent.state,
			github_install_url:
				'https://github.com/apps/epicenter-folder-sync/installations/new',
		}),
		account: alice.account,
		storage,
		now: () => 2_000,
	});
	expect(expectErr(result)).toMatchObject({
		name: 'Declined',
		code: 'repository_unavailable',
		installUrl:
			'https://github.com/apps/epicenter-folder-sync/installations/new',
	});
	expect(alice.bodies).toHaveLength(1);
});
