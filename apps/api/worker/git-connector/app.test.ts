/**
 * GitHub connector HTTP tests.
 *
 * Mounts the connector behind `@epicenter/server`'s real
 * `requireBearerPrincipal`, with a fixture resolver standing in for
 * `resolveRequestSessionPrincipal`, over memory connection objects and a
 * simulated GitHub. Assertions read responses, redirects, and the exact
 * requests that reached the simulated upstream.
 *
 * Key behaviors:
 * - Identity comes only from the host's session middleware; only the GitHub
 *   callback is unauthenticated, and its state routes to the initiator
 * - `Origin` gates nothing: a native broker's loopback origin works with a
 *   session, and no origin works without one
 * - No connector failure is HTTP 401; that status is the session's alone
 * - Authorization handoffs redeem once, for the same principal
 * - Discovery and pairing make no Git request
 * - Git requests name a pairing revision; a superseded revision is refused
 *   before a token is minted, while an already admitted request finishes
 * - Git requests reach only the paired repository with a scoped token, a
 *   fixed header set, gzip bodies passed through, bounded bodies,
 *   propagated cancellation, no redirects, and no retry
 * - Repository paths (`/repos/<owner>/<name>.git`) relay with no pairing,
 *   refuse malformed owners and names before GitHub, and share the pairing
 *   routes' query, body, and header rules
 *
 * See also:
 * - `connection.test.ts` for grant lifetime, scoping, and refresh ordering
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
// The Bun barrel exports the same middleware without Durable Object modules.
import {
	createServerApp,
	type Env,
	OAuthError,
	requireBearerPrincipal,
} from '@epicenter/server/bun';
import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';
import {
	createGitHubConnectorApp,
	ERROR_STATUS,
	GIT_ERROR_HEADER,
	GITHUB_CONNECTOR_PATH,
} from './app.js';
import { pkceChallenge, randomSecret } from './crypto.js';
import {
	API_ORIGIN,
	APP_CALLBACK,
	APP_ORIGIN,
	CLIENT_ID,
	createFixtureRuntime,
	type FakeUser,
	INSTALL_URL,
} from './test-support.js';

const BASE = `${API_ORIGIN}${GITHUB_CONNECTOR_PATH}`;
const ALICE = 'principal-alice';
const MALLORY = 'principal-mallory';
const FOLDER = 'com.bradenwong.zhongwen';
const NOTES = { repositoryId: 9001, installationId: 7001 };
/** What a native broker forwards: a loopback origin on a dynamic port. */
const DEVICE_ORIGIN = 'http://127.0.0.1:53117';
const SCOPE_URL = `https://api.github.com/applications/${CLIENT_ID}/token/scoped`;
const RECEIVE_PACK = 'application/x-git-receive-pack-request';
const UPLOAD_PACK = 'application/x-git-upload-pack-request';

/** Git endpoints for one pairing revision. */
function gitPaths(revision: string, folder = FOLDER) {
	const base = `${BASE}/git/${folder}/${revision}`;
	return {
		uploadRefs: `${base}/info/refs?service=git-upload-pack`,
		receiveRefs: `${base}/info/refs?service=git-receive-pack`,
		uploadPack: `${base}/git-upload-pack`,
		receivePack: `${base}/git-receive-pack`,
		base,
	};
}

/** Git endpoints for a repository named as its canonical clone URL does. */
function repoPaths(owner: string, repo: string) {
	const base = `${BASE}/repos/${owner}/${repo}`;
	return {
		uploadRefs: `${base}/info/refs?service=git-upload-pack`,
		receiveRefs: `${base}/info/refs?service=git-receive-pack`,
		uploadPack: `${base}/git-upload-pack`,
		receivePack: `${base}/git-receive-pack`,
		base,
	};
}

async function setup(options?: {
	transferLimitBytes?: number;
	hostCors?: boolean;
}) {
	const fixture = await createFixtureRuntime(options);
	let configured = true;
	const sessions = new Map<string, string>([
		[`session-${ALICE}`, ALICE],
		[`session-${MALLORY}`, MALLORY],
	]);
	const host = options?.hostCors
		? createServerApp<Env>({
				resolveOrigin: () => API_ORIGIN,
				resolveTrustedOrigins: () => [APP_ORIGIN],
			})
		: new Hono<Env>();
	if (!options?.hostCors)
		host.use('*', async (c, next) => {
			c.set('authBaseURL', API_ORIGIN);
			c.set('trustedOrigins', []);
			await next();
		});
	host.route(
		'/',
		createGitHubConnectorApp<Env>({
			// Stands in for resolveRequestSessionPrincipal: the session store,
			// not the request, decides who the caller is.
			auth: requireBearerPrincipal<Env>(async (_c, bearer) => {
				const principal = sessions.get(bearer);
				return principal
					? Ok({ id: asPrincipalId(principal), email: `${principal}@test` })
					: OAuthError.InvalidToken();
			}),
			resolve: () => (configured ? fixture.runtime : undefined),
		}),
	);
	const request = async (url: string, init?: RequestInit): Promise<Response> =>
		host.request(url, init);

	/** A request with the principal's session bearer from `origin`. */
	function as(
		principalId: string | null,
		url: string,
		init: RequestInit & { json?: unknown; origin?: string | null } = {},
	) {
		const { json, origin = APP_ORIGIN, ...rest } = init;
		return request(url, {
			...rest,
			...(json !== undefined ? { body: JSON.stringify(json) } : {}),
			headers: {
				...(origin ? { origin } : {}),
				...(principalId
					? { authorization: `Bearer session-${principalId}` }
					: {}),
				...(json !== undefined ? { 'content-type': 'application/json' } : {}),
				...(rest.headers as Record<string, string>),
			},
		});
	}

	async function start(
		principalId = ALICE,
		body: Record<string, unknown> = {},
	) {
		const verifier = randomSecret();
		const state = randomSecret();
		const response = await as(principalId, `${BASE}/connect`, {
			method: 'POST',
			json: {
				redirectUri: APP_CALLBACK,
				state,
				codeChallenge: await pkceChallenge(verifier),
				...body,
			},
		});
		return { verifier, state, response };
	}

	/** Start, approve on GitHub, and land back on the app's /sync page. */
	async function land(principalId = ALICE, user?: FakeUser) {
		const { verifier, state, response } = await start(principalId);
		expect(response.status).toBe(200);
		const { authorizeUrl } = (await response.json()) as {
			authorizeUrl: string;
		};
		const callback = await fixture.github.approve(authorizeUrl, user);
		const toApp = await request(callback);
		expect(toApp.status).toBe(302);
		return {
			verifier,
			state,
			callback,
			landing: new URL(toApp.headers.get('location') ?? ''),
		};
	}

	function complete(principalId: string | null, body: Record<string, unknown>) {
		return as(principalId, `${BASE}/complete`, { method: 'POST', json: body });
	}

	async function connect(principalId = ALICE, user?: FakeUser) {
		const { verifier, landing } = await land(principalId, user);
		const response = await complete(principalId, {
			code: landing.searchParams.get('github_code'),
			verifier,
			redirectUri: APP_CALLBACK,
		});
		expect(response.status).toBe(200);
	}

	function pair(
		principalId: string,
		body: Record<string, unknown>,
		options: { folder?: string; origin?: string } = {},
	) {
		return as(principalId, `${BASE}/pairings/${options.folder ?? FOLDER}`, {
			method: 'PUT',
			json: body,
			origin: options.origin,
		});
	}

	/** The pairing's revision from a successful pairing response. */
	async function revisionOf(response: Response): Promise<string> {
		expect(response.status).toBe(200);
		const { pairing } = (await response.json()) as {
			pairing: { revision: string };
		};
		return pairing.revision;
	}

	/** Alice connected and `FOLDER` paired with alice/notes. */
	async function paired() {
		await connect();
		return gitPaths(await revisionOf(await pair(ALICE, NOTES)));
	}

	const gitRequests = () =>
		fixture.github.requests.filter(
			(r) =>
				r.url.startsWith('https://github.com/') &&
				!r.url.startsWith('https://github.com/login/'),
		);
	const scopeRequests = () =>
		fixture.github.requests.filter((r) => r.url === SCOPE_URL);
	const basicToken = (headers: Headers | undefined) =>
		atob(headers?.get('authorization')?.slice(6) ?? '').split(':')[1] ?? '';

	return {
		...fixture,
		request,
		as,
		start,
		land,
		complete,
		connect,
		pair,
		revisionOf,
		paired,
		gitRequests,
		scopeRequests,
		basicToken,
		unconfigure: () => {
			configured = false;
		},
	};
}

// ============================================================================
// Auth seam and origins
// ============================================================================

test('every route except the callback requires the Epicenter session', async () => {
	const { as, memory } = await setup();
	const git = gitPaths('A'.repeat(22), 'f');
	const repo = repoPaths('alice', 'notes.git');
	for (const [method, url] of [
		['POST', `${BASE}/connect`],
		['POST', `${BASE}/complete`],
		['GET', `${BASE}/repositories`],
		['GET', `${BASE}/pairings`],
		['PUT', `${BASE}/pairings/${FOLDER}`],
		['DELETE', `${BASE}/pairings/${FOLDER}`],
		['GET', git.uploadRefs],
		['POST', git.receivePack],
		['GET', repo.receiveRefs],
		['POST', repo.uploadPack],
	] as const) {
		for (const origin of [APP_ORIGIN, DEVICE_ORIGIN, null]) {
			const response = await as(null, url, { method, origin });
			expect(response.status).toBe(401);
			// The session middleware answered, not the connector.
			expect(response.headers.get(GIT_ERROR_HEADER)).toBeNull();
		}
	}
	expect(memory.stores.size).toBe(0);
});

test('a caller-supplied identity header selects nothing', async () => {
	const { request, memory } = await setup();
	const response = await request(`${BASE}/pairings`, {
		headers: {
			origin: DEVICE_ORIGIN,
			'x-epicenter-principal': ALICE,
			authorization: 'Bearer forged',
		},
	});
	expect(response.status).toBe(401);
	expect(memory.stores.size).toBe(0);
});

test('a session from the native broker’s loopback origin can pair and transfer', async () => {
	const { connect, pair, revisionOf, as, gitRequests } = await setup();
	await connect();
	const revision = await revisionOf(
		await pair(ALICE, NOTES, { origin: DEVICE_ORIGIN }),
	);
	const git = gitPaths(revision);
	const listed = await as(ALICE, `${BASE}/pairings`, { origin: DEVICE_ORIGIN });
	expect(listed.status).toBe(200);
	const advertisement = await as(ALICE, git.uploadRefs, {
		origin: DEVICE_ORIGIN,
	});
	expect(advertisement.status).toBe(200);
	const push = await as(ALICE, git.receivePack, {
		method: 'POST',
		origin: DEVICE_ORIGIN,
		headers: { 'content-type': RECEIVE_PACK },
		body: new Uint8Array([1]),
	});
	expect(push.status).toBe(200);
	expect(gitRequests()).toHaveLength(2);
	// CORS still exposes nothing to a page at that origin.
	expect(advertisement.headers.get('access-control-allow-origin')).toBeNull();
});

test('requests without an Origin work with a session', async () => {
	const { paired, as } = await setup();
	const git = await paired();
	expect((await as(ALICE, git.uploadRefs, { origin: null })).status).toBe(200);
});

test('no connector error is HTTP 401', () => {
	expect(Object.values(ERROR_STATUS)).not.toContain(401 as never);
});

test('missing bindings answer 503 not_configured', async () => {
	const { start, unconfigure, memory } = await setup();
	unconfigure();
	const { response } = await start();
	expect(response.status).toBe(503);
	expect(response.headers.get(GIT_ERROR_HEADER)).toBe('not_configured');
	expect(memory.stores.size).toBe(0);
});

// ============================================================================
// Connect, callback, complete
// ============================================================================

test('connect returns the GitHub authorize URL for the verified principal', async () => {
	const { start, memory } = await setup();
	const { response } = await start();
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(response.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
	expect(response.headers.get('access-control-allow-credentials')).toBeNull();
	const { authorizeUrl } = (await response.json()) as { authorizeUrl: string };
	const url = new URL(authorizeUrl);
	expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/callback`);
	expect(url.searchParams.get('state')?.split('.')[0]).toBe(
		memory.objectId(ALICE),
	);
});

test('connect refuses unlisted callbacks and malformed values', async () => {
	const { start, memory } = await setup();
	for (const body of [
		{ redirectUri: `${APP_CALLBACK}/` },
		{ redirectUri: `${APP_CALLBACK}?next=1` },
		{ redirectUri: 'https://evil.test/sync' },
		{ redirectUri: `${DEVICE_ORIGIN}/sync` },
		{ state: 'short' },
		{ codeChallenge: `${'x'.repeat(42)}=` },
	])
		expect((await start(ALICE, body)).response.status).toBe(400);
	expect(memory.stores.size).toBe(0);
});

test('callback hands off a code and the original browser state only', async () => {
	const { land } = await setup();
	const { state, landing } = await land();
	expect(landing.origin + landing.pathname).toBe(APP_CALLBACK);
	expect([...landing.searchParams.keys()].sort()).toEqual([
		'github_code',
		'github_state',
	]);
	expect(landing.searchParams.get('github_state')).toBe(state);
	expect(landing.toString()).not.toContain('ghu_');
	expect(landing.toString()).not.toContain('ghr_');
});

test('a replayed callback gets no redirect', async () => {
	const { land, request } = await setup();
	const { callback } = await land();
	const replay = await request(callback);
	expect(replay.status).toBe(400);
	expect(replay.headers.get('location')).toBeNull();
});

test('a forged callback state touches no state', async () => {
	const { request, memory } = await setup();
	for (const state of [
		`${'f'.repeat(64)}.${'a'.repeat(22)}.${randomSecret()}`,
		`${memory.objectId(ALICE)}.${'a'.repeat(22)}.${randomSecret()}`,
		`../../${randomSecret()}`,
		'',
	]) {
		const response = await request(`${BASE}/callback?code=x&state=${state}`);
		expect(response.status).toBe(400);
		expect(response.headers.get('location')).toBeNull();
	}
	expect(memory.stores.size).toBe(0);
});

test('a declined authorization returns github_error with the browser state', async () => {
	const { start, request, github } = await setup();
	const { state, response } = await start();
	const { authorizeUrl } = (await response.json()) as { authorizeUrl: string };
	const callback = new URL(await github.approve(authorizeUrl));
	callback.searchParams.delete('code');
	callback.searchParams.set('error', 'access_denied');
	const landing = new URL(
		(await request(callback.toString())).headers.get('location') ?? '',
	);
	expect(landing.searchParams.get('github_error')).toBe('access_denied');
	expect(landing.searchParams.get('github_state')).toBe(state);
	expect(landing.searchParams.has('github_code')).toBe(false);
});

test('only the initiating principal can redeem the handoff', async () => {
	const { land, complete, memory } = await setup();
	const { verifier, landing } = await land(ALICE);
	const body = {
		code: landing.searchParams.get('github_code'),
		verifier,
		redirectUri: APP_CALLBACK,
	};
	const stolen = await complete(MALLORY, body);
	expect(stolen.status).toBe(400);
	expect(stolen.headers.get(GIT_ERROR_HEADER)).toBe('invalid_grant');
	expect(memory.read(MALLORY, 'grant')).toBeUndefined();
	const response = await complete(ALICE, body);
	expect(response.status).toBe(200);
	expect((await response.json()) as object).toEqual({
		user: { id: 101, login: 'alice' },
	});
});

test('complete refuses another callback; the code still redeems once', async () => {
	const { land, complete } = await setup();
	const { verifier, landing } = await land();
	const body = {
		code: landing.searchParams.get('github_code'),
		verifier,
		redirectUri: APP_CALLBACK,
	};
	expect(
		(await complete(ALICE, { ...body, redirectUri: 'https://evil.test/sync' }))
			.status,
	).toBe(400);
	expect((await complete(ALICE, body)).status).toBe(200);
	expect((await complete(ALICE, body)).status).toBe(400);
});

test('parallel completions over HTTP install exactly one grant', async () => {
	const { land, complete } = await setup();
	const { verifier, landing } = await land();
	const body = {
		code: landing.searchParams.get('github_code'),
		verifier,
		redirectUri: APP_CALLBACK,
	};
	const statuses = (
		await Promise.all([
			complete(ALICE, body),
			complete(ALICE, body),
			complete(ALICE, body),
		])
	).map((r) => r.status);
	expect(statuses.sort()).toEqual([200, 400, 400]);
});

test('complete refuses an oversized body before parsing', async () => {
	const { complete } = await setup();
	const response = await complete(ALICE, { code: 'x'.repeat(8000) });
	expect(response.status).toBe(413);
});

// ============================================================================
// Discovery and pairing
// ============================================================================

test('discovery lists private repositories without any Git request', async () => {
	const { connect, as, gitRequests } = await setup();
	await connect();
	const response = await as(ALICE, `${BASE}/repositories`);
	expect(response.status).toBe(200);
	const { repositories } = (await response.json()) as {
		repositories: { id: number; push: boolean }[];
	};
	expect(repositories.map((r) => [r.id, r.push])).toEqual([
		[9001, true],
		[9003, false],
		[9004, true],
	]);
	expect(gitRequests()).toHaveLength(0);
});

test('discovery without a GitHub grant is 403, not 401', async () => {
	const { as } = await setup();
	const response = await as(ALICE, `${BASE}/repositories`);
	expect(response.status).toBe(403);
	expect(response.headers.get(GIT_ERROR_HEADER)).toBe(
		'github_authorization_required',
	);
});

test('pairing returns the revision and remote, without a Git request', async () => {
	const { connect, pair, as, gitRequests } = await setup();
	await connect();
	const response = await pair(ALICE, NOTES);
	expect(response.status).toBe(200);
	const { pairing } = (await response.json()) as {
		pairing: { revision: string };
	};
	const expected = {
		folderId: FOLDER,
		revision: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
		status: 'ready',
		repository: { id: 9001, installationId: 7001, fullName: 'alice/notes' },
		remote: { url: 'https://github.com/alice/notes.git', branch: 'main' },
	};
	expect(pairing).toEqual(expected);
	expect(
		(await (await as(ALICE, `${BASE}/pairings`)).json()) as object,
	).toEqual({ pairings: [{ ...expected, revision: pairing.revision }] });
	expect(gitRequests()).toHaveLength(0);
});

test('pairing refuses malformed and forged selections', async () => {
	const { connect, pair } = await setup();
	await connect();
	for (const body of [
		{},
		{ repositoryId: '9001', installationId: 7001 },
		{ ...NOTES, branch: '../main' },
		{ ...NOTES, replace: 'yes' },
	])
		expect((await pair(ALICE, body)).status).toBe(400);
	expect((await pair(ALICE, NOTES, { folder: 'bad folder' })).status).toBe(400);
	const forged = await pair(ALICE, {
		repositoryId: 9100,
		installationId: 7002,
	});
	expect(forged.status).toBe(403);
	expect((await forged.json()) as object).toMatchObject({
		error: 'repository_unavailable',
		installUrl: INSTALL_URL,
	});
	expect((await pair(ALICE, NOTES)).status).toBe(200);
	const conflict = await pair(ALICE, {
		repositoryId: 9004,
		installationId: 7001,
	});
	expect(conflict.status).toBe(409);
	expect(conflict.headers.get(GIT_ERROR_HEADER)).toBe('pairing_conflict');
});

test('unpairing removes the pairing; transfers then report pairing_not_found', async () => {
	const { paired, as } = await setup();
	const git = await paired();
	expect(
		(await as(ALICE, `${BASE}/pairings/${FOLDER}`, { method: 'DELETE' }))
			.status,
	).toBe(204);
	const response = await as(ALICE, git.uploadRefs);
	expect(response.status).toBe(404);
	expect(response.headers.get(GIT_ERROR_HEADER)).toBe('pairing_not_found');
});

test('another principal cannot reach a folder paired by someone else', async () => {
	const { paired, connect, as, github, gitRequests } = await setup();
	const git = await paired();
	await connect(MALLORY, github.mallory);
	const response = await as(MALLORY, git.uploadRefs);
	expect(response.status).toBe(404);
	expect(response.headers.get(GIT_ERROR_HEADER)).toBe('pairing_not_found');
	expect(gitRequests()).toHaveLength(0);
});

// ============================================================================
// Pairing revisions on the wire
// ============================================================================

test('advertisement on A, replace with B, then a POST for A is refused before scoping', async () => {
	const { paired, pair, revisionOf, as, gitRequests, scopeRequests } =
		await setup();
	const a = await paired();
	expect((await as(ALICE, a.receiveRefs)).status).toBe(200);
	const b = gitPaths(
		await revisionOf(
			await pair(ALICE, {
				repositoryId: 9004,
				installationId: 7001,
				replace: true,
			}),
		),
	);
	const sent = gitRequests().length;
	const scoped = scopeRequests().length;
	const stale = await as(ALICE, a.receivePack, {
		method: 'POST',
		headers: { 'content-type': RECEIVE_PACK },
		body: new Uint8Array([1, 2, 3]),
	});
	expect(stale.status).toBe(409);
	expect(stale.headers.get(GIT_ERROR_HEADER)).toBe('pairing_superseded');
	expect(gitRequests()).toHaveLength(sent);
	expect(scopeRequests()).toHaveLength(scoped);
	// The current revision reaches the new repository.
	expect((await as(ALICE, b.receiveRefs)).status).toBe(200);
	expect(gitRequests().at(-1)?.url).toBe(
		'https://github.com/alice/journal.git/info/refs?service=git-receive-pack',
	);
});

test('an admitted transfer finishes against its repository after the pairing is replaced', async () => {
	const { paired, pair, as, github, gitRequests } = await setup();
	const a = await paired();
	const chunks = 5;
	let sentChunks = 0;
	let release: () => void = () => {};
	const replaced = new Promise<void>((resolve) => {
		release = resolve;
	});
	github.gitBody = () =>
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				// Hold the stream open until the pairing has been replaced.
				if (sentChunks === 1) await replaced;
				controller.enqueue(new Uint8Array([sentChunks]));
				if (++sentChunks === chunks) controller.close();
			},
		});
	const response = await as(ALICE, a.uploadRefs);
	expect(response.status).toBe(200);
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const first = await reader.read();
	expect(first.value).toEqual(new Uint8Array([0]));

	expect(
		(
			await pair(ALICE, {
				repositoryId: 9004,
				installationId: 7001,
				replace: true,
			})
		).status,
	).toBe(200);
	release();
	const rest: number[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		rest.push(...value);
	}
	expect(rest).toEqual([1, 2, 3, 4]);
	expect(gitRequests().map((r) => r.url)).toEqual([
		'https://github.com/alice/notes.git/info/refs?service=git-upload-pack',
	]);
	// The next request for the old revision is refused.
	github.gitBody = () => new Uint8Array([1]);
	expect((await as(ALICE, a.uploadRefs)).status).toBe(409);
});

test('malformed revisions are refused before admission', async () => {
	const { paired, as, scopeRequests } = await setup();
	await paired();
	const scoped = scopeRequests().length;
	for (const revision of ['short', 'A'.repeat(23), `${'A'.repeat(21)}-!`])
		expect((await as(ALICE, gitPaths(revision).uploadRefs)).status).toBe(400);
	expect(scopeRequests()).toHaveLength(scoped);
});

// ============================================================================
// CORS
// ============================================================================

test('the hosted server admits Git preflights and keeps transfers behind its bearer guard', async () => {
	const { request } = await setup({ hostCors: true });
	const url = gitPaths('A'.repeat(22)).receivePack;
	const response = await request(url, {
		method: 'OPTIONS',
		headers: {
			origin: APP_ORIGIN,
			'access-control-request-method': 'POST',
			'access-control-request-headers':
				'authorization,content-type,content-encoding,git-protocol',
		},
	});
	expect(response.status).toBe(204);
	expect(response.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
	const allowed = response.headers
		.get('access-control-allow-headers')
		?.toLowerCase()
		.split(',');
	for (const header of [
		'authorization',
		'content-type',
		'content-encoding',
		'git-protocol',
	])
		expect(allowed).toContain(header);
	expect(
		(
			await request(url, {
				method: 'POST',
				headers: { origin: APP_ORIGIN, 'content-type': RECEIVE_PACK },
				body: 'not authenticated',
			})
		).status,
	).toBe(401);
});

test('preflight allows exactly the Git headers for the app origin', async () => {
	const { request } = await setup();
	const response = await request(gitPaths('A'.repeat(22)).receivePack, {
		method: 'OPTIONS',
		headers: {
			origin: APP_ORIGIN,
			'access-control-request-method': 'POST',
			'access-control-request-headers':
				'authorization,content-type,content-encoding,git-protocol',
		},
	});
	expect(response.status).toBe(204);
	expect(response.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
	expect(response.headers.get('access-control-allow-headers')).toBe(
		'Authorization,Content-Type,Content-Encoding,Git-Protocol',
	);
	expect(response.headers.get('access-control-allow-credentials')).toBeNull();
});

test('preflight from another origin gets no allow-origin', async () => {
	const { request } = await setup();
	for (const origin of ['https://evil.test', DEVICE_ORIGIN]) {
		const response = await request(`${BASE}/complete`, {
			method: 'OPTIONS',
			headers: { origin, 'access-control-request-method': 'POST' },
		});
		expect(response.headers.get('access-control-allow-origin')).toBeNull();
	}
});

// ============================================================================
// Git relay
// ============================================================================

test('advertisement reaches only the paired repository with a scoped token', async () => {
	const { paired, as, gitRequests, github, basicToken } = await setup();
	const git = await paired();
	const response = await as(ALICE, git.uploadRefs, {
		headers: {
			'git-protocol': 'version=2',
			cookie: 'session=browser',
			'x-forwarded-host': 'evil.test',
			'x-github-token': 'nope',
		},
	});
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toBe(
		'application/x-git-upload-pack-advertisement',
	);
	expect(response.headers.get('access-control-expose-headers')).toBe(
		GIT_ERROR_HEADER,
	);
	expect(response.headers.get('set-cookie')).toBeNull();
	expect(response.headers.get('x-github-request-id')).toBeNull();
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(
		new Uint8Array([1, 2, 3]),
	);

	const [upstream] = gitRequests();
	expect(upstream?.url).toBe(
		'https://github.com/alice/notes.git/info/refs?service=git-upload-pack',
	);
	const forwarded: string[] = [];
	upstream?.headers.forEach((_, name) => {
		forwarded.push(name);
	});
	expect(forwarded.sort()).toEqual([
		'accept',
		'authorization',
		'git-protocol',
		'user-agent',
	]);
	const token = basicToken(upstream?.headers);
	expect(github.isScoped(token)).toBe(true);
	expect(github.isParent(token)).toBe(false);
	expect(upstream?.headers.get('authorization')).not.toContain('session-');
});

test('git refuses extra query parameters and unknown services', async () => {
	const { paired, as, gitRequests } = await setup();
	const git = await paired();
	for (const url of [
		`${git.uploadRefs}&url=https://evil.test`,
		`${git.base}/info/refs?service=git-upload-archive`,
		`${git.base}/info/refs`,
	])
		expect((await as(ALICE, url)).status).toBe(400);
	expect(
		(
			await as(ALICE, `${git.base}/git-upload-archive`, {
				method: 'POST',
				body: 'x',
			})
		).status,
	).toBe(404);
	expect(gitRequests()).toHaveLength(0);
});

test('push forwards the body and passes a rejected ref update through', async () => {
	const { paired, as, gitRequests, github } = await setup();
	const git = await paired();
	const report = new TextEncoder().encode(
		'0013unpack ok\n0031ng refs/heads/main non-fast-forward\n0000',
	);
	github.gitBody = () => report;
	const pack = new Uint8Array([9, 8, 7, 6]);
	const response = await as(ALICE, git.receivePack, {
		method: 'POST',
		headers: { 'content-type': RECEIVE_PACK },
		body: pack,
	});
	expect(response.status).toBe(200);
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(report);
	const [upstream] = gitRequests();
	expect(upstream?.url).toBe(
		'https://github.com/alice/notes.git/git-receive-pack',
	);
	expect(upstream?.body).toEqual(pack);
	expect(upstream?.headers.has('content-encoding')).toBe(false);
});

test('a gzip request body passes through byte for byte with its encoding', async () => {
	const { paired, as, gitRequests } = await setup();
	const git = await paired();
	const request = new TextEncoder().encode(
		'0032want 0123456789012345678901234567890123456789\n00000009done\n',
	);
	const gzipped = Bun.gzipSync(request);
	const response = await as(ALICE, git.uploadPack, {
		method: 'POST',
		headers: { 'content-type': UPLOAD_PACK, 'content-encoding': 'gzip' },
		body: gzipped,
	});
	expect(response.status).toBe(200);
	const [upstream] = gitRequests();
	expect(upstream?.headers.get('content-encoding')).toBe('gzip');
	// Neither decoded nor re-encoded on the way through.
	expect(upstream?.body).toEqual(gzipped);
	expect(Bun.gunzipSync(new Uint8Array(upstream?.body ?? []))).toEqual(request);
});

test('the transfer limit counts gzip bytes as sent', async () => {
	const { paired, as, gitRequests } = await setup({ transferLimitBytes: 256 });
	const git = await paired();
	// 64 KiB of zeros compresses far below the limit and passes.
	const small = Bun.gzipSync(new Uint8Array(64 * 1024));
	expect(small.byteLength).toBeLessThan(256);
	const accepted = await as(ALICE, git.uploadPack, {
		method: 'POST',
		headers: { 'content-type': UPLOAD_PACK, 'content-encoding': 'gzip' },
		body: small,
	});
	expect(accepted.status).toBe(200);
	// Random bytes do not compress and exceed it.
	const large = Bun.gzipSync(crypto.getRandomValues(new Uint8Array(1024)));
	const refused = await as(ALICE, git.uploadPack, {
		method: 'POST',
		headers: { 'content-type': UPLOAD_PACK, 'content-encoding': 'gzip' },
		body: large,
	});
	expect(refused.status).toBe(413);
	expect(gitRequests()).toHaveLength(1);
});

test('unsupported request encodings are refused before GitHub', async () => {
	const { paired, as, gitRequests, scopeRequests } = await setup();
	const git = await paired();
	const scoped = scopeRequests().length;
	for (const encoding of ['br', 'deflate', 'compress', 'x-gzip', 'gzip, gzip'])
		expect(
			(
				await as(ALICE, git.uploadPack, {
					method: 'POST',
					headers: {
						'content-type': UPLOAD_PACK,
						'content-encoding': encoding,
					},
					body: new Uint8Array([1]),
				})
			).status,
		).toBe(400);
	expect(gitRequests()).toHaveLength(0);
	expect(scopeRequests()).toHaveLength(scoped);
});

test('push with the wrong content type is refused', async () => {
	const { paired, as, gitRequests } = await setup();
	const git = await paired();
	const response = await as(ALICE, git.receivePack, {
		method: 'POST',
		headers: { 'content-type': 'text/plain' },
		body: 'x',
	});
	expect(response.status).toBe(400);
	expect(gitRequests()).toHaveLength(0);
});

test('a declared body over the limit is refused before GitHub', async () => {
	const { paired, as, gitRequests } = await setup({ transferLimitBytes: 8 });
	const git = await paired();
	const response = await as(ALICE, git.uploadPack, {
		method: 'POST',
		headers: { 'content-type': UPLOAD_PACK },
		body: new Uint8Array(9),
	});
	expect(response.status).toBe(413);
	expect(gitRequests()).toHaveLength(0);
});

test('a streamed body that grows past the limit is cut off', async () => {
	const { paired, as } = await setup({ transferLimitBytes: 8 });
	const git = await paired();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(6));
			controller.enqueue(new Uint8Array(6));
			controller.close();
		},
	});
	const response = await as(ALICE, git.uploadPack, {
		method: 'POST',
		headers: { 'content-type': UPLOAD_PACK },
		body,
		duplex: 'half',
	} as RequestInit);
	expect(response.status).toBe(413);
	expect(response.headers.get(GIT_ERROR_HEADER)).toBe('payload_too_large');
});

test('a response that grows past the limit errors the stream', async () => {
	const { paired, as, github } = await setup({ transferLimitBytes: 8 });
	const git = await paired();
	github.gitBody = () =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(6));
				controller.enqueue(new Uint8Array(6));
				controller.close();
			},
		});
	const response = await as(ALICE, git.uploadRefs);
	expect(response.status).toBe(200);
	expect(response.arrayBuffer()).rejects.toThrow();
});

test('client cancellation reaches the upstream request and response', async () => {
	const { paired, as, runtime, github } = await setup();
	const git = await paired();
	let upstreamSignal: AbortSignal | undefined;
	let upstreamCancelled = false;
	github.gitBody = () =>
		new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(1));
			},
			cancel() {
				upstreamCancelled = true;
			},
		});
	const gitFetch = runtime.gitFetch;
	runtime.gitFetch = (input, init) => {
		upstreamSignal = init?.signal ?? undefined;
		return gitFetch(input, init);
	};
	const controller = new AbortController();
	const response = await as(ALICE, git.uploadRefs, {
		signal: controller.signal,
	});
	expect(response.status).toBe(200);
	controller.abort();
	expect(upstreamSignal?.aborted).toBe(true);
	await response.body?.cancel();
	// Cancellation crosses the pipe asynchronously.
	await Bun.sleep(1);
	expect(upstreamCancelled).toBe(true);
});

test('GitHub 403 and 404 on Git are repository_unavailable and keep state', async () => {
	const { paired, as, github, memory } = await setup();
	const git = await paired();
	for (const status of [403, 404]) {
		github.gitStatus = [status];
		const response = await as(ALICE, git.uploadRefs);
		expect(response.status).toBe(403);
		expect(response.headers.get(GIT_ERROR_HEADER)).toBe(
			'repository_unavailable',
		);
	}
	expect(memory.read(ALICE, 'grant')).toBeDefined();
});

test('GitHub outage and 5xx on Git are upstream_unavailable', async () => {
	const { paired, as, github } = await setup();
	const git = await paired();
	github.gitStatus = [502];
	const failed = await as(ALICE, git.uploadRefs);
	expect(failed.status).toBe(503);
	expect(failed.headers.get(GIT_ERROR_HEADER)).toBe('upstream_unavailable');
	github.offline = true;
	const offline = await as(ALICE, git.uploadRefs);
	expect(offline.status).toBe(503);
	expect(offline.headers.get(GIT_ERROR_HEADER)).toBe('upstream_unavailable');
});

test('a push whose outcome is unknown is upstream_unavailable and is not replayed', async () => {
	const { paired, as, runtime, gitRequests } = await setup();
	const git = await paired();
	const gitFetch = runtime.gitFetch;
	runtime.gitFetch = async (input, init) => {
		await gitFetch(input, init);
		throw new TypeError('connection reset after send');
	};
	const response = await as(ALICE, git.receivePack, {
		method: 'POST',
		headers: { 'content-type': RECEIVE_PACK },
		body: new Uint8Array([1]),
	});
	expect(response.status).toBe(503);
	expect(response.headers.get(GIT_ERROR_HEADER)).toBe('upstream_unavailable');
	expect(gitRequests()).toHaveLength(1);
});

test('a Git redirect is refused, never followed', async () => {
	const { paired, as, github, gitRequests } = await setup();
	const git = await paired();
	github.gitStatus = [301];
	const response = await as(ALICE, git.uploadRefs);
	expect(response.status).toBe(403);
	expect(response.headers.get(GIT_ERROR_HEADER)).toBe('repository_mismatch');
	expect(gitRequests()).toHaveLength(1);
});

test('an unexpected Git content type is upstream_rejected', async () => {
	const { paired, as, github } = await setup();
	const git = await paired();
	github.gitContentType = 'text/html';
	const response = await as(ALICE, git.uploadRefs);
	expect(response.status).toBe(502);
	expect(response.headers.get(GIT_ERROR_HEADER)).toBe('upstream_rejected');
});

test('a Git 401 for the scoped token is reported, not retried or refreshed', async () => {
	const { paired, as, github, gitRequests, basicToken } = await setup();
	const git = await paired();
	for (const [url, init] of [
		[git.uploadRefs, {}],
		[
			git.receivePack,
			{
				method: 'POST',
				headers: { 'content-type': RECEIVE_PACK },
				body: new Uint8Array([1]),
			},
		],
	] as const) {
		const sent = gitRequests().length;
		github.gitStatus = [401];
		const response = await as(ALICE, url, init);
		expect(response.status).toBe(403);
		expect(response.headers.get(GIT_ERROR_HEADER)).toBe(
			'scoped_token_rejected',
		);
		expect(gitRequests()).toHaveLength(sent + 1);
	}
	expect(github.refreshCalls).toBe(0);
	// The next request is admitted afresh with a new scoped token.
	const rejected = basicToken(gitRequests().at(-1)?.headers);
	expect((await as(ALICE, git.uploadRefs)).status).toBe(200);
	const fresh = basicToken(gitRequests().at(-1)?.headers);
	expect(fresh).not.toBe(rejected);
	expect(github.isScoped(fresh)).toBe(true);
});

test('a revoked GitHub grant is 403 github_authorization_required; the pairing stays', async () => {
	const { paired, as, github, memory, gitRequests } = await setup();
	const git = await paired();
	github.revokeAll();
	const response = await as(ALICE, git.uploadRefs);
	expect(response.status).toBe(403);
	expect(response.headers.get(GIT_ERROR_HEADER)).toBe(
		'github_authorization_required',
	);
	expect(response.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
	expect(gitRequests()).toHaveLength(0);
	expect(memory.read(ALICE, 'grant')).toBeUndefined();
	const { pairings } = (await (await as(ALICE, `${BASE}/pairings`)).json()) as {
		pairings: { status: string }[];
	};
	expect(pairings.map((p) => p.status)).toEqual([
		'github_authorization_required',
	]);
});

test('unsupported credential scoping is 503 and sends nothing to Git', async () => {
	const { paired, as, github, gitRequests } = await setup();
	const git = await paired();
	github.scopeMode = 'unexpected';
	const response = await as(ALICE, git.uploadRefs);
	expect(response.status).toBe(503);
	expect(response.headers.get(GIT_ERROR_HEADER)).toBe(
		'credential_scoping_unsupported',
	);
	expect(gitRequests()).toHaveLength(0);
});

// ============================================================================
// Repository-addressed Git relay
// ============================================================================

test('a repository path relays to the scoped clone URL with no pairing', async () => {
	const { connect, as, gitRequests, github, basicToken, memory } =
		await setup();
	await connect();
	const repo = repoPaths('alice', 'notes.git');
	const advertisement = await as(ALICE, repo.uploadRefs, {
		headers: { 'git-protocol': 'version=2' },
	});
	expect(advertisement.status).toBe(200);
	expect(advertisement.headers.get('content-type')).toBe(
		'application/x-git-upload-pack-advertisement',
	);
	const fetch = await as(ALICE, repo.uploadPack, {
		method: 'POST',
		headers: { 'content-type': UPLOAD_PACK },
		body: new Uint8Array([4, 5]),
	});
	expect(fetch.status).toBe(200);
	expect(fetch.headers.get('content-type')).toBe(
		'application/x-git-upload-pack-result',
	);

	const upstream = gitRequests();
	expect(upstream.map((r) => r.url)).toEqual([
		'https://github.com/alice/notes.git/info/refs?service=git-upload-pack',
		'https://github.com/alice/notes.git/git-upload-pack',
	]);
	for (const request of upstream) {
		const token = basicToken(request.headers);
		expect(github.isScoped(token)).toBe(true);
		expect(github.isParent(token)).toBe(false);
	}
	expect(upstream[1]?.body).toEqual(new Uint8Array([4, 5]));
	expect(memory.keys(ALICE).some((key) => key.startsWith('pairing:'))).toBe(
		false,
	);
});

test('a repository path outside the user’s reach is repository_unavailable', async () => {
	const { connect, as, gitRequests, scopeRequests } = await setup();
	await connect();
	for (const [owner, repo] of [
		['alice', 'missing.git'],
		['mallory', 'secret.git'],
		['alice', 'site.git'],
		['alice', 'readonly.git'],
	] as const) {
		const response = await as(ALICE, repoPaths(owner, repo).uploadRefs);
		expect(response.status).toBe(403);
		expect(response.headers.get(GIT_ERROR_HEADER)).toBe(
			'repository_unavailable',
		);
		expect(await response.json()).toMatchObject({ installUrl: INSTALL_URL });
	}
	// Only the public and read-only repositories are found by name and scoped.
	expect(scopeRequests()).toHaveLength(2);
	expect(gitRequests()).toHaveLength(0);
});

test('malformed owners and repository names are refused before GitHub', async () => {
	const { connect, as, github } = await setup();
	await connect();
	const before = github.requests.length;
	for (const [owner, repo] of [
		['alice', 'notes'],
		['alice', '.git'],
		['alice', '..git'],
		['alice', '...git'],
		['alice', 'no%20tes.git'],
		['alice', 'no%2Ftes.git'],
		['alice', `${'n'.repeat(101)}.git`],
		['-alice', 'notes.git'],
		['alice-', 'notes.git'],
		['al--ice', 'notes.git'],
		['al_ice', 'notes.git'],
		['a'.repeat(40), 'notes.git'],
	] as const) {
		const paths = repoPaths(owner, repo);
		for (const response of [
			await as(ALICE, paths.uploadRefs),
			await as(ALICE, paths.receivePack, {
				method: 'POST',
				headers: { 'content-type': RECEIVE_PACK },
				body: new Uint8Array([1]),
			}),
		]) {
			expect(response.status).toBe(400);
			expect(response.headers.get(GIT_ERROR_HEADER)).toBe('invalid_request');
		}
	}
	expect(github.requests).toHaveLength(before);
	// The longest valid shapes pass validation and reach GitHub.
	const longest = await as(
		ALICE,
		repoPaths('a'.repeat(39), `${'n'.repeat(100)}.git`).uploadRefs,
	);
	expect(longest.headers.get(GIT_ERROR_HEADER)).toBe('repository_unavailable');
});

test('repository paths keep the query rules of the pairing routes', async () => {
	const { connect, as, gitRequests } = await setup();
	await connect();
	const repo = repoPaths('alice', 'notes.git');
	for (const url of [
		`${repo.uploadRefs}&url=https://evil.test`,
		`${repo.base}/info/refs?service=git-upload-archive`,
		`${repo.base}/info/refs`,
		`${repo.uploadPack}?x=1`,
	])
		expect(
			(
				await as(ALICE, url, {
					method: url.includes('info/refs') ? 'GET' : 'POST',
				})
			).status,
		).toBe(400);
	expect(gitRequests()).toHaveLength(0);
});

test('a repository path without a GitHub grant is 403, not 401', async () => {
	const { as, gitRequests } = await setup();
	const response = await as(ALICE, repoPaths('alice', 'notes.git').uploadRefs);
	expect(response.status).toBe(403);
	expect(response.headers.get(GIT_ERROR_HEADER)).toBe(
		'github_authorization_required',
	);
	expect(gitRequests()).toHaveLength(0);
});

test('a malformed Git request is refused before admission calls GitHub', async () => {
	const { paired, as, github } = await setup();
	const pairing = await paired();
	const before = github.requests.length;
	for (const url of [
		pairing.receivePack,
		repoPaths('alice', 'notes.git').receivePack,
	]) {
		const response = await as(ALICE, url, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: new Uint8Array([1]),
		});
		expect(response.status).toBe(400);
	}
	// Give an admission started by mistake time to reach the provider.
	await Bun.sleep(50);
	expect(github.requests).toHaveLength(before);
});
