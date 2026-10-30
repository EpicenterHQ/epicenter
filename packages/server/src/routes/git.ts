/**
 * Hosted Git (ADR-0546): a folder's remote is
 * `<git audience>/<namespace>/<name>.git`, and the first push or web write
 * creates it. `<namespace>` may be `~`, the caller's personal namespace, so
 * a web app reaches `<account>/<app>` (decision 46) from its token alone.
 *
 * ```txt
 * <git>/<ns>/<name>.git/info/refs?service=…        GET   folders:read, read  (receive-pack: folders:write, push)
 * <git>/<ns>/<name>.git/git-upload-pack            POST  folders:read, read
 * <git>/<ns>/<name>.git/git-receive-pack           POST  folders:write, push (rewrite: owner); the receiver, receive.ts
 * <git>/<ns>/<name>.git/info/lfs/…                 Git LFS, lfs.ts
 * <git>/<ns>/<name>.git/epicenter/{files,file,writes}   the write translator, files.ts
 * <api>/api/repos                                  GET   folders:read on the Git audience: the caller's repositories by namespace
 * <api>/api/repos/<ns|~>/<name>/grants             GET   folders:read, manage: the repository's grants
 * <api>/api/repos/<ns|~>/<name>/grants/<person>    PUT { level } grants, DELETE revokes; folders:write, manage
 * ```
 *
 * A person outside the namespace reaches one repository through a grant
 * (`repository_grant`): `read` gives the `reader` role, `write` the
 * `writer` role (`namespace-roles.ts`). The decision is the same one
 * statement as membership's, so every route above, Git, LFS and web writes
 * alike, applies one rule. A grant names an existing repository and never
 * creates one; only the owner rewrites `main` or manages grants. A person
 * is named by their handle, the id of their personal namespace.
 *
 * The Git audience is `https://git.epicenter.so` for the hosted cloud and
 * `<origin>/git` for any other deployment (`resolveOAuthAudiences`), so a
 * request is Git's when its host and path fall under that audience.
 *
 * Every request is decided by the deployment's `GitAccess`. The hosted
 * cloud's (`databaseGitAccess`) is one statement (`authorizeResourceRequest`):
 * the access token, presented as a Bearer token or as the password of Basic
 * credentials, with its audience, scope, and grant target; the namespace
 * membership and its role; and `<namespace>/<name>` resolved through
 * `repository`, then `repository_alias`, so a clone of a moved or renamed
 * repository keeps working. Nothing is cached, so a revoked token or a
 * removed member is refused on the next request.
 *
 * A name nobody has used is not a repository until something is written to
 * it. Its advertisement answers a member whose role may push as an empty
 * repository would, its file listing is empty, and reading creates nothing.
 * Every writing request (a push, an LFS upload, a web write) creates it, at
 * its start and after the same authorization: the storage
 * (`GitHost.create`), then the row. Two first writes at once insert one row
 * (the `(namespace_id, name)` unique key); the one that loses writes into
 * the winner's repository, after removing the empty storage it made. A row
 * that could not be inserted leaves its storage: the insert may have
 * committed and lost only its reply, so removing it could leave a row that
 * names no storage.
 *
 * The store (`GitHost`) is the replaceable part: Cloudflare Artifacts on the
 * Worker, bare repositories on disk for the Bun entry. It names a repository
 * by its immutable id, never by `<namespace>/<name>`, and receives only
 * requests this module already authorized; the client's credential never
 * reaches it. A store with `objects` (disk) gets every push through the
 * receiver; one without serves pushes itself, and the files and LFS routes
 * answer 503.
 *
 * Refusals answer JSON `{ error, error_description }`:
 *   - 401 `invalid_token`        missing, unknown, expired, revoked, or another
 *                                audience's token, with `WWW-Authenticate`
 *                                naming `resource_metadata` (RFC 9728), plus a
 *                                Basic challenge for terminal Git;
 *   - 403 `insufficient_scope`   the token lacks the operation's scope;
 *   - 403 `forbidden`            the namespace is outside the grant, the account
 *                                is neither a member nor granted the repository,
 *                                or its role may not do this;
 *   - 404 `not_found`            a missing repository's advertisement, for a
 *                                role that may not push, or its upload-pack;
 *   - 413 `too_large`            a push over 64 MiB;
 *   - 502 `store_failed`         storage failed or refused this server;
 *   - 503 `git_unavailable`      this deployment has no store, or its database
 *                                could not decide.
 *
 * Hosted Git is unmetered: Autumn denies by default without
 * a plan, so this mount takes no billing policy.
 */

import {
	type GrantLevel,
	isNamespaceId,
	isRepositoryName,
	type RepositoryGrantRevoked,
	type RepositoryGrants,
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
	type ResourceRefusal,
	readAccessToken,
	resolvePersonalNamespace,
} from '../auth/resource-access.js';
import type { GitObjects } from '../git/objects.js';
import type { LfsStore } from '../lfs/lfs-store.js';
import { type RepositoryRole, roleAllows } from '../namespace-roles.js';
import {
	createRepository,
	grantRepository,
	listRepositories,
	listRepositoryGrants,
	newRepositoryId,
	revokeRepositoryGrant,
} from '../repositories.js';
import type { CloudEnv } from '../types.js';
import {
	applyWrite,
	listRepositoryFiles,
	MAX_WRITE_BYTES,
	readRepositoryFile,
	readWriteRequest,
} from './files.js';
import {
	answerBatch,
	getObject,
	type LfsBatch,
	lfsJson,
	putObject,
	readBatch,
	verifyObject,
} from './lfs.js';
import {
	MAX_PUSH_BYTES,
	receiveAdvertisement,
	receivePush,
} from './receive.js';

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
	 * start of the first write to its name. Making one that exists is not an
	 * error.
	 */
	create(id: string): Promise<void>;
	/**
	 * Remove repository `id`'s storage, after its row is gone. Removing one
	 * that does not exist is not an error.
	 */
	delete(id: string): Promise<void>;
	/**
	 * Repository `id`'s objects and refs, for the push receiver and the
	 * write translator; the caller closes the handle. A host without it
	 * serves pushes itself through `serve`, and answers the files and LFS
	 * routes with 503.
	 */
	objects?(id: string): GitObjects;
};

/** What one request may do to one repository, as a deployment's access decided it. */
export type RepositoryAccess = {
	accountId: string;
	/** From membership in the namespace, or a grant on the repository. */
	role: RepositoryRole;
	/** The namespace the role is in (`~` resolved to the caller's own). */
	namespaceId: string;
	/** The repository the name resolves to, or null while nothing has been written to it. */
	repository: { id: string } | null;
};

/**
 * Who may do what to which repository. The hosted cloud decides from the
 * database (`databaseGitAccess`, the default); a deployment with no database
 * (the Cloudflare spike Worker) injects its own. Every rule after the
 * decision (roles, first writes, the receiver, the translator, LFS) is
 * this module's, so each deployment runs the same routes.
 */
export type GitAccess = {
	/**
	 * Decide one request: the caller's credential (`c.req`), and the
	 * repository `name` in `namespaceId` (`~`: the caller's own) for
	 * `operation`. A refusal is sent as it is.
	 */
	authorize(
		c: Context<CloudEnv>,
		target: { namespaceId: string; name: string; operation: 'read' | 'push' },
	): Promise<
		| { data: RepositoryAccess; error: null }
		| { data: null; error: ResourceRefusal }
	>;
	/**
	 * Make the repository at its first write: its storage (`host.create`),
	 * then its record. Returns the repository a concurrent first write may
	 * have made instead.
	 */
	create(
		c: Context<CloudEnv>,
		target: { namespaceId: string; name: string; host: GitHost },
	): Promise<{ id: string }>;
};

/**
 * The hosted cloud's access: one statement (`authorizeResourceRequest`)
 * over the token, its grant, the namespace membership and the repository's
 * name or alias; a first write inserts the `repository` row after its
 * storage. Reads `c.var.db`, which `mountGitHost`'s `setup` installs.
 */
export const databaseGitAccess: GitAccess = {
	async authorize(c, { namespaceId, name, operation }) {
		const audience = c.var.audiences.git;
		const token = readAccessToken(c.req.header('authorization'));
		const resolved =
			namespaceId === PERSONAL_NAMESPACE
				? ((await resolvePersonalNamespace(c.var.db, token)) ??
					PERSONAL_NAMESPACE)
				: namespaceId;
		return authorizeResourceRequest(c.var.db, {
			token,
			audience,
			scope: operation === 'push' ? 'folders:write' : 'folders:read',
			namespaceId: resolved,
			repository: name,
		});
	},
	async create(c, { namespaceId, name, host }) {
		// Storage comes first, so no row ever names a repository that has
		// none. Storage made for `id` stays if the insert fails: it may have
		// committed and lost only its reply, and a row naming missing storage
		// would fail every request; storage no row names harms nothing.
		const id = newRepositoryId();
		await host.create(id);
		const repository = await createRepository(c.var.db, {
			id,
			namespaceId,
			name,
		});
		// Another first write inserted the row, so this one goes into that
		// repository, and the storage made for `id` is certainly unnamed.
		if (repository.id !== id)
			await host.delete(id).catch((cause) => {
				log.error(GitHostError.DeleteFailed({ id, cause }).error);
			});
		return repository;
	},
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
	DeleteFailed: ({ id, cause }: { id: string; cause: unknown }) => ({
		message: `Could not remove the storage of repository ${id}, which no row names: ${extractErrorMessage(cause)}`,
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

/** The caller's personal namespace, in a URL. */
export const PERSONAL_NAMESPACE = '~';

/** What a request under a repository asks for. */
export type GitEndpoint =
	| { kind: 'git'; service: GitService; advertisement: boolean }
	| { kind: 'lfs-batch' }
	| { kind: 'lfs-object'; oid: string; upload: boolean }
	| { kind: 'lfs-verify' }
	| { kind: 'lfs-locks' }
	| { kind: 'files' }
	| { kind: 'file' }
	| { kind: 'writes' };

/** A request under the Git audience, read from its URL. */
export type GitTarget =
	| {
			kind: 'repository';
			/** A namespace id, or `~` for the caller's personal namespace. */
			namespaceId: string;
			name: string;
			endpoint: GitEndpoint;
	  }
	| { kind: 'unknown' };

function readEndpoint(
	method: string,
	rest: string,
	url: URL,
): GitEndpoint | undefined {
	const params = [...url.searchParams];
	if (rest === 'info/refs') {
		const service = params[0]?.[0] === 'service' ? params[0][1] : undefined;
		if (
			method !== 'GET' ||
			params.length !== 1 ||
			(service !== 'git-upload-pack' && service !== 'git-receive-pack')
		)
			return undefined;
		return { kind: 'git', service, advertisement: true };
	}
	if (rest === 'git-upload-pack' || rest === 'git-receive-pack')
		return method === 'POST' && url.search === ''
			? { kind: 'git', service: rest, advertisement: false }
			: undefined;
	if (rest === 'info/lfs/objects/batch')
		return method === 'POST' ? { kind: 'lfs-batch' } : undefined;
	if (rest === 'info/lfs/verify')
		return method === 'POST' ? { kind: 'lfs-verify' } : undefined;
	if (rest === 'info/lfs/locks' || rest.startsWith('info/lfs/locks/'))
		return { kind: 'lfs-locks' };
	const object = /^info\/lfs\/objects\/([0-9a-f]{64})$/.exec(rest)?.[1];
	if (object !== undefined)
		return method === 'PUT' || method === 'GET'
			? { kind: 'lfs-object', oid: object, upload: method === 'PUT' }
			: undefined;
	if (rest === 'epicenter/files' && method === 'GET') return { kind: 'files' };
	if (rest === 'epicenter/file' && method === 'GET') return { kind: 'file' };
	if (rest === 'epicenter/writes' && method === 'POST')
		return { kind: 'writes' };
	return undefined;
}

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
	const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(
		url.pathname.slice(prefix.length),
	);
	const [, namespaceId, name, rest] = match ?? [];
	if (
		namespaceId === undefined ||
		name === undefined ||
		rest === undefined ||
		(namespaceId !== PERSONAL_NAMESPACE && !isNamespaceId(namespaceId)) ||
		!isRepositoryName(name)
	)
		return { kind: 'unknown' };
	const endpoint = readEndpoint(method, rest, url);
	if (endpoint === undefined) return { kind: 'unknown' };
	return { kind: 'repository', namespaceId, name, endpoint };
}

/** One pkt-line (`gitprotocol-common`) holding `line`, which is ASCII. */
const pktLine = (line: string) =>
	`${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/**
 * Capabilities the empty advertisement offers, for a store that serves
 * pushes itself: what a push needs to stream and report its result.
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
	status: 400 | 401 | 403 | 404 | 413 | 502 | 503,
	error: string,
	description: string,
	challenges: string[] = [],
) {
	const response = c.json({ error, error_description: description }, status);
	for (const challenge of challenges)
		response.headers.append('www-authenticate', challenge);
	return response;
}

/** What `endpoint` does to the repository: read it, or write it. */
function operationOf(
	endpoint: GitEndpoint,
	batch: LfsBatch | null,
): 'read' | 'push' {
	switch (endpoint.kind) {
		case 'git':
			return endpoint.service === 'git-receive-pack' ? 'push' : 'read';
		case 'lfs-batch':
			return batch?.operation === 'upload' ? 'push' : 'read';
		case 'lfs-object':
			return endpoint.upload ? 'push' : 'read';
		case 'lfs-verify':
		case 'writes':
			return 'push';
		default:
			return 'read';
	}
}

/**
 * A request body, read whole: gunzipped when sent so, and null as soon as
 * it passes `maxBytes` (`MAX_PUSH_BYTES` for a push, `MAX_WRITE_BYTES` for
 * a web write), so an oversized body is never held in memory.
 */
async function readBody(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array | null> {
	if (request.body === null) return new Uint8Array();
	const body: ReadableStream<Uint8Array> =
		request.headers.get('content-encoding') === 'gzip'
			? request.body.pipeThrough(
					new DecompressionStream('gzip') as unknown as ReadableWritablePair<
						Uint8Array,
						Uint8Array
					>,
				)
			: request.body;
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.length;
		if (length > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
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
		access = databaseGitAccess,
		resolveHost,
		resolveLfs = () => null,
	}: {
		/** Installs what `access` reads (the database, for `databaseGitAccess`). */
		setup: MiddlewareHandler<CloudEnv>;
		/** Who may do what; the database by default. */
		access?: GitAccess;
		/** `null` answers 503 `git_unavailable` on every Git request. */
		resolveHost: (env: CloudEnv['Bindings']) => GitHost | null;
		/** Where LFS objects live; `null` answers the LFS routes with 503. */
		resolveLfs?: (env: CloudEnv['Bindings']) => LfsStore | null;
	},
): void {
	const serve = createMiddleware<CloudEnv>(async (c) => {
		const audience = c.var.audiences.git;
		const url = new URL(c.req.url);
		const target = readGitTarget(c.req.method, url, audience);
		if (target?.kind !== 'repository')
			return refuse(
				c,
				404,
				'not_found',
				'Not a Git request this server answers.',
			);
		const { endpoint } = target;
		// Locking is not offered; `git lfs` carries on without it.
		if (endpoint.kind === 'lfs-locks')
			return lfsJson({ message: 'Git LFS locking is not supported.' }, 404);
		const host = resolveHost(c.env);
		if (!host)
			return refuse(
				c,
				503,
				'git_unavailable',
				'This server does not host Git repositories.',
			);
		const lfs = resolveLfs(c.env);
		const needsObjects = endpoint.kind !== 'git';
		if (
			(needsObjects && !host.objects) ||
			(endpoint.kind.startsWith('lfs') && !lfs)
		)
			return refuse(
				c,
				503,
				'git_unavailable',
				'This server does not take web writes or Git LFS yet.',
			);

		let batch: LfsBatch | null = null;
		if (endpoint.kind === 'lfs-batch') {
			const read = readBatch(await c.req.json().catch(() => null));
			if (typeof read === 'string') return lfsJson({ message: read }, 422);
			batch = read;
		}
		const operation = operationOf(endpoint, batch);
		let decided: Awaited<ReturnType<GitAccess['authorize']>>;
		try {
			decided = await access.authorize(c, {
				namespaceId: target.namespaceId,
				name: target.name,
				operation,
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
		const granted = decided.data;
		if (!roleAllows(granted.role, operation))
			return refuse(
				c,
				403,
				'forbidden',
				`This account's role may not ${operation === 'push' ? 'write to' : 'read'} that namespace.`,
				[
					`Bearer resource_metadata="${protectedResourceMetadataUrl(audience)}"`,
				],
			);
		/** The remote as the client named it, ending `.git`. */
		const remote = `${url.origin}${url.pathname.slice(0, url.pathname.indexOf('.git/') + 4)}`;

		let repository = granted.repository;
		if (repository === null) {
			// Reading a name nobody holds creates nothing: one who may write to
			// it sees an empty repository, and anyone else a missing one.
			if (operation === 'read' || endpoint.kind === 'git') {
				if (endpoint.kind === 'git' && endpoint.advertisement) {
					if (!roleAllows(granted.role, 'push'))
						return refuse(
							c,
							404,
							'not_found',
							`No repository is named ${target.namespaceId}/${target.name}.`,
						);
					return endpoint.service === 'git-receive-pack' && host.objects
						? receiveAdvertisement(null)
						: emptyAdvertisement(endpoint.service);
				}
				if (endpoint.kind === 'files')
					return c.json({ commit: null, files: [] });
				if (endpoint.kind === 'lfs-batch' && lfs && batch)
					return answerBatch(lfs, null, batch, remote);
				if (operation === 'read')
					return refuse(
						c,
						404,
						'not_found',
						`No repository is named ${target.namespaceId}/${target.name}.`,
					);
			}
			// The first write makes the repository.
			try {
				repository = await access.create(c, {
					namespaceId: granted.namespaceId,
					name: target.name,
					host,
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

		if (
			endpoint.kind !== 'git' ||
			(endpoint.service === 'git-receive-pack' && host.objects)
		)
			return serveObjects(c, {
				host,
				lfs,
				repositoryId: repository.id,
				endpoint,
				batch,
				remote,
				accountId: granted.accountId,
				role: granted.role,
			});

		const headers = new Headers();
		for (const header of FORWARDED_HEADERS) {
			const value = c.req.header(header);
			if (value !== undefined) headers.set(header, value);
		}
		let upstream: Response;
		try {
			upstream = await host.serve(repository.id, {
				service: endpoint.service,
				advertisement: endpoint.advertisement,
				headers,
				body: endpoint.advertisement ? null : c.req.raw.body,
				signal: c.req.raw.signal,
				accountId: granted.accountId,
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

	/** The receiver, the translator and LFS, over the store's objects. */
	async function serveObjects(
		c: Context<CloudEnv>,
		{
			host,
			lfs,
			repositoryId,
			endpoint,
			batch,
			remote,
			accountId,
			role,
		}: {
			host: GitHost;
			lfs: LfsStore | null;
			repositoryId: string;
			endpoint: GitEndpoint;
			batch: LfsBatch | null;
			remote: string;
			accountId: string;
			role: RepositoryRole;
		},
	): Promise<Response> {
		if (lfs) {
			if (endpoint.kind === 'lfs-batch' && batch)
				return answerBatch(lfs, repositoryId, batch, remote);
			if (endpoint.kind === 'lfs-object')
				return endpoint.upload
					? putObject(lfs, repositoryId, endpoint.oid, c.req.raw)
					: getObject(lfs, repositoryId, endpoint.oid);
			if (endpoint.kind === 'lfs-verify')
				return verifyObject(
					lfs,
					repositoryId,
					await c.req.json().catch(() => null),
				);
		}
		const objects = host.objects?.(repositoryId);
		if (!objects)
			return refuse(c, 503, 'git_unavailable', 'This store has no objects.');
		try {
			switch (endpoint.kind) {
				case 'git': {
					if (endpoint.advertisement)
						return await receiveAdvertisement(objects);
					const body = await readBody(c.req.raw, MAX_PUSH_BYTES);
					if (body === null)
						return refuse(c, 413, 'too_large', 'A push may be at most 64 MiB.');
					return await receivePush({
						objects,
						lfs,
						repositoryId,
						body,
						mayRewrite: roleAllows(role, 'rewrite'),
					});
				}
				case 'files':
					return await listRepositoryFiles(objects, c.req.query('root'));
				case 'file':
					return await readRepositoryFile(objects, c.req.query('path'));
				case 'writes': {
					const raw = await readBody(c.req.raw, MAX_WRITE_BYTES);
					if (raw === null)
						return refuse(
							c,
							413,
							'too_large',
							`A web write may be at most ${MAX_WRITE_BYTES / (1024 * 1024)} MiB; send fewer files at once.`,
						);
					let body: unknown = null;
					try {
						body = JSON.parse(new TextDecoder().decode(raw));
					} catch {}
					const request = readWriteRequest(body);
					if ('status' in request)
						return c.json(
							{
								error: request.error,
								error_description: request.message,
								path: request.path,
							},
							request.status,
						);
					return await applyWrite({
						objects,
						lfs,
						repositoryId,
						request,
						author: {
							name: 'Epicenter (web)',
							email: `${accountId}@accounts.epicenter.invalid`,
						},
					});
				}
				default:
					return refuse(
						c,
						404,
						'not_found',
						'Not a Git request this server answers.',
					);
			}
		} catch (cause) {
			log.error(GitHostError.ServeFailed({ cause }).error);
			return refuse(
				c,
				502,
				'store_failed',
				'The repository could not be reached.',
			);
		} finally {
			objects.close();
		}
	}

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

	/**
	 * The owner's sharing routes, decided by `access` like any Git request:
	 * listing reads, a change writes, and both need the `manage` role. One
	 * who may not manage the repository gets 403 whether or not it exists.
	 */
	const grants = (action: 'list' | 'grant' | 'revoke') =>
		createMiddleware<CloudEnv>(async (c) => {
			const namespaceId = c.req.param('namespace') ?? '';
			const name = c.req.param('name') ?? '';
			if (
				(namespaceId !== PERSONAL_NAMESPACE && !isNamespaceId(namespaceId)) ||
				!isRepositoryName(name)
			)
				return refuse(
					c,
					404,
					'not_found',
					'Not a repository this server names.',
				);
			try {
				const decided = await access.authorize(c, {
					namespaceId,
					name,
					operation: action === 'list' ? 'read' : 'push',
				});
				if (decided.error !== null)
					return refuse(
						c,
						decided.error.status,
						decided.error.body.error,
						decided.error.body.error_description,
						[decided.error.challenge],
					);
				const { role, repository } = decided.data;
				if (!roleAllows(role, 'manage'))
					return refuse(
						c,
						403,
						'forbidden',
						"Only the repository's owner may share it.",
						[
							`Bearer resource_metadata="${protectedResourceMetadataUrl(c.var.audiences.git)}"`,
						],
					);
				if (repository === null)
					return refuse(
						c,
						404,
						'not_found',
						`No repository is named ${namespaceId}/${name}.`,
					);
				let level: GrantLevel | undefined;
				if (action === 'grant') {
					const body = (await c.req.json().catch(() => null)) as {
						level?: unknown;
					} | null;
					if (body?.level !== 'read' && body?.level !== 'write')
						return refuse(
							c,
							400,
							'invalid_request',
							'Send { "level": "read" } or { "level": "write" }.',
						);
					level = body.level;
				}
				const noStore = { 'cache-control': 'no-store' };
				if (action === 'list') {
					const body: RepositoryGrants = {
						grants: await listRepositoryGrants(c.var.db, repository.id),
					};
					return c.json(body, 200, noStore);
				}
				const person = c.req.param('person') ?? '';
				if (level !== undefined) {
					const { data, error } = await grantRepository(c.var.db, {
						repositoryId: repository.id,
						namespaceId: decided.data.namespaceId,
						person,
						level,
					});
					if (error !== null)
						return error.name === 'UnknownPerson'
							? refuse(c, 404, 'not_found', error.message)
							: refuse(c, 400, 'invalid_request', error.message);
					return c.json(data, 200, noStore);
				}
				const { data, error } = await revokeRepositoryGrant(c.var.db, {
					repositoryId: repository.id,
					person,
				});
				if (error !== null) return refuse(c, 404, 'not_found', error.message);
				const body: RepositoryGrantRevoked = { person, revoked: data };
				return c.json(body, 200, noStore);
			} catch (cause) {
				log.error(GitHostError.AuthorizeFailed({ cause }).error);
				return refuse(
					c,
					503,
					'git_unavailable',
					'The request could not be checked. Try again.',
				);
			}
		});
	app.get('/api/repos/:namespace/:name/grants', setup, grants('list'));
	app.put('/api/repos/:namespace/:name/grants/:person', setup, grants('grant'));
	app.delete(
		'/api/repos/:namespace/:name/grants/:person',
		setup,
		grants('revoke'),
	);
}
