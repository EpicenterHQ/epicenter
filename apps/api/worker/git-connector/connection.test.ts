/**
 * GitHub connection core tests.
 *
 * Runs the real per-principal connection over memory storage and a simulated
 * GitHub (see `test-support.ts`). The simulated provider encodes the
 * README's external assumptions; these tests prove the connector against
 * them, not against GitHub.
 *
 * Key behaviors:
 * - Authorization is a separate, single-use transaction redeemable only by
 *   the principal that began it
 * - Discovery reads installations over REST and makes no Git request
 * - Pairing selects by repository id and installation id; forged, public,
 *   read-only, or replaced repositories are refused
 * - Every pairing creation or replacement mints a revision; a transfer for
 *   any other revision is refused before GitHub is called
 * - Transfers carry a repository-scoped token, never the parent token, and
 *   refuse when scoping is unsupported; the scoped token must read the paired
 *   repository by id, since installation listings ignore its scope
 * - Grant expiry, revocation, and identity changes delete the grant and keep
 *   pairings; only the same GitHub user can use them again
 * - Concurrent transfers share one serialized refresh, and a rotated pair is
 *   persisted before, and used only after, its identity check
 * - A repository transfer reads the repository by name only to learn its id
 *   and owner, requires an installation on that owner, and then scopes and
 *   reads by id exactly as a pairing transfer does
 *
 * See also:
 * - `app.test.ts` for the HTTP protocol, auth seam, CORS, and Git relay
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { MAX_TRANSACTIONS, PENDING_TTL_MS } from './connection.js';
import { pkceChallenge, randomSecret } from './crypto.js';
import type { HttpFetch } from './github.js';
import {
	API_ORIGIN,
	APP_CALLBACK,
	CLIENT_ID,
	CLIENT_SECRET,
	createFixtureRuntime,
	type FakeUser,
	INSTALL_URL,
	REFRESH_TTL_S,
} from './test-support.js';

const HOUR = 60 * 60 * 1000;
const PROVIDER_CALLBACK = `${API_ORIGIN}/api/git/github/callback`;
const ALICE = 'principal-alice';
const MALLORY = 'principal-mallory';
const FOLDER = 'folder-1';
const NOTES = { repositoryId: 9001, installationId: 7001 };
const SCOPE_URL = `https://api.github.com/applications/${CLIENT_ID}/token/scoped`;
/** alice/notes read by its immutable id. */
const REPOSITORY_URL = 'https://api.github.com/repositories/9001';

async function setup() {
	const fixture = await createFixtureRuntime();
	const { directory } = fixture.memory;
	const connectionOf = (principalId: string) =>
		directory.forPrincipal(principalId).connection;

	async function begin(principalId = ALICE) {
		const verifier = randomSecret();
		const authorizeUrl = expectOk(
			await connectionOf(principalId).begin(principalId, {
				redirectUri: APP_CALLBACK,
				browserState: randomSecret(),
				browserChallenge: await pkceChallenge(verifier),
				providerRedirectUri: PROVIDER_CALLBACK,
			}),
		);
		return { verifier, authorizeUrl };
	}

	/** Begin as `principalId`, approve on GitHub as `user`, run the callback. */
	async function handoff(principalId = ALICE, user?: FakeUser) {
		const { verifier, authorizeUrl } = await begin(principalId);
		const callback = new URL(await fixture.github.approve(authorizeUrl, user));
		const [objectId = '', transactionId = '', secret = ''] = (
			callback.searchParams.get('state') ?? ''
		).split('.');
		const callbackInput = {
			transactionId,
			secret,
			code: callback.searchParams.get('code') ?? undefined,
		};
		const outcome = await directory.open(objectId)?.callback(callbackInput);
		const [handoffTransaction = '', handoffSecret = ''] =
			outcome && 'handoffCode' in outcome ? outcome.handoffCode.split('.') : [];
		return {
			verifier,
			objectId,
			callbackInput,
			outcome,
			redeem: {
				transactionId: handoffTransaction,
				secret: handoffSecret,
				verifier,
				redirectUri: APP_CALLBACK,
			},
		};
	}

	/** A principal with a live grant for `user`. */
	async function connect(principalId = ALICE, user?: FakeUser) {
		const { redeem } = await handoff(principalId, user);
		expectOk(await connectionOf(principalId).complete(principalId, redeem));
		return connectionOf(principalId);
	}

	/** Alice with a grant and `FOLDER` paired with alice/notes. */
	async function paired() {
		const connection = await connect();
		const { revision } = expectOk(
			await connection.pair(ALICE, { folderId: FOLDER, ...NOTES }),
		);
		const transfer = () =>
			connection.authorizeTransfer(ALICE, FOLDER, revision);
		return { connection, revision, transfer };
	}

	const scopeRequests = () =>
		fixture.github.requests.filter((r) => r.url === SCOPE_URL);
	const userRequests = () =>
		fixture.github.requests.filter(
			(r) => r.url === 'https://api.github.com/user',
		);
	const gitRequests = () =>
		fixture.github.requests.filter(
			(r) =>
				r.url.startsWith('https://github.com/') &&
				!r.url.startsWith('https://github.com/login/'),
		);

	return {
		...fixture,
		connectionOf,
		begin,
		handoff,
		connect,
		paired,
		scopeRequests,
		userRequests,
		gitRequests,
	};
}

// ============================================================================
// Authorization transaction and handoff
// ============================================================================

test('provider state routes to the principal object; PKCE is the connector’s own', async () => {
	const { begin, memory } = await setup();
	const { authorizeUrl } = await begin();
	const url = new URL(authorizeUrl);
	expect(url.origin + url.pathname).toBe(
		'https://github.com/login/oauth/authorize',
	);
	expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
	expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	expect(url.searchParams.get('redirect_uri')).toBe(PROVIDER_CALLBACK);
	const [objectId] = (url.searchParams.get('state') ?? '').split('.');
	expect(objectId).toBe(memory.objectId(ALICE));
});

test('the code exchange names no repository and uses the provider verifier', async () => {
	const { handoff, github } = await setup();
	await handoff();
	const exchange = github.requests.find((r) =>
		r.url.endsWith('/login/oauth/access_token'),
	);
	const form = new URLSearchParams(new TextDecoder().decode(exchange?.body));
	expect(form.has('repository_id')).toBe(false);
	expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(form.get('client_secret')).toBe(CLIENT_SECRET);
});

test('callback state is single-use', async () => {
	const { handoff, memory } = await setup();
	const { objectId, callbackInput, outcome } = await handoff();
	expect(outcome).toHaveProperty('handoffCode');
	expect(
		await memory.directory.open(objectId)?.callback(callbackInput),
	).toBeUndefined();
});

test('callback state for another principal’s object finds nothing', async () => {
	const { begin, github, memory } = await setup();
	const { authorizeUrl } = await begin(ALICE);
	const callback = new URL(await github.approve(authorizeUrl));
	const [, transactionId = '', secret = ''] = (
		callback.searchParams.get('state') ?? ''
	).split('.');
	const elsewhere = memory.directory.open(memory.objectId(MALLORY));
	expect(
		await elsewhere?.callback({ transactionId, secret, code: 'code-1' }),
	).toBeUndefined();
	expect(memory.keys(MALLORY)).toEqual([]);
});

test('only the principal that began the authorization can redeem it', async () => {
	const { handoff, connectionOf, memory } = await setup();
	const { redeem } = await handoff(ALICE);
	// Another principal's object holds no such transaction.
	expect(
		expectErr(await connectionOf(MALLORY).complete(MALLORY, redeem)).code,
	).toBe('invalid_grant');
	// Even reaching the initiator's object, another principal is refused.
	expect(
		expectErr(await connectionOf(ALICE).complete(MALLORY, redeem)).code,
	).toBe('invalid_grant');
	expect(memory.read(MALLORY, 'grant')).toBeUndefined();
	// The refusals did not burn the initiator's handoff.
	expectOk(await connectionOf(ALICE).complete(ALICE, redeem));
	expect(memory.read(ALICE, 'grant')).toBeDefined();
});

test('parallel completions redeem a handoff exactly once', async () => {
	const { handoff, connectionOf } = await setup();
	const { redeem } = await handoff();
	const connection = connectionOf(ALICE);
	const results = await Promise.all([
		connection.complete(ALICE, redeem),
		connection.complete(ALICE, redeem),
		connection.complete(ALICE, redeem),
	]);
	expect(results.filter((r) => r.error === null)).toHaveLength(1);
	expect(results.filter((r) => r.error?.code === 'invalid_grant')).toHaveLength(
		2,
	);
});

test('independent handoffs: the last successful completion wins', async () => {
	const { handoff, connectionOf, github, memory } = await setup();
	const asAlice = await handoff(ALICE, github.alice);
	const asBob = await handoff(ALICE, github.bob);
	const connection = connectionOf(ALICE);
	// Bob's attempt started later but completes first; Alice's completes last.
	expectOk(await connection.complete(ALICE, asBob.redeem));
	expectOk(await connection.complete(ALICE, asAlice.redeem));
	expect(memory.read(ALICE, 'grant')).toMatchObject({
		user: { id: github.alice.id },
	});
});

test('a wrong PKCE verifier burns the handoff', async () => {
	const { handoff, connectionOf } = await setup();
	const { redeem } = await handoff();
	const connection = connectionOf(ALICE);
	expectErr(
		await connection.complete(ALICE, { ...redeem, verifier: randomSecret() }),
	);
	expect(expectErr(await connection.complete(ALICE, redeem)).code).toBe(
		'invalid_grant',
	);
});

test('stored state holds hashes and sealed tokens, never plaintext secrets', async () => {
	const { paired, memory } = await setup();
	await paired();
	const stored = JSON.stringify([...memory.stores.values()].map((s) => [...s]));
	expect(stored).not.toContain('ghu_');
	expect(stored).not.toContain('ghr_');
});

test('authorization transactions are bounded and swept at expiry', async () => {
	const { begin, memory, clock, connectionOf } = await setup();
	for (let i = 0; i < MAX_TRANSACTIONS + 3; i++) await begin();
	const pending = () => memory.keys(ALICE).filter((k) => k.startsWith('txn:'));
	expect(pending()).toHaveLength(MAX_TRANSACTIONS);
	expect(memory.alarms.get(memory.objectId(ALICE))).toBe(
		clock.now() + PENDING_TTL_MS,
	);
	clock.advance(PENDING_TTL_MS);
	await memory.instance(memory.objectId(ALICE)).sweep();
	expect(pending()).toHaveLength(0);
	expect(memory.alarms.get(memory.objectId(ALICE))).toBeUndefined();
	// The principal binding stays; another principal cannot claim the object.
	expect(
		expectErr(
			await connectionOf(ALICE).begin(MALLORY, {
				redirectUri: APP_CALLBACK,
				browserState: randomSecret(),
				browserChallenge: randomSecret(),
				providerRedirectUri: PROVIDER_CALLBACK,
			}),
		).code,
	).toBe('principal_mismatch');
});

// ============================================================================
// Discovery and pairing
// ============================================================================

test('discovery lists reachable private repositories and makes no Git request', async () => {
	const { connect, gitRequests, scopeRequests } = await setup();
	const connection = await connect();
	const repositories = expectOk(await connection.repositories(ALICE));
	expect(repositories.map((r) => [r.id, r.fullName, r.push])).toEqual([
		[9001, 'alice/notes', true],
		[9003, 'alice/readonly', false],
		[9004, 'alice/journal', true],
	]);
	expect(repositories[0]).toEqual({
		id: 9001,
		installationId: 7001,
		ownerId: 101,
		fullName: 'alice/notes',
		cloneUrl: 'https://github.com/alice/notes.git',
		defaultBranch: 'main',
		push: true,
	});
	expect(gitRequests()).toHaveLength(0);
	expect(scopeRequests()).toHaveLength(0);
});

test('pairing selects a private repository by id and mints a revision', async () => {
	const { connect } = await setup();
	const connection = await connect();
	const pairing = expectOk(
		await connection.pair(ALICE, { folderId: FOLDER, ...NOTES }),
	);
	expect(pairing).toMatchObject({
		folderId: FOLDER,
		revision: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
		githubUserId: 101,
		branch: 'main',
		repository: {
			id: 9001,
			installationId: 7001,
			ownerId: 101,
			fullName: 'alice/notes',
			cloneUrl: 'https://github.com/alice/notes.git',
		},
	});
});

test('pairing refuses public and read-only repositories', async () => {
	const { connect, memory } = await setup();
	const connection = await connect();
	for (const repositoryId of [9002, 9003])
		expect(
			expectErr(
				await connection.pair(ALICE, {
					folderId: FOLDER,
					repositoryId,
					installationId: 7001,
				}),
			),
		).toEqual({ code: 'repository_unavailable', installUrl: INSTALL_URL });
	expect(memory.keys(ALICE).some((k) => k.startsWith('pairing:'))).toBe(false);
});

test('pairing refuses forged installation and repository ids', async () => {
	const { connect, memory } = await setup();
	const connection = await connect();
	for (const forged of [
		// Mallory's installation and repository.
		{ repositoryId: 9100, installationId: 7002 },
		// Mallory's repository under Alice's installation.
		{ repositoryId: 9100, installationId: 7001 },
		// Alice's repository under Mallory's installation.
		{ repositoryId: 9001, installationId: 7002 },
		// Ids that do not exist.
		{ repositoryId: 424242, installationId: 7001 },
		{ repositoryId: 9001, installationId: 999 },
	])
		expect(
			expectErr(await connection.pair(ALICE, { folderId: 'f', ...forged }))
				.code,
		).toBe('repository_unavailable');
	expect(memory.keys(ALICE).some((k) => k.startsWith('pairing:'))).toBe(false);
});

test('an existing pairing is never rewritten without replace', async () => {
	const { paired, github, clock } = await setup();
	const { connection } = await paired();
	const original = expectOk(await connection.pairings(ALICE))[0]?.pairing;
	clock.advance(HOUR);
	// The same choice returns the stored pairing, revision included.
	expect(
		expectOk(await connection.pair(ALICE, { folderId: FOLDER, ...NOTES })),
	).toEqual(original as never);
	// A renamed repository does not rewrite the stored origin either.
	const notes = github.repositories.get(9001);
	if (notes) notes.name = 'notes-renamed';
	expect(
		expectOk(await connection.pair(ALICE, { folderId: FOLDER, ...NOTES })),
	).toEqual(original as never);
	// A different branch or repository needs an explicit replace.
	for (const change of [{ branch: 'other' }, { repositoryId: 9004 }])
		expect(
			expectErr(
				await connection.pair(ALICE, { folderId: FOLDER, ...NOTES, ...change }),
			).code,
		).toBe('pairing_conflict');
});

test('principals are isolated from each other’s grants and pairings', async () => {
	const { paired, connect, connectionOf, memory, github } = await setup();
	const { revision } = await paired();
	await connect(MALLORY, github.mallory);
	const mallory = connectionOf(MALLORY);
	expect(expectOk(await mallory.pairings(MALLORY))).toEqual([]);
	expect(
		expectErr(await mallory.authorizeTransfer(MALLORY, FOLDER, revision)).code,
	).toBe('pairing_not_found');
	expect(
		expectErr(await mallory.pair(MALLORY, { folderId: FOLDER, ...NOTES })).code,
	).toBe('repository_unavailable');
	expect(memory.objectId(ALICE)).not.toBe(memory.objectId(MALLORY));
	// Routing to Alice's object with Mallory's principal is refused outright.
	expect(
		expectErr(
			await connectionOf(ALICE).authorizeTransfer(MALLORY, FOLDER, revision),
		).code,
	).toBe('principal_mismatch');
});

// ============================================================================
// Pairing revisions
// ============================================================================

test('a replaced pairing retires its old revision before any GitHub call', async () => {
	const { paired, scopeRequests, userRequests } = await setup();
	const { connection, revision: old, transfer } = await paired();
	expectOk(await transfer());
	const replaced = expectOk(
		await connection.pair(ALICE, {
			folderId: FOLDER,
			repositoryId: 9004,
			installationId: 7001,
			replace: true,
		}),
	);
	expect(replaced.revision).not.toBe(old);
	const scoped = scopeRequests().length;
	const users = userRequests().length;
	expect(
		expectErr(await connection.authorizeTransfer(ALICE, FOLDER, old)).code,
	).toBe('pairing_superseded');
	expect(scopeRequests()).toHaveLength(scoped);
	expect(userRequests()).toHaveLength(users);
	expect(
		expectOk(
			await connection.authorizeTransfer(ALICE, FOLDER, replaced.revision),
		).cloneUrl,
	).toBe('https://github.com/alice/journal.git');
});

test('every creation or replacement mints a revision that retires all earlier ones', async () => {
	const { paired, connect, github } = await setup();
	const { connection, revision: first } = await paired();
	const seen = [first];
	async function expectNewRevision(revision: string) {
		expect(seen).not.toContain(revision);
		for (const old of seen)
			expect(
				expectErr(await connection.authorizeTransfer(ALICE, FOLDER, old)).code,
			).toBe('pairing_superseded');
		expectOk(await connection.authorizeTransfer(ALICE, FOLDER, revision));
		seen.push(revision);
	}
	async function replace(input: {
		repositoryId: number;
		installationId: number;
		branch?: string;
	}) {
		const pairing = expectOk(
			await connection.pair(ALICE, {
				folderId: FOLDER,
				replace: true,
				...input,
			}),
		);
		await expectNewRevision(pairing.revision);
	}

	// The same repository id, replaced explicitly.
	await replace(NOTES);
	// Another branch.
	await replace({ ...NOTES, branch: 'drafts' });
	// Another installation: the app was reinstalled on the same account.
	github.reinstall(7001, 7011);
	await replace({ repositoryId: 9001, installationId: 7011 });
	// Another GitHub user, re-pairing a repository Bob can write.
	await connect(ALICE, github.bob);
	await replace({ repositoryId: 9003, installationId: 7011 });
	// Unpaired, then paired again.
	expectOk(await connection.unpair(ALICE, FOLDER));
	expect(
		expectErr(
			await connection.authorizeTransfer(ALICE, FOLDER, seen.at(-1) ?? ''),
		).code,
	).toBe('pairing_not_found');
	const again = expectOk(
		await connection.pair(ALICE, {
			folderId: FOLDER,
			repositoryId: 9003,
			installationId: 7011,
		}),
	);
	await expectNewRevision(again.revision);
});

test('matching folder ids in different principals never share a revision', async () => {
	const { paired, connect, connectionOf, github } = await setup();
	const alice = await paired();
	await connect(MALLORY, github.mallory);
	const mallory = connectionOf(MALLORY);
	const theirs = expectOk(
		await mallory.pair(MALLORY, {
			folderId: FOLDER,
			repositoryId: 9100,
			installationId: 7002,
		}),
	);
	expect(theirs.revision).not.toBe(alice.revision);
	expect(
		expectErr(await mallory.authorizeTransfer(MALLORY, FOLDER, alice.revision))
			.code,
	).toBe('pairing_superseded');
	expect(
		expectErr(
			await alice.connection.authorizeTransfer(ALICE, FOLDER, theirs.revision),
		).code,
	).toBe('pairing_superseded');
	expect(
		expectOk(await mallory.authorizeTransfer(MALLORY, FOLDER, theirs.revision))
			.cloneUrl,
	).toBe('https://github.com/mallory/secret.git');
	expectOk(await alice.transfer());
});

// ============================================================================
// Scoped transfer credentials
// ============================================================================

test('a transfer carries a token scoped to the paired repository id', async () => {
	const { paired, github, scopeRequests } = await setup();
	const { transfer } = await paired();
	const before = scopeRequests().length;
	const grant = expectOk(await transfer());
	expect(github.isScoped(grant.accessToken)).toBe(true);
	expect(github.isParent(grant.accessToken)).toBe(false);
	expect(grant.cloneUrl).toBe('https://github.com/alice/notes.git');

	const [request] = scopeRequests().slice(before);
	expect(request?.method).toBe('POST');
	expect(request?.headers.get('authorization')).toBe(
		`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
	);
	const body = JSON.parse(new TextDecoder().decode(request?.body));
	expect(body).toEqual({
		access_token: expect.stringMatching(/^ghu_access_/),
		target_id: 101,
		repository_ids: [9001],
		permissions: { contents: 'write' },
	});
});

test('a transfer resolves the repository by id with the scoped token, not a listing', async () => {
	const { paired, github } = await setup();
	const { transfer } = await paired();
	const before = github.requests.length;
	const grant = expectOk(await transfer());
	const withScoped = github.requests
		.slice(before)
		.filter(
			(r) => r.headers.get('authorization') === `Bearer ${grant.accessToken}`,
		);
	expect(withScoped.map((r) => r.url)).toEqual([REPOSITORY_URL]);
});

test('a scoped token that still lists the installation reaches only its repository', async () => {
	const { paired, github } = await setup();
	const { transfer } = await paired();
	const { accessToken } = expectOk(await transfer());
	const get = (url: string, authorization = `Bearer ${accessToken}`) =>
		github.fetch(url, { headers: { authorization } });
	// The listing is discovery: it still shows every repository alice sees.
	const listed = (await (
		await get('https://api.github.com/user/installations/7001/repositories')
	).json()) as { repositories: { id: number }[] };
	expect(listed.repositories.map((r) => r.id)).toEqual([
		9001, 9002, 9003, 9004,
	]);
	// Actual access is the paired repository only.
	expect((await get(REPOSITORY_URL)).status).toBe(200);
	expect((await get('https://api.github.com/repositories/9004')).status).toBe(
		404,
	);
	const refs = (name: string) =>
		get(
			`https://github.com/alice/${name}.git/info/refs?service=git-upload-pack`,
			`Basic ${btoa(`x-access-token:${accessToken}`)}`,
		);
	expect((await refs('notes')).status).toBe(200);
	expect((await refs('journal')).status).toBe(403);
});

test('a scoped token denied the selected repository fails closed', async () => {
	const { paired, github, memory } = await setup();
	const { transfer } = await paired();
	const notes = github.repositories.get(9001);
	if (!notes) throw new Error('fixture');
	// Access is lost after scoping, before the read by id.
	const providerFetch = github.fetch;
	github.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (new Request(input, init).url === REPOSITORY_URL)
			notes.access.delete(github.alice.id);
		return providerFetch(input, init);
	}) as HttpFetch;
	expect(expectErr(await transfer())).toEqual({
		code: 'repository_unavailable',
		installUrl: INSTALL_URL,
	});
	expect(memory.read(ALICE, 'grant')).toBeDefined();
});

test('a read by id that names another repository or owner fails closed', async () => {
	const { paired, github } = await setup();
	const { connection, transfer } = await paired();
	const providerFetch = github.fetch;
	for (const mutate of [
		(body: Record<string, unknown>) => ({ ...body, id: 9004 }),
		(body: Record<string, unknown>) => ({
			...body,
			owner: { id: 666, login: 'mallory' },
		}),
	]) {
		github.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const response = await providerFetch(input, init);
			if (new Request(input, init).url !== REPOSITORY_URL) return response;
			return Response.json(
				mutate((await response.json()) as Record<string, unknown>),
			);
		}) as HttpFetch;
		expect(expectErr(await transfer()).code).toBe('repository_unavailable');
		expect(
			expectErr(await connection.pair(ALICE, { folderId: 'other', ...NOTES }))
				.code,
		).toBe('repository_unavailable');
	}
	github.fetch = providerFetch;
	expectOk(await transfer());
});

test('a transfer requires the paired installation among the user’s installations', async () => {
	const { paired, github, scopeRequests } = await setup();
	const { transfer } = await paired();
	github.reinstall(7001, 7011);
	const scoped = scopeRequests().length;
	expect(expectErr(await transfer()).code).toBe('repository_unavailable');
	expect(scopeRequests()).toHaveLength(scoped);
});

test('unsupported scoping refuses instead of using the parent token', async () => {
	const { paired, github, memory } = await setup();
	const { transfer } = await paired();
	for (const mode of ['unexpected', 'empty', 'echo'] as const) {
		github.scopeMode = mode;
		expect(expectErr(await transfer()).code).toBe(
			'credential_scoping_unsupported',
		);
	}
	expect(memory.read(ALICE, 'grant')).toBeDefined();
});

test('a parent revoked between the consent check and scoping deletes the grant', async () => {
	const { paired, github, memory, userRequests } = await setup();
	const { transfer } = await paired();
	const users = userRequests().length;
	// `/user` confirms the grant; the person revokes before the scoping call,
	// which GitHub answers 404 for an invalid parent token.
	github.beforeScope = () => github.revokeAll();
	expect(expectErr(await transfer()).code).toBe(
		'github_authorization_required',
	);
	expect(userRequests()).toHaveLength(users + 1);
	expect(memory.read(ALICE, 'grant')).toBeUndefined();
	expect(memory.read(ALICE, `pairing:${FOLDER}`)).toBeDefined();
});

test('a scoping outage says nothing about the grant', async () => {
	const { paired, github, memory } = await setup();
	const { transfer } = await paired();
	const providerFetch = github.fetch;
	github.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (new Request(input, init).url === SCOPE_URL)
			return new Response('unavailable', { status: 503 });
		return providerFetch(input, init);
	}) as HttpFetch;
	expect(expectErr(await transfer()).code).toBe('upstream_unavailable');
	expect(memory.read(ALICE, 'grant')).toBeDefined();
	github.fetch = providerFetch;
	expectOk(await transfer());
});

test('a replacement repository at the old path cannot get a scoped token', async () => {
	const { paired, github, scopeRequests } = await setup();
	const { connection, transfer } = await paired();
	github.replaceRepository(9001, 9555);
	const before = scopeRequests().length;
	expect(expectErr(await transfer()).code).toBe('repository_unavailable');
	const [request] = scopeRequests().slice(before);
	expect(
		JSON.parse(new TextDecoder().decode(request?.body)).repository_ids,
	).toEqual([9001]);
	// Discovery shows the replacement as a different repository.
	expect(
		expectOk(await connection.repositories(ALICE)).map((r) => r.id),
	).toContain(9555);
});

test('a renamed repository transfers to its current path, keeping pairing metadata', async () => {
	const { paired, github } = await setup();
	const { connection, transfer } = await paired();
	const notes = github.repositories.get(9001);
	if (notes) notes.name = 'notes-renamed';
	expect(expectOk(await transfer()).cloneUrl).toBe(
		'https://github.com/alice/notes-renamed.git',
	);
	expect(
		expectOk(await connection.pairings(ALICE))[0]?.pairing.repository,
	).toMatchObject({
		fullName: 'alice/notes',
		cloneUrl: 'https://github.com/alice/notes.git',
	});
});

test('lost write access or a repository made public refuses the transfer', async () => {
	const { paired, github } = await setup();
	const { transfer } = await paired();
	const notes = github.repositories.get(9001);
	if (!notes) throw new Error('fixture');
	notes.access.set(101, 'read');
	expect(expectErr(await transfer()).code).toBe('repository_unavailable');
	notes.access.set(101, 'write');
	notes.private = false;
	expect(expectErr(await transfer()).code).toBe('repository_unavailable');
});

// ============================================================================
// Grant lifetime, consent, and pairings
// ============================================================================

test('consent is checked on every transfer, before expiry', async () => {
	const { paired, github, memory, scopeRequests, userRequests } = await setup();
	const { transfer } = await paired();
	const before = userRequests().length;
	expectOk(await transfer());
	expect(userRequests()).toHaveLength(before + 1);

	github.revokeAll();
	const scoped = scopeRequests().length;
	expect(expectErr(await transfer()).code).toBe(
		'github_authorization_required',
	);
	expect(scopeRequests()).toHaveLength(scoped);
	expect(memory.read(ALICE, 'grant')).toBeUndefined();
	expect(memory.read(ALICE, `pairing:${FOLDER}`)).toBeDefined();
});

test('an expired grant is deleted and its pairings remain', async () => {
	const { paired, clock, memory } = await setup();
	const { connection, transfer } = await paired();
	clock.advance(REFRESH_TTL_S * 1000);
	expect(expectErr(await transfer()).code).toBe(
		'github_authorization_required',
	);
	expect(memory.read(ALICE, 'grant')).toBeUndefined();
	expect(expectOk(await connection.pairings(ALICE))).toEqual([
		expect.objectContaining({ status: 'github_authorization_required' }),
	]);
});

test('reconnecting the same GitHub user restores pairings at the same revision', async () => {
	const { paired, connect, github } = await setup();
	const { connection, transfer } = await paired();
	github.revokeAll();
	expectErr(await transfer());
	await connect(ALICE, github.alice);
	expect(expectOk(await connection.pairings(ALICE))[0]?.status).toBe('ready');
	expectOk(await transfer());
});

test('a different GitHub user cannot silently adopt existing pairings', async () => {
	const { paired, connect, github } = await setup();
	const { connection, transfer } = await paired();
	await connect(ALICE, github.bob);
	expect(expectOk(await connection.pairings(ALICE))[0]?.status).toBe(
		'github_account_mismatch',
	);
	expect(expectErr(await transfer()).code).toBe('github_account_mismatch');
	// Re-pairing the same folder needs an explicit replace, verified as Bob.
	expect(
		expectErr(
			await connection.pair(ALICE, {
				folderId: FOLDER,
				repositoryId: 9003,
				installationId: 7001,
			}),
		).code,
	).toBe('pairing_conflict');
	const replaced = expectOk(
		await connection.pair(ALICE, {
			folderId: FOLDER,
			repositoryId: 9003,
			installationId: 7001,
			replace: true,
		}),
	);
	expect(replaced.githubUserId).toBe(202);
	expectOk(
		await connection.authorizeTransfer(ALICE, FOLDER, replaced.revision),
	);
});

test('a refreshed token for a different person deletes the grant, keeps pairings', async () => {
	const { paired, github, clock, memory } = await setup();
	const { transfer } = await paired();
	github.refreshAs = github.mallory;
	clock.advance(8 * HOUR);
	expect(expectErr(await transfer()).code).toBe(
		'github_authorization_required',
	);
	expect(memory.read(ALICE, 'grant')).toBeUndefined();
	expect(memory.read(ALICE, `pairing:${FOLDER}`)).toBeDefined();
});

// ============================================================================
// Refresh serialization
// ============================================================================

test('concurrent transfers near expiry share one refresh', async () => {
	const { paired, github, clock } = await setup();
	const { transfer } = await paired();
	clock.advance(8 * HOUR - 60_000);
	let release: () => void = () => {};
	github.refreshGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = Promise.all([transfer(), transfer(), transfer()]);
	await Bun.sleep(5);
	release();
	const grants = (await pending).map((result) => expectOk(result));
	expect(github.refreshCalls).toBe(1);
	for (const grant of grants)
		expect(github.isScoped(grant.accessToken)).toBe(true);
});

test('a rejected stored token is refreshed once inside admission', async () => {
	const { paired, github, memory } = await setup();
	const { transfer } = await paired();
	// The access token stopped working early; its refresh token still works.
	github.expireAccessTokens();
	expectOk(await transfer());
	expect(github.refreshCalls).toBe(1);
	expect(memory.read(ALICE, 'grant')).toBeDefined();
});

test('a rotated pair is persisted before, and used only after, a transient identity check', async () => {
	const { paired, github, clock, memory, scopeRequests } = await setup();
	const { transfer } = await paired();
	const original = memory.read(ALICE, 'grant') as { sealed: string };
	// The refresh lands, then GitHub drops before the identity check.
	const providerFetch = github.fetch;
	let failUser = true;
	github.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const { url } = new Request(input, init);
		if (failUser && url === 'https://api.github.com/user')
			throw new TypeError('offline');
		return providerFetch(input, init);
	}) as HttpFetch;
	clock.advance(8 * HOUR);
	const scoped = scopeRequests().length;
	expect(expectErr(await transfer()).code).toBe('upstream_unavailable');
	// GitHub rotated the pair, so it is kept, and nothing used it yet.
	const rotated = memory.read(ALICE, 'grant') as { sealed: string };
	expect(rotated.sealed).not.toBe(original.sealed);
	expect(scopeRequests()).toHaveLength(scoped);
	expect(github.refreshCalls).toBe(1);

	// The next operation verifies the stored pair without refreshing again.
	failUser = false;
	expectOk(await transfer());
	expect(github.refreshCalls).toBe(1);
	// The rotated refresh token survived: the next due refresh uses it.
	clock.advance(8 * HOUR);
	expectOk(await transfer());
	expect(github.refreshCalls).toBe(2);
});

test('a provider outage is upstream_unavailable and keeps the grant', async () => {
	const { paired, github, clock, memory } = await setup();
	const { transfer } = await paired();
	clock.advance(8 * HOUR);
	github.offline = true;
	expect(expectErr(await transfer()).code).toBe('upstream_unavailable');
	expect(memory.read(ALICE, 'grant')).toBeDefined();
	github.offline = false;
	expectOk(await transfer());
});

test('a revoked non-expiring token deletes the grant at the next admission', async () => {
	const { paired, github, memory } = await setup();
	github.nonExpiring = true;
	const { transfer } = await paired();
	expectOk(await transfer());
	github.revokeAll();
	expect(expectErr(await transfer()).code).toBe(
		'github_authorization_required',
	);
	expect(memory.read(ALICE, 'grant')).toBeUndefined();
	expect(memory.read(ALICE, `pairing:${FOLDER}`)).toBeDefined();
});

// ============================================================================
// Repository-addressed transfers
// ============================================================================

const ALICE_NOTES = { owner: 'alice', name: 'notes' };

test('a repository transfer locates the repository by name and scopes by id, with no pairing', async () => {
	const { connect, github, memory, scopeRequests } = await setup();
	const connection = await connect();
	const before = github.requests.length;
	const grant = expectOk(
		await connection.authorizeRepositoryTransfer(ALICE, ALICE_NOTES),
	);
	expect(github.isScoped(grant.accessToken)).toBe(true);
	expect(github.isParent(grant.accessToken)).toBe(false);
	expect(grant.cloneUrl).toBe('https://github.com/alice/notes.git');

	const sent = github.requests.slice(before);
	const byName = sent.find(
		(r) => r.url === 'https://api.github.com/repos/alice/notes',
	);
	// The name is read with the parent token; the id with the scoped token.
	expect(
		github.isParent(
			byName?.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
		),
	).toBe(true);
	expect(
		sent
			.filter(
				(r) => r.headers.get('authorization') === `Bearer ${grant.accessToken}`,
			)
			.map((r) => r.url),
	).toEqual([REPOSITORY_URL]);
	const [scope] = scopeRequests();
	expect(JSON.parse(new TextDecoder().decode(scope?.body))).toMatchObject({
		target_id: 101,
		repository_ids: [9001],
	});
	expect(memory.keys(ALICE).some((key) => key.startsWith('pairing:'))).toBe(
		false,
	);
});

test('a repository the user cannot reach by name is repository_unavailable', async () => {
	const { connect, scopeRequests } = await setup();
	const connection = await connect();
	for (const repository of [
		{ owner: 'alice', name: 'missing' },
		{ owner: 'mallory', name: 'secret' },
	])
		expect(
			expectErr(
				await connection.authorizeRepositoryTransfer(ALICE, repository),
			),
		).toEqual({ code: 'repository_unavailable', installUrl: INSTALL_URL });
	expect(scopeRequests()).toHaveLength(0);
});

test('a repository whose owner has no installation is repository_unavailable', async () => {
	const { connect, github, scopeRequests } = await setup();
	github.addRepository({
		id: 9200,
		owner: github.bob,
		name: 'scratch',
		installationId: 7003,
		access: [
			[github.bob, 'write'],
			[github.alice, 'write'],
		],
	});
	github.installations.delete(7003);
	const connection = await connect();
	expect(
		expectErr(
			await connection.authorizeRepositoryTransfer(ALICE, {
				owner: 'bob',
				name: 'scratch',
			}),
		),
	).toEqual({ code: 'repository_unavailable', installUrl: INSTALL_URL });
	expect(scopeRequests()).toHaveLength(0);
});

test('a public or read-only repository is refused by name as by id', async () => {
	const { connect } = await setup();
	const connection = await connect();
	for (const name of ['site', 'readonly'])
		expect(
			expectErr(
				await connection.authorizeRepositoryTransfer(ALICE, {
					owner: 'alice',
					name,
				}),
			).code,
		).toBe('repository_unavailable');
});

test('a repository replaced after its name was read cannot get a scoped token', async () => {
	const { connect, github } = await setup();
	const connection = await connect();
	github.beforeScope = () => github.replaceRepository(9001, 9555);
	expect(
		expectErr(await connection.authorizeRepositoryTransfer(ALICE, ALICE_NOTES))
			.code,
	).toBe('repository_unavailable');
});

test('a parent revoked before the read by name deletes the grant', async () => {
	const { connect, github, memory } = await setup();
	const connection = await connect();
	const providerFetch = github.fetch;
	github.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (
			new Request(input, init).url ===
			'https://api.github.com/repos/alice/notes'
		)
			github.revokeAll();
		return providerFetch(input, init);
	}) as HttpFetch;
	expect(
		expectErr(await connection.authorizeRepositoryTransfer(ALICE, ALICE_NOTES))
			.code,
	).toBe('github_authorization_required');
	expect(memory.read(ALICE, 'grant')).toBeUndefined();
});

test('a repository transfer needs a grant and the routed principal', async () => {
	const { connect, connectionOf, github } = await setup();
	expect(
		expectErr(
			await connectionOf(ALICE).authorizeRepositoryTransfer(ALICE, ALICE_NOTES),
		).code,
	).toBe('github_authorization_required');
	const connection = await connect();
	expect(
		expectErr(
			await connection.authorizeRepositoryTransfer(MALLORY, ALICE_NOTES),
		).code,
	).toBe('principal_mismatch');
	github.revokeAll();
	expect(
		expectErr(await connection.authorizeRepositoryTransfer(ALICE, ALICE_NOTES))
			.code,
	).toBe('github_authorization_required');
});
