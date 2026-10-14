/**
 * Test-only harness for the GitHub connector: in-memory connection objects
 * keyed by principal, and a simulated GitHub reached through an injected
 * `fetch`. Production code never imports this module, and no deployment
 * setting selects it.
 *
 * The simulated provider follows the connector's documented assumptions
 * about GitHub (see README "External assumptions"); passing tests prove the
 * connector against those assumptions, not against GitHub itself.
 */
import type { ConnectionDirectory, GitHubConnectorRuntime } from './app.js';
import {
	type Connection,
	type ConnectionStorage,
	createGitHubConnection,
} from './connection.js';
import { importSealKey, pkceChallenge } from './crypto.js';
import { createGitHubClient, type HttpFetch } from './github.js';

export const API_ORIGIN = 'https://api.test';
export const APP_ORIGIN = 'https://zhongwen.bradenwong.com';
export const APP_CALLBACK = `${APP_ORIGIN}/sync`;
export const CLIENT_ID = 'Iv1.connectorclient';
export const CLIENT_SECRET = 'connector-client-secret';
export const APP_SLUG = 'epicenter-git';
export const INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;
export const ACCESS_TTL_S = 8 * 60 * 60;
export const REFRESH_TTL_S = 15_897_600;

export type FakeUser = { id: number; login: string };

type Permission = 'read' | 'write';

type FakeRepository = {
	id: number;
	owner: FakeUser;
	name: string;
	private: boolean;
	defaultBranch: string;
	access: Map<number, Permission>;
};

type FakeInstallation = {
	id: number;
	account: FakeUser;
	repositoryIds: Set<number>;
};

type Issued = {
	user: FakeUser;
	access: string;
	refresh: string;
	accessExpiresAt: number;
};

type Scoped = { token: string; parent: string; repositoryId: number };

type RecordedRequest = {
	method: string;
	url: string;
	headers: Headers;
	body?: Uint8Array;
};

/** Mutable time shared by the fake provider and the connection core. */
export function createClock(start = Date.UTC(2026, 9, 7)) {
	let current = start;
	return {
		now: () => current,
		advance(ms: number) {
			current += ms;
		},
	};
}

/**
 * GitHub's authorize, token, scoped-token, REST, and Git smart-HTTP
 * endpoints, enough to exercise every connector branch.
 *
 * A scoped token reaches only its repository through `GET /repositories/{id}`
 * and `GET /repos/{owner}/{repo}` (404 elsewhere) and Git (403 elsewhere),
 * but installation listings still show every repository the user can see,
 * as GitHub was observed to do.
 *
 * Seeded world:
 * - `alice` (101) installed the app on her account (installation 7001) with
 *   `alice/notes` (9001, private, write), `alice/site` (9002, public, write),
 *   `alice/readonly` (9003, private, read only for alice; bob writes), and
 *   `alice/journal` (9004, private, write).
 * - `mallory` (666) installed it on hers (7002) with `mallory/secret` (9100).
 * - `bob` (202) has no installation of his own.
 */
export function createFakeGitHub(clock: { now(): number }) {
	const alice: FakeUser = { id: 101, login: 'alice' };
	const mallory: FakeUser = { id: 666, login: 'mallory' };
	const bob: FakeUser = { id: 202, login: 'bob' };

	const codes = new Map<
		string,
		{ user: FakeUser; challenge: string; redirectUri: string }
	>();
	const tokens = new Map<string, Issued>();
	const refreshTokens = new Map<string, Issued>();
	const scoped = new Map<string, Scoped>();
	const repositories = new Map<number, FakeRepository>();
	const installations = new Map<number, FakeInstallation>();
	let serial = 0;

	const fake = {
		alice,
		mallory,
		bob,
		repositories,
		installations,
		/** Every request the connector sent, in order. */
		requests: [] as RecordedRequest[],
		refreshCalls: 0,
		/** Throw from fetch, like a dropped connection. */
		offline: false,
		/** Hold refresh responses until released, to overlap callers. */
		refreshGate: undefined as Promise<void> | undefined,
		/** Issue tokens without expiry or refresh token. */
		nonExpiring: false,
		/** The user a refreshed token identifies as. */
		refreshAs: undefined as FakeUser | undefined,
		/**
		 * How the scoped-token endpoint behaves: `supported` follows the
		 * documented contract (404 for an invalid parent, 422 for an unreachable
		 * target); `unexpected` is a 400 the contract does not describe;
		 * `empty` is a 200 without a token; `echo` returns the parent token.
		 */
		scopeMode: 'supported' as 'supported' | 'unexpected' | 'empty' | 'echo',
		/** Runs as a scoping request arrives, to race it with other events. */
		beforeScope: undefined as (() => void) | undefined,
		/** Overrides the Git endpoint response status for the next N requests. */
		gitStatus: [] as number[],
		/** Body returned by Git endpoints, defaulting to a small payload. */
		gitBody: (_service: string): BodyInit => new Uint8Array([1, 2, 3]),
		gitContentType: undefined as string | undefined,

		addRepository(input: {
			id: number;
			owner: FakeUser;
			name: string;
			installationId: number;
			private?: boolean;
			access?: [FakeUser, Permission][];
		}) {
			repositories.set(input.id, {
				id: input.id,
				owner: input.owner,
				name: input.name,
				private: input.private ?? true,
				defaultBranch: 'main',
				access: new Map(
					(input.access ?? [[input.owner, 'write']]).map(([user, level]) => [
						user.id,
						level,
					]),
				),
			});
			let installation = installations.get(input.installationId);
			if (!installation) {
				installation = {
					id: input.installationId,
					account: input.owner,
					repositoryIds: new Set(),
				};
				installations.set(input.installationId, installation);
			}
			installation.repositoryIds.add(input.id);
		},

		/** Delete a repository and create a different one at the same path. */
		replaceRepository(oldId: number, newId: number) {
			const old = repositories.get(oldId);
			if (!old) throw new Error('no such repository');
			repositories.delete(oldId);
			for (const installation of installations.values())
				installation.repositoryIds.delete(oldId);
			fake.addRepository({
				id: newId,
				owner: old.owner,
				name: old.name,
				installationId: [...installations.values()].find(
					(i) => i.account.id === old.owner.id,
				)?.id as number,
				access: [...old.access].map(([userId, level]) => [
					[alice, mallory, bob].find((u) => u.id === userId) as FakeUser,
					level,
				]),
			});
		},

		/** Uninstall and reinstall the app: same account and repositories, new id. */
		reinstall(oldId: number, newId: number) {
			const installation = installations.get(oldId);
			if (!installation) throw new Error('no such installation');
			installations.delete(oldId);
			installations.set(newId, { ...installation, id: newId });
		},

		/** Simulate the person approving the app; returns GitHub's callback URL. */
		async approve(authorizeUrl: string, user: FakeUser = alice) {
			const url = new URL(authorizeUrl);
			const code = `code-${++serial}`;
			codes.set(code, {
				user,
				challenge: url.searchParams.get('code_challenge') ?? '',
				redirectUri: url.searchParams.get('redirect_uri') ?? '',
			});
			const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
			callback.searchParams.set('code', code);
			callback.searchParams.set('state', url.searchParams.get('state') ?? '');
			return callback.toString();
		},

		/** Revoke every token GitHub issued, as a person revoking the app would. */
		revokeAll() {
			tokens.clear();
			refreshTokens.clear();
			scoped.clear();
		},

		/** Fail every access token without touching its refresh token. */
		expireAccessTokens() {
			tokens.clear();
			scoped.clear();
		},

		/** Whether a token is a scoped token this fake issued. */
		isScoped: (token: string) => scoped.has(token),
		/** Whether a token is a parent user token this fake issued. */
		isParent: (token: string) => tokens.has(token),

		fetch: (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const request = new Request(input, init);
			const body =
				request.method === 'POST'
					? new Uint8Array(await request.arrayBuffer())
					: undefined;
			fake.requests.push({
				method: request.method,
				url: request.url,
				headers: request.headers,
				body,
			});
			if (fake.offline) throw new TypeError('network unavailable');
			const url = new URL(request.url);
			if (url.href === 'https://github.com/login/oauth/access_token')
				return token(new URLSearchParams(new TextDecoder().decode(body)));
			if (
				request.method === 'POST' &&
				url.href ===
					`https://api.github.com/applications/${CLIENT_ID}/token/scoped`
			)
				return scope(request, body);
			if (url.origin === 'https://api.github.com') return api(request, url);
			if (url.origin === 'https://github.com') return git(request, url);
			return new Response('unknown host', { status: 599 });
		}) as HttpFetch,
	};

	fake.addRepository({
		id: 9001,
		owner: alice,
		name: 'notes',
		installationId: 7001,
	});
	fake.addRepository({
		id: 9002,
		owner: alice,
		name: 'site',
		installationId: 7001,
		private: false,
	});
	fake.addRepository({
		id: 9003,
		owner: alice,
		name: 'readonly',
		installationId: 7001,
		access: [
			[alice, 'read'],
			[bob, 'write'],
		],
	});
	fake.addRepository({
		id: 9004,
		owner: alice,
		name: 'journal',
		installationId: 7001,
	});
	fake.addRepository({
		id: 9100,
		owner: mallory,
		name: 'secret',
		installationId: 7002,
	});

	function issue(user: FakeUser): Issued {
		const n = ++serial;
		const issued: Issued = {
			user,
			access: `ghu_access_${n}`,
			refresh: `ghr_refresh_${n}`,
			accessExpiresAt: clock.now() + ACCESS_TTL_S * 1000,
		};
		tokens.set(issued.access, issued);
		refreshTokens.set(issued.refresh, issued);
		return issued;
	}

	function grantBody(issued: Issued) {
		return Response.json(
			fake.nonExpiring
				? { access_token: issued.access, token_type: 'bearer', scope: '' }
				: {
						access_token: issued.access,
						expires_in: ACCESS_TTL_S,
						refresh_token: issued.refresh,
						refresh_token_expires_in: REFRESH_TTL_S,
						token_type: 'bearer',
						scope: '',
					},
		);
	}

	async function token(form: URLSearchParams) {
		if (
			form.get('client_id') !== CLIENT_ID ||
			form.get('client_secret') !== CLIENT_SECRET
		)
			return Response.json({ error: 'incorrect_client_credentials' });
		if (form.get('grant_type') === 'refresh_token') {
			fake.refreshCalls++;
			if (fake.refreshGate) await fake.refreshGate;
			const previous = refreshTokens.get(form.get('refresh_token') ?? '');
			if (!previous) return Response.json({ error: 'bad_refresh_token' });
			// GitHub rotates: the old pair stops working.
			refreshTokens.delete(previous.refresh);
			tokens.delete(previous.access);
			return grantBody(issue(fake.refreshAs ?? previous.user));
		}
		const grant = codes.get(form.get('code') ?? '');
		codes.delete(form.get('code') ?? '');
		if (
			!grant ||
			grant.redirectUri !== form.get('redirect_uri') ||
			grant.challenge !== (await pkceChallenge(form.get('code_verifier') ?? ''))
		)
			return Response.json({ error: 'bad_verification_code' });
		return grantBody(issue(grant.user));
	}

	function liveParent(value: string | undefined): Issued | undefined {
		const issued = value ? tokens.get(value) : undefined;
		if (!issued) return undefined;
		if (!fake.nonExpiring && issued.accessExpiresAt <= clock.now())
			return undefined;
		return issued;
	}

	/** A parent or scoped token, with the repositories it may see. */
	function bearer(
		value: string | undefined,
	): { user: FakeUser; only?: number } | undefined {
		const scope = value ? scoped.get(value) : undefined;
		if (scope) {
			const parent = liveParent(scope.parent);
			return parent && { user: parent.user, only: scope.repositoryId };
		}
		const parent = liveParent(value);
		return parent && { user: parent.user };
	}

	function canSee(user: FakeUser, repository: FakeRepository) {
		return repository.access.has(user.id);
	}

	function repositoryJson(repository: FakeRepository, user: FakeUser) {
		const level = repository.access.get(user.id);
		return {
			id: repository.id,
			name: repository.name,
			full_name: `${repository.owner.login}/${repository.name}`,
			owner: { id: repository.owner.id, login: repository.owner.login },
			private: repository.private,
			clone_url: `https://github.com/${repository.owner.login}/${repository.name}.git`,
			default_branch: repository.defaultBranch,
			permissions: { pull: level !== undefined, push: level === 'write' },
		};
	}

	function visibleInstallations(user: FakeUser) {
		return [...installations.values()].filter((installation) =>
			[...installation.repositoryIds].some((id) => {
				const repository = repositories.get(id);
				return repository && canSee(user, repository);
			}),
		);
	}

	async function scope(request: Request, body: Uint8Array | undefined) {
		if (
			request.headers.get('authorization') !==
			`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`
		)
			return Response.json(
				{ message: 'Requires authentication' },
				{ status: 401 },
			);
		fake.beforeScope?.();
		if (fake.scopeMode === 'unexpected')
			return Response.json({ message: 'Bad Request' }, { status: 400 });
		const input = JSON.parse(new TextDecoder().decode(body)) as {
			access_token?: string;
			target_id?: number;
			repository_ids?: number[];
			permissions?: Record<string, string>;
		};
		const parent = liveParent(input.access_token);
		// GitHub documents invalid tokens as 404 on this endpoint.
		if (!parent)
			return Response.json({ message: 'Not Found' }, { status: 404 });
		if (fake.scopeMode === 'empty') return Response.json({ id: 1 });
		if (fake.scopeMode === 'echo')
			return Response.json({ token: input.access_token });
		const [repositoryId, ...extra] = input.repository_ids ?? [];
		const repository =
			repositoryId === undefined ? undefined : repositories.get(repositoryId);
		const installation = [...installations.values()].find(
			(candidate) => candidate.account.id === input.target_id,
		);
		if (
			extra.length ||
			!repository ||
			!installation?.repositoryIds.has(repository.id) ||
			!canSee(parent.user, repository) ||
			input.permissions?.contents !== 'write'
		)
			return Response.json({ message: 'Validation Failed' }, { status: 422 });
		const token = `ghu_scoped_${++serial}`;
		scoped.set(token, {
			token,
			parent: parent.access,
			repositoryId: repository.id,
		});
		return Response.json({
			id: serial,
			token,
			token_last_eight: token.slice(-8),
		});
	}

	function api(request: Request, url: URL) {
		const presented = request.headers
			.get('authorization')
			?.replace(/^Bearer /, '');
		const caller = bearer(presented);
		if (!caller)
			return Response.json({ message: 'Bad credentials' }, { status: 401 });
		const page = Number(url.searchParams.get('page') ?? 1);
		if (url.pathname === '/user')
			return Response.json({ id: caller.user.id, login: caller.user.login });
		if (url.pathname === '/user/installations') {
			const list = page === 1 ? visibleInstallations(caller.user) : [];
			return Response.json({
				total_count: list.length,
				installations: list.map((i) => ({
					id: i.id,
					account: { id: i.account.id, login: i.account.login },
				})),
			});
		}
		const match = url.pathname.match(
			/^\/user\/installations\/(\d+)\/repositories$/,
		);
		if (match) {
			const installation = installations.get(Number(match[1]));
			if (
				!installation ||
				!visibleInstallations(caller.user).includes(installation)
			)
				return Response.json({ message: 'Not Found' }, { status: 404 });
			// Listing ignores a token's repository scope, as GitHub was observed
			// to: a scoped token still lists the whole installation.
			const list =
				page === 1
					? [...installation.repositoryIds]
							.map((id) => repositories.get(id))
							.filter((r): r is FakeRepository => !!r && canSee(caller.user, r))
					: [];
			return Response.json({
				total_count: list.length,
				repositories: list.map((r) => repositoryJson(r, caller.user)),
			});
		}
		const byId = url.pathname.match(/^\/repositories\/(\d+)$/);
		if (byId) {
			const repository = repositories.get(Number(byId[1]));
			if (!repository || !reaches(caller, repository))
				return Response.json({ message: 'Not Found' }, { status: 404 });
			return Response.json(repositoryJson(repository, caller.user));
		}
		// Owner and name match case-insensitively, as on GitHub.
		const byName = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
		if (byName) {
			const [owner = '', name = ''] = byName
				.slice(1)
				.map((part) => decodeURIComponent(part).toLowerCase());
			const repository = [...repositories.values()].find(
				(r) =>
					r.owner.login.toLowerCase() === owner &&
					r.name.toLowerCase() === name,
			);
			if (!repository || !reaches(caller, repository))
				return Response.json({ message: 'Not Found' }, { status: 404 });
			return Response.json(repositoryJson(repository, caller.user));
		}
		return Response.json({ message: 'Not Found' }, { status: 404 });
	}

	/** Actual access: the user's, further limited to a scoped token's repository. */
	function reaches(
		caller: { user: FakeUser; only?: number },
		repository: FakeRepository,
	) {
		return (
			canSee(caller.user, repository) &&
			(caller.only === undefined || caller.only === repository.id)
		);
	}

	function git(request: Request, url: URL) {
		const forced = fake.gitStatus.shift();
		if (forced) return new Response('forced', { status: forced });
		const basic = request.headers.get('authorization')?.replace(/^Basic /, '');
		const [username, password] = basic ? atob(basic).split(':') : [];
		const caller = username === 'x-access-token' ? bearer(password) : undefined;
		const path = url.pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
		const repository = [...repositories.values()].find(
			(r) => r.owner.login === path?.[1] && r.name === path?.[2],
		);
		if (!caller || !repository || !canSee(caller.user, repository))
			return new Response('auth', {
				status: 401,
				headers: { 'www-authenticate': 'Basic realm="GitHub"' },
			});
		// A valid scoped token is refused outside its repository, as observed.
		if (!reaches(caller, repository))
			return new Response('forbidden', { status: 403 });
		const service =
			path?.[3] === 'info/refs' ? url.searchParams.get('service') : path?.[3];
		const kind = path?.[3] === 'info/refs' ? 'advertisement' : 'result';
		return new Response(fake.gitBody(service ?? ''), {
			status: 200,
			headers: {
				'content-type':
					fake.gitContentType ?? `application/x-${service}-${kind}`,
				'set-cookie': 'logged_in=yes',
				'x-github-request-id': 'fixture',
			},
		});
	}

	return fake;
}

export type FakeGitHub = ReturnType<typeof createFakeGitHub>;

/**
 * Connection objects backed by Maps, one core per id like one Durable Object
 * instance per id. `stores` is the whole persistent state; an object that
 * never wrote has no entry.
 */
export function createMemoryConnections({
	sealKey,
	github,
	now,
}: {
	sealKey: CryptoKey;
	github: FakeGitHub;
	now: () => number;
}) {
	const stores = new Map<string, Map<string, unknown>>();
	const alarms = new Map<string, number | undefined>();
	const instances = new Map<string, Connection>();
	const client = createGitHubClient({
		app: {
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			appSlug: APP_SLUG,
		},
		// Read the field per call so a test can wrap `github.fetch` mid-run.
		fetch: (input, init) => github.fetch(input, init),
		now,
	});
	const storage = (id: string): ConnectionStorage => ({
		get: async (key) => structuredClone(stores.get(id)?.get(key)) as never,
		async put(key, value) {
			const store = stores.get(id) ?? new Map<string, unknown>();
			stores.set(id, store);
			store.set(key, structuredClone(value));
		},
		async delete(key) {
			stores.get(id)?.delete(key);
		},
		list: async <T>(prefix: string) =>
			new Map(
				[...(stores.get(id) ?? [])]
					.filter(([key]) => key.startsWith(prefix))
					.map(([key, value]) => [key, structuredClone(value) as T]),
			),
		async schedule(at) {
			alarms.set(id, at);
		},
	});
	const instance = (id: string) => {
		let connection = instances.get(id);
		if (!connection) {
			connection = createGitHubConnection({
				id,
				sealKey,
				github: client,
				now,
				storage: storage(id),
			});
			instances.set(id, connection);
		}
		return connection;
	};
	const objectId = (principalId: string) =>
		new Bun.CryptoHasher('sha256')
			.update(`principal:${principalId}`)
			.digest('hex');
	const directory: ConnectionDirectory = {
		forPrincipal(principalId) {
			const id = objectId(principalId);
			return { id, connection: instance(id) };
		},
		open: (id) => (/^[0-9a-f]{64}$/.test(id) ? instance(id) : undefined),
	};
	/** Stored keys for one principal's object, for assertions. */
	const keys = (principalId: string) => [
		...(stores.get(objectId(principalId))?.keys() ?? []),
	];
	const read = (principalId: string, key: string) =>
		stores.get(objectId(principalId))?.get(key);
	return { stores, alarms, directory, instance, objectId, keys, read };
}

export async function testSealKey(): Promise<CryptoKey> {
	const key = await importSealKey(
		btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
	);
	if (!key) throw new Error('fixture key failed to import');
	return key;
}

export async function createFixtureRuntime({
	transferLimitBytes,
}: {
	transferLimitBytes?: number;
} = {}) {
	const clock = createClock();
	const github = createFakeGitHub(clock);
	const memory = createMemoryConnections({
		sealKey: await testSealKey(),
		github,
		now: clock.now,
	});
	const runtime: GitHubConnectorRuntime = {
		apiOrigin: API_ORIGIN,
		callbacks: [APP_CALLBACK],
		connections: memory.directory,
		gitFetch: (input, init) => github.fetch(input, init),
		transferLimitBytes,
	};
	return { clock, github, memory, runtime };
}
