/**
 * GitHub App user-authorization and REST calls the connector needs, over an
 * injected `fetch`. Every failure collapses to a small set of provider
 * outcomes so callers can choose a status without reading provider bodies:
 *
 * - `rejected`: GitHub confirmed the code, token, or refresh token is invalid.
 * - `denied`: the credential is valid but cannot see or use the resource.
 * - `unavailable`: network failure, timeout, 5xx, rate limit, redirect, or a
 *   response the connector cannot interpret. Nothing is known about the
 *   credential.
 *
 * Credential scoping adds two outcomes of its own (see {@link ScopeFailure}).
 *
 * Provider bodies are never copied into results, so a token echoed by a
 * misbehaving upstream cannot reach a response or a log. No call follows a
 * redirect.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';

export type ProviderFailure = 'rejected' | 'denied' | 'unavailable';

/**
 * Why a scoped token could not be minted.
 *
 * - `rejected`: 404, which GitHub documents for an invalid parent token.
 * - `denied`: GitHub refused the target or repository for this user (422 or
 *   403): the installation does not cover it, the person lost access, or the
 *   repository id no longer exists.
 * - `unsupported`: any other status, or a 200 without a token or echoing the
 *   parent. The caller must refuse the transfer; it must never fall back to
 *   the parent token.
 * - `misconfigured`: GitHub rejected the client id and secret (401).
 * - `unavailable`: network failure, rate limit, or 5xx. Nothing is known
 *   about the parent token.
 */
export type ScopeFailure =
	| 'rejected'
	| 'denied'
	| 'unsupported'
	| 'misconfigured'
	| 'unavailable';

/** Fetch-compatible callable, without runtime-specific extras like `preconnect`. */
export type HttpFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export type GitHubAppCredentials = {
	clientId: string;
	clientSecret: string;
	/** Public app slug; enables the installation link on access failures. */
	appSlug?: string;
};

export type TokenGrant = {
	accessToken: string;
	refreshToken: string | null;
	/** Epoch ms; null when the app issues non-expiring user tokens. */
	accessExpiresAt: number | null;
	refreshExpiresAt: number | null;
};

export type GitHubUser = { id: number; login: string };

/** An installation of this GitHub App that the user can reach. */
export type InstallationView = {
	id: number;
	/** The user or organization the app is installed on: `target_id` for scoping. */
	account: { id: number; login: string };
};

/** A repository as one user sees it through one installation. */
export type RepositoryView = {
	id: number;
	ownerId: number;
	fullName: string;
	cloneUrl: string;
	defaultBranch: string;
	private: boolean;
	pull: boolean;
	push: boolean;
};

export type GitHubClient = ReturnType<typeof createGitHubClient>;

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_ORIGIN = 'https://api.github.com';
const USER_AGENT = 'epicenter-git-connector';
const PROVIDER_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
/** Listing stops after this many pages per call (1,000 items). */
const MAX_PAGES = 10;

/** Token endpoint errors that mean the presented code or refresh token is dead. */
const REJECTED_GRANT_ERRORS = new Set([
	'bad_verification_code',
	'bad_refresh_token',
	'invalid_grant',
]);

export function createGitHubClient({
	app,
	fetch: providerFetch,
	now,
}: {
	app: GitHubAppCredentials;
	fetch: HttpFetch;
	now: () => number;
}) {
	async function call(
		url: string,
		init: RequestInit,
	): Promise<Response | undefined> {
		try {
			return await providerFetch(url, {
				...init,
				redirect: 'manual',
				signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			});
		} catch {
			return undefined;
		}
	}

	async function token(
		fields: Record<string, string>,
	): Promise<Result<TokenGrant, ProviderFailure>> {
		const response = await call(TOKEN_URL, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded',
				'user-agent': USER_AGENT,
			},
			body: new URLSearchParams({
				client_id: app.clientId,
				client_secret: app.clientSecret,
				...fields,
			}),
		});
		if (response?.status !== 200) return Err('unavailable');
		const body = await readJson(response);
		if (!body) return Err('unavailable');
		// GitHub reports grant errors as 200 with an `error` field.
		if (typeof body.error === 'string')
			return Err(
				REJECTED_GRANT_ERRORS.has(body.error) ? 'rejected' : 'unavailable',
			);
		if (typeof body.access_token !== 'string' || !body.access_token)
			return Err('unavailable');
		const issuedAt = now();
		const seconds = (value: unknown) =>
			typeof value === 'number' && value > 0 ? issuedAt + value * 1000 : null;
		return Ok({
			accessToken: body.access_token,
			refreshToken:
				typeof body.refresh_token === 'string' && body.refresh_token
					? body.refresh_token
					: null,
			accessExpiresAt: seconds(body.expires_in),
			refreshExpiresAt: seconds(body.refresh_token_expires_in),
		});
	}

	async function api(
		path: string,
		accessToken: string,
	): Promise<Result<Record<string, unknown>, ProviderFailure>> {
		const response = await call(`${API_ORIGIN}${path}`, {
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${accessToken}`,
				'user-agent': USER_AGENT,
				'x-github-api-version': '2022-11-28',
			},
		});
		if (!response) return Err('unavailable');
		if (response.status === 401) return discard(response, 'rejected');
		if (isRateLimited(response)) return discard(response, 'unavailable');
		if (response.status === 403 || response.status === 404)
			return discard(response, 'denied');
		if (response.status !== 200) return discard(response, 'unavailable');
		const body = await readJson(response);
		return body ? Ok(body) : Err('unavailable');
	}

	/** Read up to {@link MAX_PAGES} pages of a list wrapped in `{ [field]: [...] }`. */
	async function pages(
		path: string,
		field: string,
		accessToken: string,
	): Promise<Result<unknown[], ProviderFailure>> {
		const items: unknown[] = [];
		for (let page = 1; page <= MAX_PAGES; page++) {
			const separator = path.includes('?') ? '&' : '?';
			const { data: body, error } = await api(
				`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
				accessToken,
			);
			if (error) return Err(error);
			const list = body[field];
			if (!Array.isArray(list)) return Err('unavailable');
			items.push(...list);
			if (list.length < PAGE_SIZE) break;
		}
		return Ok(items);
	}

	return {
		/** Where to send the person, with the connector's own state and PKCE challenge. */
		authorizeUrl({
			state,
			challenge,
			redirectUri,
		}: {
			state: string;
			challenge: string;
			redirectUri: string;
		}): string {
			const url = new URL(AUTHORIZE_URL);
			url.searchParams.set('client_id', app.clientId);
			url.searchParams.set('redirect_uri', redirectUri);
			url.searchParams.set('state', state);
			url.searchParams.set('code_challenge', challenge);
			url.searchParams.set('code_challenge_method', 'S256');
			url.searchParams.set('allow_signup', 'false');
			return url.toString();
		},

		/** GitHub App installation page, when the app slug is configured. */
		installUrl: app.appSlug
			? `https://github.com/apps/${encodeURIComponent(app.appSlug)}/installations/new`
			: undefined,

		exchangeCode(input: {
			code: string;
			verifier: string;
			redirectUri: string;
		}) {
			return token({
				code: input.code,
				code_verifier: input.verifier,
				redirect_uri: input.redirectUri,
			});
		},

		refresh(refreshToken: string) {
			return token({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
			});
		},

		/** The person behind a token. A 401 here means the grant is gone. */
		async user(
			accessToken: string,
		): Promise<Result<GitHubUser, ProviderFailure>> {
			const { data: body, error } = await api('/user', accessToken);
			if (error) return Err(error);
			if (
				typeof body.id !== 'number' ||
				typeof body.login !== 'string' ||
				!body.login
			)
				return Err('unavailable');
			return Ok({ id: body.id, login: body.login });
		},

		/** `GET /user/installations`: this app's installations the user can reach. */
		async installations(
			accessToken: string,
		): Promise<Result<InstallationView[], ProviderFailure>> {
			const { data: list, error } = await pages(
				'/user/installations',
				'installations',
				accessToken,
			);
			if (error) return Err(error);
			const installations: InstallationView[] = [];
			for (const item of list) {
				const installation = parseInstallation(item);
				if (!installation) return Err('unavailable');
				installations.push(installation);
			}
			return Ok(installations);
		},

		/**
		 * `GET /user/installations/{id}/repositories`: repositories the user can
		 * reach through one installation, with that user's permissions. A
		 * repository-scoped token still lists the whole installation, so the
		 * list is discovery, not evidence of what a token can access.
		 */
		async installationRepositories(
			accessToken: string,
			installationId: number,
		): Promise<Result<RepositoryView[], ProviderFailure>> {
			const { data: list, error } = await pages(
				`/user/installations/${installationId}/repositories`,
				'repositories',
				accessToken,
			);
			if (error) return Err(error);
			const repositories: RepositoryView[] = [];
			for (const item of list) {
				const repository = parseRepository(item);
				if (!repository) return Err('unavailable');
				repositories.push(repository);
			}
			return Ok(repositories);
		},

		/**
		 * `GET /repositories/{id}`: one repository by immutable id, as the
		 * token's own access sees it. The caller validates the returned identity
		 * and permissions before admitting a transfer.
		 */
		async repository(
			accessToken: string,
			repositoryId: number,
		): Promise<Result<RepositoryView, ProviderFailure>> {
			const { data: body, error } = await api(
				`/repositories/${repositoryId}`,
				accessToken,
			);
			if (error) return Err(error);
			const repository = parseRepository(body);
			return repository ? Ok(repository) : Err('unavailable');
		},

		/**
		 * `GET /repos/{owner}/{repo}`: one repository by its mutable owner and
		 * name, as the token's own access sees it. A name only locates a
		 * repository; the caller decides access by the returned id. GitHub
		 * answers a renamed repository's old name with a redirect, which is not
		 * followed and reads as `unavailable`.
		 */
		async repositoryByName(
			accessToken: string,
			owner: string,
			name: string,
		): Promise<Result<RepositoryView, ProviderFailure>> {
			const { data: body, error } = await api(
				`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
				accessToken,
			);
			if (error) return Err(error);
			const repository = parseRepository(body);
			return repository ? Ok(repository) : Err('unavailable');
		},

		/**
		 * `POST /applications/{client_id}/token/scoped` with client Basic auth:
		 * mint a user token limited to one repository id under one target
		 * account, with Contents write. Returns the scoped token, or a failure;
		 * never the parent token.
		 */
		async scopeToken({
			accessToken,
			targetId,
			repositoryId,
		}: {
			accessToken: string;
			targetId: number;
			repositoryId: number;
		}): Promise<Result<string, ScopeFailure>> {
			const response = await call(
				`${API_ORIGIN}/applications/${encodeURIComponent(app.clientId)}/token/scoped`,
				{
					method: 'POST',
					headers: {
						accept: 'application/vnd.github+json',
						authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`,
						'content-type': 'application/json',
						'user-agent': USER_AGENT,
						'x-github-api-version': '2022-11-28',
					},
					body: JSON.stringify({
						access_token: accessToken,
						target_id: targetId,
						repository_ids: [repositoryId],
						permissions: { contents: 'write' },
					}),
				},
			);
			if (!response) return Err('unavailable');
			if (response.status === 401) return discard(response, 'misconfigured');
			if (response.status === 404) return discard(response, 'rejected');
			if (isRateLimited(response) || response.status >= 500)
				return discard(response, 'unavailable');
			if (response.status === 403 || response.status === 422)
				return discard(response, 'denied');
			if (response.status !== 200) return discard(response, 'unsupported');
			const body = await readJson(response);
			const scoped = body?.token;
			// A missing token, or the parent echoed back, proves no narrowing.
			if (typeof scoped !== 'string' || !scoped || scoped === accessToken)
				return Err('unsupported');
			return Ok(scoped);
		},
	};
}

function parseInstallation(value: unknown): InstallationView | undefined {
	if (!isObject(value) || typeof value.id !== 'number') return undefined;
	const account = value.account;
	if (
		!isObject(account) ||
		typeof account.id !== 'number' ||
		typeof account.login !== 'string'
	)
		return undefined;
	return { id: value.id, account: { id: account.id, login: account.login } };
}

function parseRepository(value: unknown): RepositoryView | undefined {
	if (!isObject(value)) return undefined;
	const owner = value.owner;
	const permissions = isObject(value.permissions) ? value.permissions : {};
	if (
		typeof value.id !== 'number' ||
		!isObject(owner) ||
		typeof owner.id !== 'number' ||
		typeof value.full_name !== 'string' ||
		typeof value.clone_url !== 'string' ||
		typeof value.private !== 'boolean'
	)
		return undefined;
	return {
		id: value.id,
		ownerId: owner.id,
		fullName: value.full_name,
		cloneUrl: value.clone_url,
		defaultBranch:
			typeof value.default_branch === 'string' ? value.default_branch : 'main',
		private: value.private,
		pull: permissions.pull === true,
		push: permissions.push === true,
	};
}

function isRateLimited(response: Response): boolean {
	if (response.status === 429) return true;
	return (
		response.status === 403 &&
		(response.headers.get('x-ratelimit-remaining') === '0' ||
			response.headers.has('retry-after'))
	);
}

async function discard<E>(response: Response, error: E): Promise<Err<E>> {
	await response.body?.cancel();
	return Err(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(
	response: Response,
): Promise<Record<string, unknown> | undefined> {
	try {
		const body: unknown = await response.json();
		return isObject(body) ? body : undefined;
	} catch {
		return undefined;
	}
}
