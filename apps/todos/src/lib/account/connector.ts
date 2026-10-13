/**
 * The hosted GitHub connector (`apps/api/worker/git-connector`), as Todos
 * calls it from the browser. Every request goes through the signed-in
 * `Account`'s own `fetch`, which adds the Epicenter bearer, so no credential
 * is held here, put in a URL, or written to the folder's Git configuration.
 *
 * Git transfers keep the canonical clone URL the pairing recorded as the
 * folder's remote. `relayFetch` rewrites each smart-HTTP request at request
 * time to the pinned pairing revision's relay path, and forwards only the
 * headers the connector admits.
 *
 * Browser-only: reached through `#platform/start`, never from the desktop
 * build.
 */
import type { Account } from '@epicenter/auth';
import type { HttpFetch } from '@epicenter/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';

export const CONNECTOR_PATH = '/api/git/github';
/** Where a person installs the GitHub App on a repository. Public metadata. */
export const GITHUB_APP_URL = 'https://github.com/apps/epicenter-folder-sync';
const GIT_ERROR_HEADER = 'x-epicenter-git-error';

/** The part of an `Account` the connector uses. */
export type ConnectorAccount = Pick<
	Account,
	'authorityId' | 'principalId' | 'baseURL' | 'fetch'
>;

/** A private repository the GitHub App reaches for the connected GitHub user. */
export type Repository = {
	readonly id: number;
	readonly installationId: number;
	readonly fullName: string;
	readonly cloneUrl: string;
	readonly defaultBranch: string;
	/** Whether the user can push; pairing requires it. */
	readonly push: boolean;
};

/**
 * One folder's pairing, pinned at its revision. `status` compares the stored
 * GitHub grant with the user who paired it: `ready`,
 * `github_authorization_required`, or `github_account_mismatch`.
 */
export type Pairing = {
	readonly folderId: string;
	readonly revision: string;
	readonly status: string;
	readonly repository: {
		readonly id: number;
		readonly installationId: number;
		readonly fullName: string;
	};
	readonly remote: { readonly url: string; readonly branch: string };
};

/** What a person is told for each connector code. ASCII, so it fits an HTTP reason phrase. */
const CODE_MESSAGES: Record<string, string> = {
	github_authorization_required:
		'GitHub is not connected for your account, or the connection expired. Connect GitHub again.',
	github_account_mismatch:
		'This repository was chosen with a different GitHub account than the one connected now. Connect that GitHub account again.',
	repository_unavailable:
		'GitHub does not let Epicenter reach this private repository with write access. Check that the Epicenter Folder Sync app is installed on it.',
	repository_mismatch:
		'GitHub redirected the repository request, so it stopped.',
	scoped_token_rejected:
		'GitHub refused this request. Try again; each request gets a new repository token.',
	pairing_not_found: 'Todos is not connected to a repository for your account.',
	pairing_conflict:
		'Todos is already connected to another repository for your account.',
	pairing_superseded:
		'Todos was connected to a repository again elsewhere. Reload to use the current connection.',
	access_denied: 'GitHub authorization was declined.',
	authorization_failed: 'GitHub authorization failed. Connect GitHub again.',
	invalid_grant:
		'This GitHub connection attempt expired or was already used. Connect GitHub again.',
	payload_too_large: 'This transfer is larger than Epicenter relays.',
	upstream_rejected: 'GitHub answered in a way Epicenter does not accept.',
	credential_scoping_unsupported:
		'GitHub did not issue a token limited to this repository, so nothing was sent.',
	upstream_unavailable:
		'GitHub is unavailable. Try again; a push whose answer was lost may still have landed.',
	not_configured: 'GitHub sync is not set up on this Epicenter server.',
};

/** Why a connector call did not do what it asked, in words a person acts on. */
export const ConnectorError = defineErrors({
	/** Epicenter refused the session, or the Account is paused or retired. */
	Session: () => ({
		message:
			'Your Epicenter sign-in needs attention. Sign in again, then try again.',
	}),
	/** The connector answered with a refusal code. */
	Refused: ({
		status,
		code,
		installUrl,
	}: {
		status: number;
		code: string | undefined;
		installUrl: string | undefined;
	}) => ({
		message:
			(code && CODE_MESSAGES[code]) ??
			`Epicenter refused the request (HTTP ${status}).`,
		status,
		code,
		installUrl,
	}),
	Unreachable: ({ cause }: { cause: unknown }) => ({
		message:
			'Todos could not reach Epicenter. Check your connection and try again.',
		cause,
	}),
	Malformed: ({ what }: { what: string }) => ({
		message: `Epicenter answered with ${what} that Todos cannot read.`,
		what,
	}),
});
export type ConnectorError = InferErrors<typeof ConnectorError>;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isText = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0;
const REVISION = /^[A-Za-z0-9_-]{22}$/;
const FOLDER_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** `https://github.com/<owner>/<name>.git`, written exactly as the URL parser would. */
export function isCanonicalCloneUrl(value: unknown): value is string {
	if (typeof value !== 'string' || !URL.canParse(value)) return false;
	const url = new URL(value);
	return (
		url.href === value &&
		url.protocol === 'https:' &&
		url.hostname === 'github.com' &&
		url.port === '' &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash &&
		/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(url.pathname)
	);
}

export function parsePairing(value: unknown): Pairing | undefined {
	if (
		!isObject(value) ||
		!isObject(value.repository) ||
		!isObject(value.remote)
	)
		return undefined;
	const { folderId, revision, status } = value;
	const { id, installationId, fullName } = value.repository;
	const { url, branch } = value.remote;
	if (
		typeof folderId !== 'string' ||
		!FOLDER_ID.test(folderId) ||
		typeof revision !== 'string' ||
		!REVISION.test(revision) ||
		!isText(status) ||
		!isId(id) ||
		!isId(installationId) ||
		!isText(fullName) ||
		!isCanonicalCloneUrl(url) ||
		!isText(branch)
	)
		return undefined;
	return {
		folderId,
		revision,
		status,
		repository: { id, installationId, fullName },
		remote: { url, branch },
	};
}

function parseRepository(value: unknown): Repository | undefined {
	if (!isObject(value)) return undefined;
	const { id, installationId, fullName, cloneUrl, defaultBranch, push } = value;
	if (
		!isId(id) ||
		!isId(installationId) ||
		!isText(fullName) ||
		!isText(cloneUrl) ||
		!isText(defaultBranch)
	)
		return undefined;
	return {
		id,
		installationId,
		fullName,
		cloneUrl,
		defaultBranch,
		push: push === true,
	};
}

/** The connector's base URL on the Account's own server. */
export function connectorBase(account: Pick<Account, 'baseURL'>): string {
	return `${new URL(account.baseURL).origin}${CONNECTOR_PATH}`;
}

/** 32 random bytes as base64url: 43 characters, as `state` and the PKCE verifier. */
export function randomSecret(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The PKCE S256 challenge of `verifier`: base64url of its SHA-256. */
export async function challengeOf(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(verifier),
	);
	return base64url(new Uint8Array(digest));
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

/** A thrown `fetch` failure: the Account's own refusal, or the network's. */
function thrown(cause: unknown): ConnectorError {
	return isObject(cause) &&
		(cause.name === 'AccountUnavailable' || cause.name === 'AbortError')
		? ConnectorError.Session().error
		: ConnectorError.Unreachable({ cause }).error;
}

/** A non-2xx answer as the refusal it reports. */
async function refusal(response: Response): Promise<ConnectorError> {
	if (response.status === 401) {
		await response.body?.cancel().catch(() => {});
		return ConnectorError.Session().error;
	}
	const body: unknown = await response.json().catch(() => undefined);
	const header = response.headers.get(GIT_ERROR_HEADER);
	const code =
		header !== null && /^[a-z_]{1,64}$/.test(header)
			? header
			: isObject(body) && typeof body.error === 'string'
				? body.error
				: undefined;
	const installUrl =
		isObject(body) &&
		typeof body.installUrl === 'string' &&
		body.installUrl.startsWith('https://github.com/')
			? body.installUrl
			: undefined;
	return ConnectorError.Refused({ status: response.status, code, installUrl })
		.error;
}

/** The connector, called as `account`. */
export function createConnector(account: ConnectorAccount) {
	const base = connectorBase(account);

	async function call(
		path: string,
		init: { method: string; body?: unknown } = { method: 'GET' },
	): Promise<Result<unknown, ConnectorError>> {
		let response: Response;
		try {
			response = await account.fetch(`${base}${path}`, {
				method: init.method,
				headers:
					init.body === undefined
						? { accept: 'application/json' }
						: {
								accept: 'application/json',
								'content-type': 'application/json',
							},
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
				credentials: 'omit',
				cache: 'no-store',
			});
		} catch (cause) {
			return Err(thrown(cause));
		}
		if (!response.ok) return Err(await refusal(response));
		const body: unknown = await response.json().catch(() => undefined);
		return Ok(body);
	}

	return {
		/**
		 * Start GitHub authorization. Returns the GitHub URL to navigate to;
		 * `state` and `codeChallenge` are the browser's, kept by the caller.
		 */
		async connect({
			redirectUri,
			state,
			codeChallenge,
		}: {
			redirectUri: string;
			state: string;
			codeChallenge: string;
		}): Promise<Result<string, ConnectorError>> {
			const { data, error } = await call('/connect', {
				method: 'POST',
				body: { redirectUri, state, codeChallenge },
			});
			if (error) return Err(error);
			if (
				!isObject(data) ||
				typeof data.authorizeUrl !== 'string' ||
				!data.authorizeUrl.startsWith('https://github.com/')
			)
				return ConnectorError.Malformed({ what: 'an authorization link' });
			return Ok(data.authorizeUrl);
		},

		/** Finish GitHub authorization with the handoff code from the return URL. */
		async complete({
			code,
			verifier,
			redirectUri,
		}: {
			code: string;
			verifier: string;
			redirectUri: string;
		}): Promise<Result<{ login: string }, ConnectorError>> {
			const { data, error } = await call('/complete', {
				method: 'POST',
				body: { code, verifier, redirectUri },
			});
			if (error) return Err(error);
			if (!isObject(data) || !isObject(data.user) || !isText(data.user.login))
				return ConnectorError.Malformed({ what: 'a GitHub account' });
			return Ok({ login: data.user.login });
		},

		/** The private repositories the GitHub App reaches for the connected user. A read. */
		async repositories(): Promise<Result<Repository[], ConnectorError>> {
			const { data, error } = await call('/repositories');
			if (error) return Err(error);
			if (!isObject(data) || !Array.isArray(data.repositories))
				return ConnectorError.Malformed({ what: 'a repository list' });
			const parsed = data.repositories.map(parseRepository);
			if (parsed.some((entry) => entry === undefined))
				return ConnectorError.Malformed({ what: 'a repository' });
			return Ok(parsed as Repository[]);
		},

		/** `folderId`'s pairing, or `undefined` when it has none. A read. */
		async pairing(
			folderId: string,
		): Promise<Result<Pairing | undefined, ConnectorError>> {
			const { data, error } = await call('/pairings');
			if (error) return Err(error);
			if (!isObject(data) || !Array.isArray(data.pairings))
				return ConnectorError.Malformed({ what: 'a pairing list' });
			const entry: unknown = data.pairings.find(
				(candidate: unknown) =>
					isObject(candidate) && candidate.folderId === folderId,
			);
			if (entry === undefined) return Ok(undefined);
			const parsed = parsePairing(entry);
			if (parsed === undefined || parsed.folderId !== folderId)
				return ConnectorError.Malformed({ what: 'a pairing' });
			return Ok(parsed);
		},

		/**
		 * Pair `folderId` with `repository` on its default branch. Never
		 * replaces another pairing: that is `pairing_conflict`.
		 */
		async pair(
			folderId: string,
			repository: Pick<Repository, 'id' | 'installationId'>,
		): Promise<Result<Pairing, ConnectorError>> {
			const { data, error } = await call(
				`/pairings/${encodeURIComponent(folderId)}`,
				{
					method: 'PUT',
					body: {
						repositoryId: repository.id,
						installationId: repository.installationId,
					},
				},
			);
			if (error) return Err(error);
			const parsed = isObject(data) ? parsePairing(data.pairing) : undefined;
			if (parsed === undefined || parsed.folderId !== folderId)
				return ConnectorError.Malformed({ what: 'a pairing' });
			return Ok(parsed);
		},
	};
}

export type Connector = ReturnType<typeof createConnector>;

/** Request headers Git's smart HTTP needs and the connector admits. */
const FORWARDED = [
	'accept',
	'content-type',
	'content-encoding',
	'git-protocol',
];
const SMART_HTTP =
	/^\/(info\/refs\?service=git-(upload|receive)-pack|git-(upload|receive)-pack)$/;

/**
 * Git transport for one pinned pairing. A request for the pairing's
 * canonical `remote.url` is sent through `account.fetch` to
 * `<connector>/git/<folderId>/<revision>/...` instead; anything else is
 * refused before it is sent. A refusal comes back with its status and a
 * reason phrase a person can read, which Git reports as the transfer's error.
 */
export function relayFetch(
	account: Pick<Account, 'baseURL' | 'fetch'>,
	pairing: Pick<Pairing, 'folderId' | 'revision' | 'remote'>,
): HttpFetch {
	const target = `${connectorBase(account)}/git/${encodeURIComponent(pairing.folderId)}/${pairing.revision}`;
	const prefix = pairing.remote.url;
	return async (input, init) => {
		const url =
			input instanceof Request
				? input.url
				: input instanceof URL
					? input.href
					: input;
		const rest = url.startsWith(prefix) ? url.slice(prefix.length) : undefined;
		if (rest === undefined || !SMART_HTTP.test(rest))
			throw new TypeError(
				'Todos sends Git requests only to the repository it is connected to.',
			);
		const given = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		const headers = new Headers();
		for (const name of FORWARDED) {
			const value = given.get(name);
			if (value !== null) headers.set(name, value);
		}
		const method =
			init?.method ?? (input instanceof Request ? input.method : 'GET');
		let response: Response;
		try {
			response = await account.fetch(`${target}${rest}`, {
				method,
				headers,
				body: method === 'GET' ? undefined : init?.body,
				signal: init?.signal,
				redirect: 'manual',
				credentials: 'omit',
				cache: 'no-store',
			});
		} catch (cause) {
			if (init?.signal?.aborted) throw cause;
			throw new Error(thrown(cause).message, { cause });
		}
		if (response.status === 200) return response;
		const { message } = await refusal(response);
		return new Response(null, {
			status:
				response.status >= 200 && response.status < 600 ? response.status : 502,
			statusText: message,
		});
	};
}
