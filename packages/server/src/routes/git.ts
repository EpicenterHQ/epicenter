/**
 * Hosted Git (ADR-0546): a folder's remote is
 * `<git audience>/<namespace>/<name>.git`, and the first push creates it.
 *
 * ```txt
 * <git>/<namespace>/<name>.git/info/refs?service=…   GET    folders:read, read  (receive-pack: folders:write, push)
 * <git>/<namespace>/<name>.git/git-upload-pack       POST   folders:read, read
 * <git>/<namespace>/<name>.git/git-receive-pack      POST   folders:write, push; the first creates it
 * <api>/api/repos                                    GET    folders:read on the Git audience: the caller's repositories by namespace
 * ```
 *
 * The Git audience is `https://git.epicenter.so` for the hosted cloud and
 * `<origin>/git` for any other deployment (`resolveOAuthAudiences`), so a
 * request is Git's when its host and path fall under that audience.
 *
 * Every Git request is decided by one statement (`authorizeResourceRequest`):
 * the access token, presented as a Bearer token or as the password of Basic
 * credentials, with its audience, scope, and grant target; the namespace
 * membership and its role; and `<namespace>/<name>` resolved through
 * `repository`, then `repository_alias`, so a clone of a moved or renamed
 * repository keeps working. Nothing is cached, so a revoked token or a
 * removed member is refused on the next request.
 *
 * A name nobody has used is not a repository until something is pushed to
 * it. Its advertisement, for either service, answers a member whose role may
 * push as an empty repository would, so a sync that fetches before it pushes
 * finds nothing to fetch, and making that request creates nothing. Only
 * `POST git-receive-pack` creates, at its start and after the same
 * authorization: the storage (`GitHost.create`), then the row. Two first
 * pushes at once insert one row (the `(namespace_id, name)` unique key); the
 * one that loses pushes into the winner's repository, where its ref update
 * fails as any stale push does, and leaves an empty store entry no row names.
 * Unrelated history to an existing name is refused because it is not a
 * fast-forward, which the store enforces.
 *
 * The store (`GitHost`) is the replaceable part: Cloudflare Artifacts on the
 * Worker, bare repositories on disk for the Bun entry. It names a repository
 * by its immutable id, never by `<namespace>/<name>`, and receives only
 * requests this module already authorized; the client's credential never
 * reaches it.
 *
 * Refusals answer JSON `{ error, error_description }`:
 *   - 401 `invalid_token`        missing, unknown, expired, revoked, or another
 *                                audience's token, with `WWW-Authenticate`
 *                                naming `resource_metadata` (RFC 9728), plus a
 *                                Basic challenge for terminal Git;
 *   - 403 `insufficient_scope`   the token lacks the operation's scope;
 *   - 403 `forbidden`            the namespace is outside the grant, the account
 *                                is not a member, or its role may not do this;
 *   - 404 `not_found`            a missing repository's advertisement, for a
 *                                role that may not push, or its upload-pack;
 *   - 502 `store_failed`         storage failed or refused this server;
 *   - 503 `git_unavailable`      this deployment has no store, or its database
 *                                could not decide.
 *
 * Hosted Git is unmetered, like hosted blobs: Autumn denies by default without
 * a plan, so this mount takes no billing policy.
 */

import {
	isNamespaceId,
	isRepositoryName,
	type RepositoryListing,
} from '@epicenter/constants/repositories';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { every } from 'hono/combine';
import { createMiddleware } from 'hono/factory';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import {
	authorizeAccountRequest,
	authorizeResourceRequest,
	protectedResourceMetadataUrl,
	readAccessToken,
} from '../auth/resource-access.js';
import { roleAllows } from '../namespace-roles.js';
import {
	createRepository,
	listRepositories,
	newRepositoryId,
} from '../repositories.js';
import type { CloudEnv } from '../types.js';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

/** One authorized smart-HTTP request, as a store receives it. */
export type GitRequest = {
	service: GitService;
	/** `GET info/refs?service=…` rather than `POST <service>`. */
	advertisement: boolean;
	/** The request's `content-type`, `content-encoding`, `accept`, and `git-protocol`; never a credential. */
	headers: Headers;
	body: ReadableStream<Uint8Array> | null;
	signal: AbortSignal;
	/** The account this server authorized, for the store's own records. */
	accountId: string;
};

/**
 * Where hosted repositories are stored (ADR-0546), by immutable id. The
 * rows, names, aliases, and listing live in Postgres, so a rename or a move
 * never reaches the store.
 */
export type GitHost = {
	/** Answer one authorized request for repository `id`. Throws when storage cannot be reached. */
	serve(id: string, request: GitRequest): Promise<Response>;
	/**
	 * Make an empty repository `id`, whose default branch is `main`, at the
	 * start of the first push to its name. Making one that exists is not an
	 * error.
	 */
	create(id: string): Promise<void>;
};

const FORWARDED_HEADERS = [
	'content-type',
	'content-encoding',
	'accept',
	'git-protocol',
];

/** Operator diagnostics. Their causes stay in the log, off the wire. */
const GitHostError = defineErrors({
	AuthorizeFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not decide a Git request: ${extractErrorMessage(cause)}`,
		cause,
	}),
	CreateFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `Could not create ${path}: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ServeFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not serve a Git request: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StoreRefused: ({ status }: { status: number }) => ({
		message: `Storage refused this server's credential with ${status}`,
	}),
});

const log = createLogger('git');

/** A request under the Git audience, read from its URL. */
export type GitTarget =
	| {
			kind: 'repository';
			namespaceId: string;
			name: string;
			service: GitService;
			advertisement: boolean;
	  }
	| { kind: 'unknown' };

/**
 * The request `url` makes under `gitAudience`, `{ kind: 'unknown' }` for any
 * other path under it, or `undefined` when it is not under it at all.
 */
export function readGitTarget(
	method: string,
	url: URL,
	gitAudience: string,
): GitTarget | undefined {
	const audience = new URL(gitAudience);
	if (url.host !== audience.host || url.protocol !== audience.protocol)
		return undefined;
	const prefix = audience.pathname.replace(/\/+$/, '');
	if (
		prefix !== '' &&
		url.pathname !== prefix &&
		!url.pathname.startsWith(`${prefix}/`)
	)
		return undefined;
	const match =
		/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
			url.pathname.slice(prefix.length),
		);
	const [, namespaceId, name, endpoint] = match ?? [];
	if (
		namespaceId === undefined ||
		name === undefined ||
		endpoint === undefined ||
		!isNamespaceId(namespaceId) ||
		!isRepositoryName(name)
	)
		return { kind: 'unknown' };
	if (endpoint === 'info/refs') {
		const params = [...url.searchParams];
		const service = params[0]?.[0] === 'service' ? params[0][1] : undefined;
		if (
			method !== 'GET' ||
			params.length !== 1 ||
			(service !== 'git-upload-pack' && service !== 'git-receive-pack')
		)
			return { kind: 'unknown' };
		return {
			kind: 'repository',
			namespaceId,
			name,
			service,
			advertisement: true,
		};
	}
	if (method !== 'POST' || url.search !== '') return { kind: 'unknown' };
	return {
		kind: 'repository',
		namespaceId,
		name,
		service: endpoint as GitService,
		advertisement: false,
	};
}

/** One pkt-line (`gitprotocol-common`) holding `line`, which is ASCII. */
const pktLine = (line: string) =>
	`${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/**
 * Capabilities the empty advertisement offers. The push that follows goes to
 * the store, which receives only what the client chose from these, so the
 * list stays at what a push needs to stream and report its result: no
 * `ofs-delta`, `atomic`, or `object-format`, whose absence means SHA-1.
 */
const EMPTY_CAPABILITIES: Record<GitService, string> = {
	'git-upload-pack': 'agent=epicenter',
	'git-receive-pack': 'report-status side-band-64k agent=epicenter',
};

/**
 * The protocol v0 advertisement of a repository with no refs
 * (`gitprotocol-pack`, "no-refs"). A client that asked for protocol v2 reads
 * it as a server that speaks v0, and finds nothing to fetch.
 */
function emptyAdvertisement(service: GitService): Response {
	const capabilities = `${'0'.repeat(40)} capabilities^{}\0${EMPTY_CAPABILITIES[service]}\n`;
	return new Response(
		`${pktLine(`# service=${service}\n`)}0000${pktLine(capabilities)}0000`,
		{
			headers: {
				'content-type': `application/x-${service}-advertisement`,
				'cache-control': 'no-cache, max-age=0, must-revalidate',
			},
		},
	);
}

function refuse(
	c: Context<CloudEnv>,
	status: 401 | 403 | 404 | 502 | 503,
	error: string,
	description: string,
	challenges: string[] = [],
) {
	const response = c.json({ error, error_description: description }, status);
	for (const challenge of challenges)
		response.headers.append('www-authenticate', challenge);
	return response;
}

/**
 * Mount hosted Git on its audience, and `GET /api/repos` on the API's origin
 * for a Git-audience token.
 * `setup` installs the database (`c.var.db`), which every request reads.
 */
export function mountGitHost(
	app: Hono<CloudEnv>,
	{
		setup,
		resolveHost,
	}: {
		setup: MiddlewareHandler<CloudEnv>;
		/** `null` answers 503 `git_unavailable` on every Git request. */
		resolveHost: (env: CloudEnv['Bindings']) => GitHost | null;
	},
): void {
	const serve = createMiddleware<CloudEnv>(async (c) => {
		const audience = c.var.audiences.git;
		const target = readGitTarget(c.req.method, new URL(c.req.url), audience);
		if (target?.kind !== 'repository')
			return refuse(
				c,
				404,
				'not_found',
				'Not a Git request this server answers.',
			);
		const host = resolveHost(c.env);
		if (!host)
			return refuse(
				c,
				503,
				'git_unavailable',
				'This server does not host Git repositories.',
			);
		const push = target.service === 'git-receive-pack';
		let decided: Awaited<ReturnType<typeof authorizeResourceRequest>>;
		try {
			decided = await authorizeResourceRequest(c.var.db, {
				token: readAccessToken(c.req.header('authorization')),
				audience,
				scope: push ? 'folders:write' : 'folders:read',
				namespaceId: target.namespaceId,
				repository: target.name,
			});
		} catch (cause) {
			log.error(GitHostError.AuthorizeFailed({ cause }).error);
			return refuse(
				c,
				503,
				'git_unavailable',
				'The request could not be checked. Try again.',
			);
		}
		if (decided.error !== null) {
			const { status, challenge, body } = decided.error;
			// A browser must see a readable 401, not a login prompt; terminal
			// Git asks its credential helper only after a Basic challenge.
			const basic =
				status === 401 && c.req.header('origin') === undefined
					? ['Basic realm="Epicenter"']
					: [];
			return refuse(c, status, body.error, body.error_description, [
				challenge,
				...basic,
			]);
		}
		const access = decided.data;
		if (!roleAllows(access.role, push ? 'push' : 'read'))
			return refuse(
				c,
				403,
				'forbidden',
				`This account's role may not ${push ? 'push to' : 'read'} that namespace.`,
				[
					`Bearer resource_metadata="${protectedResourceMetadataUrl(audience)}"`,
				],
			);

		let repository = access.repository;
		if (repository === null) {
			// Reading a name nobody holds creates nothing: one who may push to it
			// sees an empty repository, and anyone else a missing one.
			if (target.advertisement && roleAllows(access.role, 'push'))
				return emptyAdvertisement(target.service);
			if (!push)
				return refuse(
					c,
					404,
					'not_found',
					`No repository is named ${target.namespaceId}/${target.name}.`,
				);
			// The first push. Storage comes first, so no row ever names a
			// repository that has none.
			const id = newRepositoryId();
			try {
				await host.create(id);
				repository = await createRepository(c.var.db, {
					id,
					namespaceId: access.namespaceId,
					name: target.name,
				});
			} catch (cause) {
				log.error(
					GitHostError.CreateFailed({
						path: `${target.namespaceId}/${target.name}`,
						cause,
					}).error,
				);
				return refuse(
					c,
					502,
					'store_failed',
					'The repository could not be created.',
				);
			}
		}

		const headers = new Headers();
		for (const header of FORWARDED_HEADERS) {
			const value = c.req.header(header);
			if (value !== undefined) headers.set(header, value);
		}
		let upstream: Response;
		try {
			upstream = await host.serve(repository.id, {
				service: target.service,
				advertisement: target.advertisement,
				headers,
				body: target.advertisement ? null : c.req.raw.body,
				signal: c.req.raw.signal,
				accountId: access.accountId,
			});
		} catch (cause) {
			if (!c.req.raw.signal.aborted)
				log.error(GitHostError.ServeFailed({ cause }).error);
			return refuse(
				c,
				502,
				'store_failed',
				'The repository could not be reached.',
			);
		}
		// Storage answering 401 or 403 refused this server's own credential,
		// which the client can do nothing about.
		if (upstream.status === 401 || upstream.status === 403) {
			await upstream.body?.cancel();
			log.error(GitHostError.StoreRefused({ status: upstream.status }).error);
			return refuse(
				c,
				502,
				'store_failed',
				'The repository could not be reached.',
			);
		}
		const responseHeaders = new Headers(upstream.headers);
		responseHeaders.delete('set-cookie');
		responseHeaders.delete('www-authenticate');
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders,
		});
	});
	const handleGit = every(setup, serve);
	app.use('*', async (c, next) => {
		const target = readGitTarget(
			c.req.method,
			new URL(c.req.url),
			c.var.audiences.git,
		);
		if (target === undefined) return next();
		return handleGit(c, next);
	});

	app.get(
		'/api/repos',
		setup,
		createMiddleware<CloudEnv>(async (c) => {
			const { audiences } = c.var;
			let decided: Awaited<ReturnType<typeof authorizeAccountRequest>>;
			try {
				// The listing is folder metadata, so it takes the token a client
				// already holds for the folders themselves: the Git audience's.
				decided = await authorizeAccountRequest(c.var.db, {
					token: readAccessToken(c.req.header('authorization')),
					audience: audiences.git,
					scope: 'folders:read',
				});
			} catch (cause) {
				log.error(GitHostError.AuthorizeFailed({ cause }).error);
				return refuse(
					c,
					503,
					'git_unavailable',
					'The request could not be checked. Try again.',
				);
			}
			if (decided.error !== null)
				return refuse(
					c,
					decided.error.status,
					decided.error.body.error,
					decided.error.body.error_description,
					[decided.error.challenge],
				);
			const listing: RepositoryListing = {
				namespaces: await listRepositories(c.var.db, {
					accountId: decided.data.accountId,
					target: decided.data.target,
					gitAudience: audiences.git,
				}),
			};
			return c.json(listing, 200, { 'cache-control': 'no-store' });
		}),
	);
}
