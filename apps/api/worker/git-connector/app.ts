/**
 * HTTP surface of the hosted GitHub Git connector.
 *
 * Every route except the GitHub callback runs behind the host's `auth`
 * middleware, which verifies the Epicenter session bearer and sets
 * `c.var.principal`. The connector never reads identity from the request
 * itself, and does not gate on `Origin`: the bearer is not ambient, and CORS
 * decides which browser pages may read responses. Each principal has one
 * connection object holding its GitHub grant, pending authorizations, and
 * folder pairings.
 *
 * The person authorizes GitHub separately from Epicenter sign-in and lists
 * the private repositories the GitHub App can reach for them. Git smart-HTTP
 * reaches GitHub through one of two route families, which differ only in how
 * a request is admitted:
 *
 * - `/repos/<owner>/<name>.git/...` relays for a folder whose own Git config
 *   names the canonical clone URL `https://github.com/<owner>/<name>.git`;
 *   the page's Git transport rewrites that URL to this prefix. No pairing is
 *   involved: the connector reads the repository by name with the user's
 *   token only to learn its id, then admits by id.
 * - `/git/<folderId>/<revision>/...` relays for a stored folder pairing,
 *   addressed to the pairing revision. Installed apps' hosted datasets still
 *   use these routes, with pairings made by numeric repository id.
 *
 * Either way the request goes to the clone URL GitHub reports for the
 * repository id, with a token scoped to that id.
 *
 * The app is portable: storage, the GitHub client, and the Git upstream fetch
 * arrive through {@link GitHubConnectorRuntime}. `worker.ts` supplies the
 * Durable Object directory for Cloudflare; tests supply memory.
 */
import type { Principal } from '@epicenter/auth';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type {
	Connection,
	ConnectorError,
	ConnectorErrorCode,
	Pairing,
	PairingStatus,
	RepositoryAddress,
} from './connection.js';
import type { HttpFetch } from './github.js';

export const GITHUB_CONNECTOR_PATH = '/api/git/github';

/**
 * Largest Git request body and response body the connector relays. A gzip
 * request body is counted as sent, compressed.
 */
export const GIT_TRANSFER_LIMIT_BYTES = 64 * 1024 * 1024;
const JSON_BODY_LIMIT_BYTES = 4 * 1024;

/** The operations the edge calls on one principal's connection object. */
export type ConnectionPort = Pick<
	Connection,
	| 'begin'
	| 'callback'
	| 'complete'
	| 'repositories'
	| 'pair'
	| 'pairings'
	| 'unpair'
	| 'authorizeTransfer'
	| 'authorizeRepositoryTransfer'
>;

/**
 * How one Git route family admits a request. Validates the path parameters
 * without any call, returning undefined when they are malformed; otherwise
 * returns the admission, which the relay runs only after the request's own
 * checks pass.
 */
type Admit<E extends ConnectorHostEnv> = (
	c: Context<E>,
	connection: ConnectionPort,
	principalId: string,
) => (() => ReturnType<ConnectionPort['authorizeTransfer']>) | undefined;

/**
 * Where connection objects live. Neither call writes state.
 *
 * - `forPrincipal` addresses the one object for a verified principal, and
 *   returns its public id, which callback state carries.
 * - `open` addresses an object named in callback state, or returns undefined
 *   for an id the directory could never have issued.
 */
export type ConnectionDirectory = {
	forPrincipal(principalId: string): { id: string; connection: ConnectionPort };
	open(id: string): ConnectionPort | undefined;
};

export type GitHubConnectorRuntime = {
	/** This API's public origin; GitHub returns to `<apiOrigin>/api/git/github/callback`. */
	apiOrigin: string;
	/** Exact browser `redirectUri` values; their origins are the CORS allow-list. */
	callbacks: readonly string[];
	connections: ConnectionDirectory;
	/** Fetch used for Git transfers to GitHub. */
	gitFetch: HttpFetch;
	/** Override for tests; defaults to {@link GIT_TRANSFER_LIMIT_BYTES}. */
	transferLimitBytes?: number;
};

/**
 * The host context the connector needs: a verified principal set by `auth`.
 * `@epicenter/server`'s `Env` and `CloudEnv` both satisfy it.
 */
export type ConnectorHostEnv = {
	Bindings: object;
	Variables: { principal: Principal };
};

export type GitConnectorErrorCode =
	| ConnectorErrorCode
	| 'invalid_request'
	| 'payload_too_large'
	| 'repository_mismatch'
	| 'scoped_token_rejected'
	| 'upstream_rejected';

/**
 * No connector error is 401. An Epicenter `Account` treats a 401 as its own
 * session failing, so GitHub authorization problems are 403 with a code; 401
 * belongs to the host's session middleware alone.
 */
export const ERROR_STATUS = {
	github_authorization_required: 403,
	github_account_mismatch: 403,
	repository_unavailable: 403,
	repository_mismatch: 403,
	scoped_token_rejected: 403,
	principal_mismatch: 403,
	access_denied: 403,
	pairing_not_found: 404,
	pairing_conflict: 409,
	pairing_superseded: 409,
	authorization_failed: 400,
	invalid_grant: 400,
	invalid_request: 400,
	payload_too_large: 413,
	upstream_rejected: 502,
	credential_scoping_unsupported: 503,
	upstream_unavailable: 503,
	not_configured: 503,
} as const satisfies Record<GitConnectorErrorCode, number>;

const ERROR_MESSAGE: Record<GitConnectorErrorCode, string> = {
	github_authorization_required:
		'GitHub is not connected, or the connection expired or was revoked.',
	github_account_mismatch:
		'This folder was paired by a different GitHub account. Pair it again.',
	repository_unavailable:
		'The GitHub App cannot reach this private repository with write access for this account.',
	repository_mismatch: 'GitHub redirected the repository request.',
	scoped_token_rejected:
		'GitHub refused the repository token for this request. A new request is admitted with a new token.',
	principal_mismatch: 'Request reached another account’s connection.',
	access_denied: 'GitHub authorization was declined.',
	pairing_not_found: 'This folder is not paired with a repository.',
	pairing_conflict:
		'This folder is already paired. Replace the pairing explicitly.',
	pairing_superseded:
		'This folder was paired again since this remote was configured. Use the current pairing.',
	authorization_failed: 'GitHub authorization failed.',
	invalid_grant: 'Authorization code is invalid, expired, or already used.',
	invalid_request: 'Request is malformed.',
	payload_too_large: 'Request exceeds the size limit.',
	upstream_rejected: 'GitHub returned an unexpected response.',
	credential_scoping_unsupported:
		'GitHub did not issue a repository-scoped token. No broader credential is used.',
	upstream_unavailable: 'GitHub is unavailable. Try again.',
	not_configured: 'GitHub connector is not configured.',
};

export const GIT_ERROR_HEADER = 'X-Epicenter-Git-Error';

const BROWSER_SECRET = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const OPAQUE_ID = '[A-Za-z0-9_-]{22}';
const SECRET = '[A-Za-z0-9_-]{43}';
const PROVIDER_STATE = new RegExp(
	`^([^.]{1,128})\\.(${OPAQUE_ID})\\.(${SECRET})$`,
);
const HANDOFF_CODE = new RegExp(`^(${OPAQUE_ID})\\.(${SECRET})$`);
const REVISION = new RegExp(`^${OPAQUE_ID}$`);
const FOLDER_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const GIT_PROTOCOL = /^[A-Za-z0-9=:._,-]{1,64}$/;
/** GitHub login: alphanumerics and single inner hyphens, at most 39. */
const GITHUB_OWNER = /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/;
const GITHUB_OWNER_MAX = 39;
/** GitHub repository name, at most 100; `.` and `..` are refused separately. */
const GITHUB_REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const GIT_SERVICES = ['git-upload-pack', 'git-receive-pack'] as const;
type GitService = (typeof GIT_SERVICES)[number];

/**
 * Build the connector.
 *
 * `auth` must verify the Epicenter session bearer and set `c.var.principal`,
 * for example `requireBearerPrincipal(resolveRequestSessionPrincipal)`
 * composed after the host's context middleware. The callback route is the
 * only one that skips it.
 *
 * The connector answers its own CORS: no credentials, and `Git-Protocol`
 * and `Content-Encoding` allowed. A host-wide credentialed CORS layer that
 * runs first would answer preflights differently; see the README for
 * mounting.
 */
export function createGitHubConnectorApp<E extends ConnectorHostEnv>({
	auth,
	resolve,
}: {
	auth: MiddlewareHandler<E>;
	/** Per-request runtime, or undefined when bindings are missing (503). */
	resolve: (
		env: E['Bindings'],
	) =>
		| GitHubConnectorRuntime
		| undefined
		| Promise<GitHubConnectorRuntime | undefined>;
}): Hono<E> {
	const app = new Hono<E>().basePath(GITHUB_CONNECTOR_PATH);

	const resolved = new WeakMap<
		Request,
		Promise<GitHubConnectorRuntime | undefined>
	>();
	const runtimeOf = (c: Context<E>) => {
		let runtime = resolved.get(c.req.raw);
		if (!runtime) {
			runtime = Promise.resolve(resolve(c.env));
			resolved.set(c.req.raw, runtime);
		}
		return runtime;
	};

	const browserCors = cors({
		origin: async (origin, c) =>
			allowedOrigins(await runtimeOf(c as Context<E>)).has(origin)
				? origin
				: null,
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
		allowHeaders: [
			'Authorization',
			'Content-Type',
			'Content-Encoding',
			'Git-Protocol',
		],
		exposeHeaders: [GIT_ERROR_HEADER],
		maxAge: 600,
	});
	/** CORS first, so preflights never need a session; then the session. */
	for (const path of [
		'/connect',
		'/complete',
		'/repositories',
		'/pairings',
		'/pairings/:folderId',
		'/git/*',
		'/repos/*',
	]) {
		app.use(path, browserCors);
		app.use(path, auth);
	}

	/** The verified principal and its one connection object. */
	async function principalConnection(c: Context<E>) {
		const runtime = await runtimeOf(c);
		if (!runtime) return undefined;
		const principalId: string = c.var.principal.id;
		const { id, connection } = runtime.connections.forPrincipal(principalId);
		return { runtime, principalId, id, connection };
	}

	app.post('/connect', async (c) => {
		const scope = await principalConnection(c);
		if (!scope) return failure('not_configured');
		const body = await readJsonBody(c.req.raw);
		if (body === 'too_large') return failure('payload_too_large');
		const { redirectUri, state, codeChallenge } = body ?? {};
		if (
			typeof redirectUri !== 'string' ||
			!scope.runtime.callbacks.includes(redirectUri) ||
			typeof state !== 'string' ||
			!BROWSER_SECRET.test(state) ||
			typeof codeChallenge !== 'string' ||
			!BROWSER_SECRET.test(codeChallenge)
		)
			return failure('invalid_request');
		const { data: authorizeUrl, error } = await scope.connection.begin(
			scope.principalId,
			{
				redirectUri,
				browserState: state,
				browserChallenge: codeChallenge,
				providerRedirectUri: `${scope.runtime.apiOrigin}${GITHUB_CONNECTOR_PATH}/callback`,
			},
		);
		if (error) return connectorFailure(error);
		return json({ authorizeUrl });
	});

	app.get('/callback', async (c) => {
		const runtime = await runtimeOf(c);
		if (!runtime) return failure('not_configured');
		const url = new URL(c.req.url);
		const match = single(url, 'state')?.match(PROVIDER_STATE);
		const connection =
			match?.[1] && match[2] && match[3]
				? runtime.connections.open(match[1])
				: undefined;
		const outcome =
			connection && match?.[2] && match[3]
				? await connection.callback({
						transactionId: match[2],
						secret: match[3],
						code: single(url, 'code'),
						providerError: single(url, 'error'),
					})
				: undefined;
		// No live transaction means no trusted destination: stop here.
		if (!outcome)
			return c.text(
				'This GitHub connection attempt is invalid or expired. Return to the app and connect again.',
				400,
				{ 'Cache-Control': 'no-store' },
			);
		if ('error' in outcome)
			return redirectToApp(outcome.redirectUri, {
				github_error: outcome.error.code,
				github_state: outcome.browserState,
				github_install_url: outcome.error.installUrl,
			});
		return redirectToApp(outcome.redirectUri, {
			github_code: outcome.handoffCode,
			github_state: outcome.browserState,
		});
	});

	app.post('/complete', async (c) => {
		const scope = await principalConnection(c);
		if (!scope) return failure('not_configured');
		const body = await readJsonBody(c.req.raw);
		if (body === 'too_large') return failure('payload_too_large');
		const { code, verifier, redirectUri } = body ?? {};
		if (
			typeof code !== 'string' ||
			typeof verifier !== 'string' ||
			!PKCE_VERIFIER.test(verifier) ||
			typeof redirectUri !== 'string' ||
			!scope.runtime.callbacks.includes(redirectUri)
		)
			return failure('invalid_request');
		const match = code.match(HANDOFF_CODE);
		if (!match?.[1] || !match[2]) return failure('invalid_grant');
		// Routed by the verified principal: another principal's code names a
		// transaction this object does not hold.
		const { data, error } = await scope.connection.complete(scope.principalId, {
			transactionId: match[1],
			secret: match[2],
			verifier,
			redirectUri,
		});
		if (error) return connectorFailure(error);
		return json({ user: { id: data.user.id, login: data.user.login } });
	});

	app.get('/repositories', async (c) => {
		const scope = await principalConnection(c);
		if (!scope) return failure('not_configured');
		const { data, error } = await scope.connection.repositories(
			scope.principalId,
		);
		if (error) return connectorFailure(error);
		return json({ repositories: data });
	});

	app.get('/pairings', async (c) => {
		const scope = await principalConnection(c);
		if (!scope) return failure('not_configured');
		const { data, error } = await scope.connection.pairings(scope.principalId);
		if (error) return connectorFailure(error);
		return json({
			pairings: data.map(({ pairing, status }) => pairingView(pairing, status)),
		});
	});

	app.put('/pairings/:folderId', async (c) => {
		const scope = await principalConnection(c);
		if (!scope) return failure('not_configured');
		const folderId = c.req.param('folderId');
		if (!FOLDER_ID.test(folderId)) return failure('invalid_request');
		const body = await readJsonBody(c.req.raw);
		if (body === 'too_large') return failure('payload_too_large');
		const { repositoryId, installationId, branch, replace } = body ?? {};
		if (
			!isId(repositoryId) ||
			!isId(installationId) ||
			(branch !== undefined && !isBranch(branch)) ||
			(replace !== undefined && typeof replace !== 'boolean')
		)
			return failure('invalid_request');
		const { data, error } = await scope.connection.pair(scope.principalId, {
			folderId,
			repositoryId,
			installationId,
			branch,
			replace,
		});
		if (error) return connectorFailure(error);
		return json({ pairing: pairingView(data, 'ready') });
	});

	app.delete('/pairings/:folderId', async (c) => {
		const scope = await principalConnection(c);
		if (!scope) return failure('not_configured');
		const folderId = c.req.param('folderId');
		if (!FOLDER_ID.test(folderId)) return failure('invalid_request');
		const { error } = await scope.connection.unpair(
			scope.principalId,
			folderId,
		);
		if (error) return connectorFailure(error);
		return new Response(null, {
			status: 204,
			headers: { 'Cache-Control': 'no-store' },
		});
	});

	gitRoutes('/git/:folderId/:revision', (c, connection, principalId) => {
		const folderId = c.req.param('folderId') ?? '';
		const revision = c.req.param('revision') ?? '';
		if (!FOLDER_ID.test(folderId) || !REVISION.test(revision)) return;
		return () => connection.authorizeTransfer(principalId, folderId, revision);
	});
	gitRoutes('/repos/:owner/:repo', (c, connection, principalId) => {
		const repository = repositoryAddress(
			c.req.param('owner'),
			c.req.param('repo'),
		);
		if (!repository) return;
		return () =>
			connection.authorizeRepositoryTransfer(principalId, repository);
	});

	app.all('*', () => failure('invalid_request', 404));

	/**
	 * Register the smart-HTTP routes under `prefix`: `info/refs` for either
	 * service, and a POST per service. Query and body rules are the same for
	 * every prefix; only `admit` differs.
	 */
	function gitRoutes(prefix: string, admit: Admit<E>) {
		app.get(`${prefix}/info/refs`, (c) => {
			const url = new URL(c.req.url);
			const service = single(url, 'service');
			if ([...url.searchParams.keys()].length !== 1 || !isGitService(service))
				return failure('invalid_request');
			return transfer(c, service, 'advertisement', admit);
		});
		for (const service of GIT_SERVICES)
			app.post(`${prefix}/${service}`, (c) => {
				if (new URL(c.req.url).search) return failure('invalid_request');
				return transfer(c, service, 'result', admit);
			});
	}

	/**
	 * Relay one Git smart-HTTP request. Only the admitted repository's clone
	 * URL, a fixed header set, a scoped token, and the bounded body leave the
	 * Worker; only the content type and the bounded body come back. Each
	 * request is admitted once and sent once: a request admitted before its
	 * pairing is replaced still finishes against the repository it was
	 * admitted for.
	 */
	async function transfer(
		c: Context<E>,
		service: GitService,
		kind: 'advertisement' | 'result',
		admit: Admit<E>,
	): Promise<Response> {
		const scope = await principalConnection(c);
		if (!scope) return failure('not_configured');
		const admission = admit(c, scope.connection, scope.principalId);
		if (!admission) return failure('invalid_request');

		const limit = scope.runtime.transferLimitBytes ?? GIT_TRANSFER_LIMIT_BYTES;
		const post = kind === 'result';
		let encoding: string | undefined;
		if (post) {
			if (c.req.header('content-type') !== `application/x-${service}-request`)
				return failure('invalid_request');
			// Git's remote-curl may gzip RPC bodies. The header and bytes pass
			// through as sent, so the limit counts compressed bytes.
			const declaredEncoding = c.req.header('content-encoding');
			const coding = declaredEncoding?.toLowerCase();
			if (coding === 'gzip') encoding = declaredEncoding;
			else if (coding !== undefined && coding !== 'identity')
				return failure('invalid_request');
			const declared = Number(c.req.header('content-length') ?? 0);
			if (!Number.isSafeInteger(declared)) return failure('invalid_request');
			if (declared > limit) return failure('payload_too_large');
		}
		const gitProtocol = c.req.header('git-protocol');
		if (gitProtocol !== undefined && !GIT_PROTOCOL.test(gitProtocol))
			return failure('invalid_request');

		const { data: grant, error } = await admission();
		if (error) return connectorFailure(error);
		if (!isGitHubCloneUrl(grant.cloneUrl))
			return failure('repository_mismatch');

		const headers = new Headers({
			accept: `application/x-${service}-${kind}`,
			authorization: `Basic ${btoa(`x-access-token:${grant.accessToken}`)}`,
			'user-agent': 'git/epicenter-git-connector',
		});
		if (post) headers.set('content-type', `application/x-${service}-request`);
		if (encoding) headers.set('content-encoding', encoding);
		if (gitProtocol) headers.set('git-protocol', gitProtocol);
		const overflow = { exceeded: false };
		const body =
			post && c.req.raw.body
				? c.req.raw.body.pipeThrough(byteLimit(limit, overflow))
				: undefined;

		let upstream: Response;
		try {
			upstream = await scope.runtime.gitFetch(
				post
					? `${grant.cloneUrl}/${service}`
					: `${grant.cloneUrl}/info/refs?service=${service}`,
				{
					method: post ? 'POST' : 'GET',
					headers,
					body,
					redirect: 'manual',
					signal: c.req.raw.signal,
					// Required by Bun and Node for a streamed request body; ignored by Workers.
					...(body ? { duplex: 'half' } : {}),
				} as RequestInit,
			);
		} catch {
			// A POST whose outcome is unknown may have reached GitHub; the client
			// must not assume it failed.
			return failure(
				overflow.exceeded ? 'payload_too_large' : 'upstream_unavailable',
			);
		}
		if (overflow.exceeded) {
			await upstream.body?.cancel();
			return failure('payload_too_large');
		}

		if (upstream.status !== 200) {
			await upstream.body?.cancel();
			// GitHub refused the freshly scoped token before processing. The next
			// request runs a fresh admission; nothing is retried here.
			if (upstream.status === 401) return failure('scoped_token_rejected');
			if (upstream.status >= 300 && upstream.status < 400)
				return failure('repository_mismatch');
			if (upstream.status === 403 || upstream.status === 404)
				return failure('repository_unavailable');
			if (upstream.status === 429 || upstream.status >= 500)
				return failure('upstream_unavailable');
			return failure('upstream_rejected');
		}

		const contentType = upstream.headers.get('content-type');
		const length = Number(upstream.headers.get('content-length') ?? 0);
		if (contentType !== `application/x-${service}-${kind}` || length > limit) {
			await upstream.body?.cancel();
			return failure(
				length > limit ? 'payload_too_large' : 'upstream_rejected',
			);
		}
		// Report-status inside a 200 push response (a rejected branch update)
		// passes through untouched; it is Git's answer, not an authorization one.
		return new Response(upstream.body?.pipeThrough(byteLimit(limit)) ?? null, {
			status: 200,
			headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
		});
	}

	return app;
}

function pairingView(pairing: Pairing, status: PairingStatus) {
	return {
		folderId: pairing.folderId,
		revision: pairing.revision,
		status,
		repository: {
			id: pairing.repository.id,
			installationId: pairing.repository.installationId,
			fullName: pairing.repository.fullName,
		},
		remote: { url: pairing.repository.cloneUrl, branch: pairing.branch },
	};
}

/** A stream that errors once more than `limit` bytes pass through it. */
function byteLimit(
	limit: number,
	overflow?: { exceeded: boolean },
): TransformStream<Uint8Array, Uint8Array> {
	let seen = 0;
	return new TransformStream({
		transform(chunk, controller) {
			seen += chunk.byteLength;
			if (seen > limit) {
				if (overflow) overflow.exceeded = true;
				controller.error(
					new RangeError('Git transfer exceeds the size limit.'),
				);
				return;
			}
			controller.enqueue(chunk);
		},
	});
}

function json(body: unknown): Response {
	return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

function failure(code: GitConnectorErrorCode, status?: number): Response {
	return Response.json(
		{ error: code, message: ERROR_MESSAGE[code] },
		{
			status: status ?? ERROR_STATUS[code],
			headers: { [GIT_ERROR_HEADER]: code, 'Cache-Control': 'no-store' },
		},
	);
}

function connectorFailure(error: ConnectorError): Response {
	const response = failure(error.code);
	if (!error.installUrl) return response;
	return Response.json(
		{
			error: error.code,
			message: ERROR_MESSAGE[error.code],
			installUrl: error.installUrl,
		},
		{ status: response.status, headers: response.headers },
	);
}

function redirectToApp(
	redirectUri: string,
	params: Record<string, string | undefined>,
): Response {
	const url = new URL(redirectUri);
	for (const [name, value] of Object.entries(params))
		if (value !== undefined) url.searchParams.set(name, value);
	return new Response(null, {
		status: 302,
		headers: {
			Location: url.toString(),
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
		},
	});
}

function allowedOrigins(
	runtime: GitHubConnectorRuntime | undefined,
): Set<string> {
	return new Set(runtime?.callbacks.map((uri) => new URL(uri).origin) ?? []);
}

/** A query parameter that appears exactly once. */
function single(url: URL, name: string): string | undefined {
	const values = url.searchParams.getAll(name);
	return values.length === 1 ? values[0] : undefined;
}

/**
 * The repository a `/repos/<owner>/<name>.git` path names, or undefined for
 * anything GitHub could not have issued. The `.git` suffix is required, as in
 * the canonical clone URL.
 */
function repositoryAddress(
	owner: string | undefined,
	repo: string | undefined,
): RepositoryAddress | undefined {
	if (
		owner === undefined ||
		owner.length > GITHUB_OWNER_MAX ||
		!GITHUB_OWNER.test(owner) ||
		!repo?.endsWith('.git')
	)
		return undefined;
	const name = repo.slice(0, -'.git'.length);
	if (!GITHUB_REPOSITORY_NAME.test(name) || name === '.' || name === '..')
		return undefined;
	return { owner, name };
}

function isGitService(service: string | undefined): service is GitService {
	return GIT_SERVICES.includes(service as GitService);
}

function isId(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isBranch(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		BRANCH.test(value) &&
		!value.includes('..') &&
		!value.endsWith('/') &&
		!value.endsWith('.lock')
	);
}

/** `https://github.com/<owner>/<name>.git` and nothing else. */
function isGitHubCloneUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return (
		parsed.protocol === 'https:' &&
		parsed.hostname === 'github.com' &&
		parsed.port === '' &&
		!parsed.username &&
		!parsed.password &&
		!parsed.search &&
		!parsed.hash &&
		/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(parsed.pathname)
	);
}

/** Parse a small JSON object body, or report that it exceeds the limit. */
async function readJsonBody(
	request: Request,
): Promise<Record<string, unknown> | undefined | 'too_large'> {
	const type = request.headers.get('content-type');
	if (type?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
		return undefined;
	if (
		Number(request.headers.get('content-length') ?? 0) > JSON_BODY_LIMIT_BYTES
	)
		return 'too_large';
	if (!request.body) return undefined;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > JSON_BODY_LIMIT_BYTES) {
			await reader.cancel();
			return 'too_large';
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return body && typeof body === 'object' && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}
