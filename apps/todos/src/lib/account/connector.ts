/**
 * The hosted GitHub connector (`apps/api/worker/git-connector`), as Todos
 * calls it from the browser. Every request goes through the signed-in
 * `Account`'s own `fetch`, which adds the Epicenter bearer, so no credential
 * is held here, put in a URL, or written to the folder's Git configuration.
 *
 * A folder's remote is the repository's canonical clone URL,
 * `https://github.com/<owner>/<name>.git`, in its own Git configuration.
 * `githubRelay` rewrites each smart-HTTP request for such a URL, at request
 * time, to the connector's relay for that repository, and forwards only the
 * headers the connector admits. Nothing records which repository a folder
 * uses except the folder.
 *
 * Browser-only: reached through `#platform/connect`, never from the desktop
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
	/** Whether the user can push; syncing requires it. */
	readonly push: boolean;
};

/** What a person is told for each connector code. ASCII, so it fits an HTTP reason phrase. */
const CODE_MESSAGES: Record<string, string> = {
	github_authorization_required:
		'GitHub is not connected for your account, or the connection expired. Connect GitHub again.',
	repository_unavailable:
		'GitHub does not let Epicenter reach this private repository with write access. Check that the Epicenter Folder Sync app is installed on it.',
	repository_mismatch:
		'GitHub redirected the repository request, so it stopped.',
	scoped_token_rejected:
		'GitHub refused this request. Try again; each request gets a new repository token.',
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
/** The owner and name GitHub allows, as the connector checks them. */
const OWNER = /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The owner and name of `https://github.com/<owner>/<name>.git`, written
 * exactly as the URL parser would, or `undefined` for any other URL.
 */
export function githubRepository(
	value: unknown,
): { readonly owner: string; readonly name: string } | undefined {
	if (typeof value !== 'string' || !URL.canParse(value)) return undefined;
	const url = new URL(value);
	const match = /^\/([^/]+)\/([^/]+)\.git$/.exec(url.pathname);
	if (
		url.href !== value ||
		url.protocol !== 'https:' ||
		url.hostname !== 'github.com' ||
		url.port !== '' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		match === null
	)
		return undefined;
	const [, owner = '', name = ''] = match;
	if (
		owner.length > 39 ||
		!OWNER.test(owner) ||
		!NAME.test(name) ||
		name === '.' ||
		name === '..'
	)
		return undefined;
	return { owner, name };
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
 * Git transport for repositories on GitHub. A smart-HTTP request for a
 * canonical clone URL is sent through the account's `fetch` to
 * `<connector>/repos/<owner>/<name>.git/...`, which reaches that repository
 * with a token GitHub scopes to it; anything else is refused before it is
 * sent. `account` is asked for at each request, so signing in later is
 * enough. A refusal comes back with its status and a reason phrase a person
 * can read, which Git reports as the transfer's error.
 */
export function githubRelay(
	account: () => Pick<Account, 'baseURL' | 'fetch'> | undefined,
): HttpFetch {
	return async (input, init) => {
		const url =
			input instanceof Request
				? input.url
				: input instanceof URL
					? input.href
					: input;
		const split = /^(https:\/\/github\.com\/[^/]+\/[^/]+\.git)(\/.*)$/.exec(
			url,
		);
		const repository = split ? githubRepository(split[1]) : undefined;
		const rest = split?.[2];
		if (
			repository === undefined ||
			rest === undefined ||
			!SMART_HTTP.test(rest)
		)
			throw new TypeError(
				'Todos sends Git requests only to a GitHub repository, through Epicenter.',
			);
		const current = account();
		if (current === undefined)
			throw new Error('Sign in to Epicenter to sync with GitHub.');
		const target = `${connectorBase(current)}/repos/${repository.owner}/${repository.name}.git`;
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
			response = await current.fetch(`${target}${rest}`, {
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
