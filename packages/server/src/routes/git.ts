/**
 * Folders on the Git audience (ADR-0811): each folder's history is a Git
 * repository that storage names by the folder's id, reached by sync at
 * `<git audience>/folders/<folder>` and by plain Git at
 * `<git audience>/folders/<folder>.git`.
 *
 * ```txt
 * <git>/folders                                   POST  folders:write: make a folder ({ create }), or join an app's ({ join })
 * <git>/folders                                   GET   folders:read: where main is in every folder the token reaches
 * <git>/folders/<folder>/{changes,tree,blobs,commits}   sync's routes, folder.ts
 * <git>/folders/<folder>.git/info/refs?service=…  GET   folders:read, read  (receive-pack: folders:write, push)
 * <git>/folders/<folder>.git/git-upload-pack      POST  folders:read, read
 * <git>/folders/<folder>.git/git-receive-pack     POST  folders:write, push (rewrite: member); the receiver, receive.ts
 * <git>/folders/<folder>.git/info/lfs/…           Git LFS, lfs.ts
 * <api>/api/folders…                              the person's folders, sharing, and apps, folders-api.ts
 * ```
 *
 * A folder exists from the request that makes it, `POST <git>/folders
 * { create: true, app? }`, which never joins: it makes a new folder held by
 * the person, attached to the app whose token asked (or, from a token with
 * `folders:all`, to the app it names). Joining is a separate request that
 * names its app, `{ join: <app> }`, as a web app's first open sends it: the
 * one folder attached to that app the person holds, `choose` when they hold
 * several, and 404 `none` when they hold none. An app's token joins only its
 * own app's folder. Nothing else creates a folder: a push to an id no one
 * holds is refused like any request to a folder the caller does not hold.
 *
 * The Git audience is `https://git.epicenter.so` for the hosted cloud and
 * `<origin>/git` for any other deployment (`resolveOAuthAudiences`), so a
 * request is Git's when its host and path fall under that audience.
 *
 * Every request is decided by the deployment's `GitAccess`. The hosted
 * cloud's (`databaseGitAccess`) is one statement (`authorizeFolderRequest`):
 * the access token, presented as a Bearer token or as the password of Basic
 * credentials, with its audience and scope; the caller's membership in the
 * folder and its role (`folder-roles.ts`); and the token's reach, every
 * folder for `folders:all` and the folders attached to its app otherwise.
 * Nothing is cached, so a revoked token, a removed member, or a detached
 * app is refused on the next request.
 *
 * The store (`GitHost`) is the replaceable part: Cloudflare Artifacts on the
 * Worker, bare repositories on disk for the Bun entry. It names a
 * repository by its folder's id and receives only requests this module
 * already authorized; the client's credential never reaches it. The store
 * serves clone and fetch; every push goes through the receiver, and a
 * folder's and the LFS routes over its `objects`. LFS answers 503 until the
 * deployment has an LFS store.
 *
 * Refusals answer JSON `{ error, error_description }`:
 *   - 401 `invalid_token`        missing, unknown, expired, revoked, or another
 *                                audience's token, with `WWW-Authenticate`
 *                                naming `resource_metadata` (RFC 9728), plus a
 *                                Basic challenge for terminal Git;
 *   - 403 `insufficient_scope`   the token lacks the operation's scope;
 *   - 403 `forbidden`            the caller does not hold the folder, the
 *                                folder is not attached to the token's app, or
 *                                the caller's role may not do this;
 *   - 404 `none`                 a join of an app the person holds no folder
 *                                attached to;
 *   - 409 `choose`               a join of an app whose person holds several
 *                                folders attached to it, listed in `folders`;
 *   - 413 `too_large`            a push over the store's `pushBytes` (64 MiB on disk);
 *   - 502 `store_failed`         storage failed or refused this server;
 *   - 503 `git_unavailable`      this deployment has no store, or its database
 *                                could not decide.
 *
 * Hosted Git is unmetered: Autumn denies by default without
 * a plan, so this mount takes no billing policy.
 */

import {
	type FolderRequest,
	isAppId,
	isFolderId,
	type JoinedFolder,
} from '@epicenter/definition/site';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { every } from 'hono/combine';
import { createMiddleware } from 'hono/factory';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	authorizeAccountRequest,
	authorizeFolderRequest,
	type FolderAccess,
	protectedResourceMetadataUrl,
	type ResourceRefusal,
	readAccessToken,
} from '../auth/resource-access.js';
import { roleAllows } from '../folder-roles.js';
import { createFolder, heldFolders, newFolderId } from '../folders.js';
import { type GitObjects, MAIN } from '../git/objects.js';
import type { LfsStore } from '../lfs/lfs-store.js';
import type { CloudEnv } from '../types.js';
import { databaseUploadLedger, type UploadLedger } from '../uploads.js';
import {
	type FolderEndpoint,
	folderBlob,
	folderBlobs,
	folderChanges,
	folderCommit,
	folderLog,
	folderOperation,
	folderTree,
	getAttachment,
	MAX_COMMIT_BYTES,
	MAX_NAMED,
	putAttachment,
	readCommitRequest,
	readFolderEndpoint,
} from './folder.js';
import { mountFolderApi } from './folders-api.js';
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
	RECEIVE_LIMITS,
	type ReceiveLimits,
	receiveAdvertisement,
	receivePush,
} from './receive.js';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

/** One authorized clone or fetch request, as a store receives it. */
export type GitRequest = {
	service: 'git-upload-pack';
	/** `GET info/refs?service=…` rather than `POST <service>`. */
	advertisement: boolean;
	/** The request's `content-type`, `content-encoding`, `accept`, and `git-protocol`; never a credential. */
	headers: Headers;
	body: ReadableStream<Uint8Array> | null;
	signal: AbortSignal;
	/** The account this server authorized, for the store's own records. */
	accountId: string;
};

/** Where folders' repositories are stored, by folder id. The rows live in Postgres. */
export type GitHost = {
	/**
	 * Answer one authorized clone or fetch request for repository `id`; a
	 * push goes through the receiver over `objects`. Throws when storage
	 * cannot be reached.
	 */
	serve(id: string, request: GitRequest): Promise<Response>;
	/**
	 * Make an empty repository `id`, whose default branch is `main`, when
	 * its folder is made. Making one that exists is not an error.
	 */
	create(id: string): Promise<void>;
	/**
	 * Remove repository `id`'s storage, after its folder's row is gone.
	 * Removing one that does not exist is not an error.
	 */
	delete(id: string): Promise<void>;
	/**
	 * Repository `id`'s objects and refs, for the push receiver and the
	 * folder's routes; the caller closes the handle.
	 */
	objects(id: string): GitObjects;
	/** What one push may cost this store; the disk server's (`RECEIVE_LIMITS`) by default. */
	receiveLimits?: ReceiveLimits;
};

/** Why a request to make or join a folder made nothing and joined nothing. */
export type JoinRefusal =
	| ResourceRefusal
	| { status: 403; error: 'forbidden'; description: string }
	| { status: 404; error: 'none'; description: string }
	| {
			status: 409;
			error: 'choose';
			description: string;
			/** The folders attached to the app that the person holds. */
			folders: string[];
	  };

/**
 * Who may do what to which folder. The hosted cloud decides from the
 * database (`databaseGitAccess`, the default); a test with no database
 * injects its own. Every rule after the decision (roles, the receiver, the
 * folder's routes, LFS) is this module's, so each deployment runs the same
 * routes.
 */
export type GitAccess = {
	/** Decide `operation` on `folder` from the caller's credential (`c.req`). */
	authorize(
		c: Context<CloudEnv>,
		target: { folder: string; operation: 'read' | 'push' },
	): Promise<Result<FolderAccess, ResourceRefusal>>;
	/**
	 * Make a folder (`create`), its storage first, which never joins; or
	 * join the one folder attached to the app `join` names that the caller
	 * holds.
	 */
	join(
		c: Context<CloudEnv>,
		target: { request: FolderRequest; host: GitHost },
	): Promise<Result<JoinedFolder, JoinRefusal>>;
};

/**
 * The hosted cloud's access: one statement (`authorizeFolderRequest`) over
 * the token, the folder's membership, and its attachments. Reads `c.var.db`,
 * which `mountGitHost`'s `setup` installs.
 */
export const databaseGitAccess: GitAccess = {
	authorize: (c, { folder, operation }) =>
		authorizeFolderRequest(c.var.db, {
			token: readAccessToken(c.req.header('authorization')),
			audience: c.var.audiences.git,
			scope: operation === 'push' ? 'folders:write' : 'folders:read',
			folder,
		}),
	async join(c, { request, host }) {
		const decided = await authorizeAccountRequest(c.var.db, {
			token: readAccessToken(c.req.header('authorization')),
			audience: c.var.audiences.git,
			scope: 'folders:write',
		});
		if (decided.error !== null) return decided;
		const { accountId, app } = decided.data;
		if ('create' in request) {
			// An app's token makes its own app's folder; only a token that
			// reaches every folder attaches a new one to another app.
			if (app !== null && request.app !== undefined && request.app !== app)
				return Err({
					status: 403,
					error: 'forbidden',
					description: "An app's token makes only its own app's folder.",
				});
			// Storage comes first, so no row ever names a folder that has none.
			// Storage made for `id` stays if the insert fails: it may have
			// committed and lost only its reply.
			const id = newFolderId();
			await host.create(id);
			await createFolder(c.var.db, {
				id,
				accountId,
				app: app ?? request.app ?? null,
			});
			return Ok({ folder: id, made: true });
		}
		if (app !== null && request.join !== app)
			return Err({
				status: 403,
				error: 'forbidden',
				description: "An app's token joins only its own app's folder.",
			});
		// A reader joins too: a sync of a folder they hold reads it.
		const held = await heldFolders(c.var.db, { accountId, app: request.join });
		const [only, ...more] = held;
		if (only === undefined)
			return Err({
				status: 404,
				error: 'none',
				description: 'You hold no folder this app uses.',
			});
		if (more.length > 0)
			return Err({
				status: 409,
				error: 'choose',
				description:
					'You hold several folders this app uses: name the one to open.',
				folders: held.map(({ id }) => id),
			});
		return Ok({ folder: only.id, made: false });
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
	CreateFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not make a folder: ${extractErrorMessage(cause)}`,
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

/** What a request to a folder's Git remote asks for. */
export type GitEndpoint =
	| { kind: 'git'; service: GitService; advertisement: boolean }
	| { kind: 'lfs-batch' }
	| { kind: 'lfs-object'; oid: string; upload: boolean }
	| { kind: 'lfs-verify' }
	| { kind: 'lfs-locks' };

/** A request under the Git audience, read from its URL. */
export type GitTarget =
	/** The folder's Git remote, `<git>/folders/<folder>.git/…`. */
	| { kind: 'repository'; folder: string; endpoint: GitEndpoint }
	/** Sync's routes of the folder `folder` (`folder.ts`). */
	| { kind: 'folder'; folder: string; endpoint: FolderEndpoint }
	/** `POST <git>/folders`: join or make a folder. */
	| { kind: 'join' }
	/** `GET <git>/folders`: where main is in every folder the token reaches. */
	| { kind: 'heads' }
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
	const below = url.pathname.slice(prefix.length);
	if (below === '/folders') {
		if (url.search !== '') return { kind: 'unknown' };
		return method === 'POST'
			? { kind: 'join' }
			: method === 'GET'
				? { kind: 'heads' }
				: { kind: 'unknown' };
	}
	const remote = /^\/folders\/([^/]+)\.git\/(.+)$/.exec(below);
	if (remote !== null) {
		const [, id = '', rest = ''] = remote;
		const endpoint = readEndpoint(method, rest, url);
		return isFolderId(id) && endpoint !== undefined
			? { kind: 'repository', folder: id, endpoint }
			: { kind: 'unknown' };
	}
	const folder = /^\/folders\/([^/]+)\/(.+)$/.exec(below);
	if (folder !== null) {
		const [, id = '', rest = ''] = folder;
		const endpoint = readFolderEndpoint(method, rest);
		return isFolderId(id) && endpoint !== undefined
			? { kind: 'folder', folder: id, endpoint }
			: { kind: 'unknown' };
	}
	return { kind: 'unknown' };
}

function refuse(
	c: Context<CloudEnv>,
	status: 400 | 401 | 403 | 404 | 409 | 413 | 502 | 503,
	error: string,
	description: string,
	challenges: string[] = [],
	extra: Record<string, unknown> = {},
) {
	const response = c.json(
		{ error, error_description: description, ...extra },
		status,
	);
	for (const challenge of challenges)
		response.headers.append('www-authenticate', challenge);
	return response;
}

/** A refusal from `authorizeFolderRequest` or `authorizeAccountRequest`, as sent. */
export function sendRefusal(c: Context<CloudEnv>, refusal: ResourceRefusal) {
	const { status, challenge, body } = refusal;
	// A browser must see a readable 401, not a login prompt; terminal Git
	// asks its credential helper only after a Basic challenge.
	const basic =
		status === 401 && c.req.header('origin') === undefined
			? ['Basic realm="Epicenter"']
			: [];
	return refuse(c, status, body.error, body.error_description, [
		challenge,
		...basic,
	]);
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
			return 'push';
		default:
			return 'read';
	}
}

/**
 * A request body, read whole: gunzipped when sent so, and null as soon as
 * it passes `maxBytes` (`ReceiveLimits.pushBytes` for a push, `MAX_COMMIT_BYTES`
 * for a folder's commit), so an oversized body is never held in memory.
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
 * The body of `POST <git>/folders`, or null when it is neither shape: a
 * create naming at most an app id, or a join naming one.
 */
export function readFolderRequest(body: unknown): FolderRequest | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body))
		return null;
	const fields = body as Record<string, unknown>;
	const keys = Object.keys(fields);
	const appId = (value: unknown): value is string =>
		typeof value === 'string' && isAppId(value);
	if (fields.create === true) {
		if (keys.some((key) => key !== 'create' && key !== 'app')) return null;
		if (fields.app === undefined) return { create: true };
		return appId(fields.app) ? { create: true, app: fields.app } : null;
	}
	if (keys.length === 1 && appId(fields.join)) return { join: fields.join };
	return null;
}

/**
 * Mount folders on the Git audience, and their listing, sharing, and apps
 * on the API's origin (`folders-api.ts`), both for a Git-audience token.
 * `setup` installs the database (`c.var.db`), which every request reads.
 */
export function mountGitHost(
	app: Hono<CloudEnv>,
	{
		setup,
		access = databaseGitAccess,
		resolveHost,
		resolveLfs = () => null,
		uploads = (c) => (c.var.db ? databaseUploadLedger(c.var.db) : null),
	}: {
		/** Installs what `access` reads (the database, for `databaseGitAccess`). */
		setup: MiddlewareHandler<CloudEnv>;
		/** Who may do what; the database by default. */
		access?: GitAccess;
		/** `null` answers 503 `git_unavailable` on every Git request. */
		resolveHost: (env: CloudEnv['Bindings']) => GitHost | null;
		/** Where LFS objects live; `null` answers the LFS routes with 503. */
		resolveLfs?: (env: CloudEnv['Bindings']) => LfsStore | null;
		/** The upload ledger (`uploads.ts`); the database's by default, none without one. */
		uploads?: (c: Context<CloudEnv>) => UploadLedger | null;
	},
): void {
	const unavailable = (c: Context<CloudEnv>) =>
		refuse(
			c,
			503,
			'git_unavailable',
			'The request could not be checked. Try again.',
		);

	/**
	 * Decide `operation` on `folder`: what the caller may do, or the refusal
	 * to send.
	 */
	async function decide(
		c: Context<CloudEnv>,
		target: { folder: string; operation: 'read' | 'push' },
	): Promise<{ granted: FolderAccess } | { refused: Response }> {
		let decided: Awaited<ReturnType<GitAccess['authorize']>>;
		try {
			decided = await access.authorize(c, target);
		} catch (cause) {
			log.error(GitHostError.AuthorizeFailed({ cause }).error);
			return { refused: unavailable(c) };
		}
		if (decided.error !== null)
			return { refused: sendRefusal(c, decided.error) };
		if (!roleAllows(decided.data.role, target.operation))
			return {
				refused: refuse(
					c,
					403,
					'forbidden',
					`Your role in this folder may not ${target.operation === 'push' ? 'change' : 'read'} it.`,
					[
						`Bearer resource_metadata="${protectedResourceMetadataUrl(c.var.audiences.git)}"`,
					],
				),
			};
		return { granted: decided.data };
	}

	/**
	 * `POST <git>/folders`: `{ create: true, app? }` makes a folder and never
	 * joins; `{ join: <app> }` joins the one folder attached to that app.
	 */
	async function join(c: Context<CloudEnv>, host: GitHost) {
		const request = readFolderRequest(await c.req.json().catch(() => null));
		if (request === null)
			return refuse(
				c,
				400,
				'invalid_request',
				"Send { create: true, app? } to make a folder, or { join: <app> } to join an app's folder.",
			);
		let joined: Awaited<ReturnType<GitAccess['join']>>;
		try {
			joined = await access.join(c, { request, host });
		} catch (cause) {
			log.error(GitHostError.CreateFailed({ cause }).error);
			return refuse(c, 502, 'store_failed', 'The folder could not be made.');
		}
		if (joined.error !== null) {
			const refusal = joined.error;
			if ('folders' in refusal)
				return refuse(c, 409, refusal.error, refusal.description, [], {
					folders: refusal.folders,
				});
			if ('description' in refusal)
				return refuse(c, refusal.status, refusal.error, refusal.description);
			return sendRefusal(c, refusal);
		}
		return c.json(joined.data, joined.data.made ? 201 : 200, {
			'cache-control': 'no-store',
		});
	}

	/**
	 * `GET <git>/folders`: where `main` is in every folder the token reaches,
	 * null before a folder's first commit: one request a program polls to
	 * learn which of its folders moved (ADR-0819).
	 */
	async function heads(c: Context<CloudEnv>, host: GitHost) {
		let decided: Awaited<ReturnType<typeof authorizeAccountRequest>>;
		try {
			decided = await authorizeAccountRequest(c.var.db, {
				token: readAccessToken(c.req.header('authorization')),
				audience: c.var.audiences.git,
				scope: 'folders:read',
			});
		} catch (cause) {
			log.error(GitHostError.AuthorizeFailed({ cause }).error);
			return unavailable(c);
		}
		if (decided.error !== null) return sendRefusal(c, decided.error);
		const held = await heldFolders(c.var.db, decided.data);
		const answer: Record<string, string | null> = {};
		try {
			await Promise.all(
				held.map(async ({ id }) => {
					const objects = host.objects(id);
					try {
						answer[id] = (await objects.refs()).get(MAIN) ?? null;
					} finally {
						objects.close();
					}
				}),
			);
		} catch (cause) {
			log.error(GitHostError.ServeFailed({ cause }).error);
			return refuse(c, 502, 'store_failed', 'A folder could not be reached.');
		}
		return c.json({ heads: answer }, 200, { 'cache-control': 'no-store' });
	}

	/** Sync's routes of the folder `folder` (`folder.ts`). */
	async function serveFolder(
		c: Context<CloudEnv>,
		{
			host,
			folder,
			endpoint,
		}: { host: GitHost; folder: string; endpoint: FolderEndpoint },
	): Promise<Response> {
		const decided = await decide(c, {
			folder,
			operation: folderOperation(endpoint),
		});
		if ('refused' in decided) return decided.refused;
		const { granted } = decided;
		const lfs = resolveLfs(c.env);
		const ledger = uploads(c);
		if (endpoint.kind === 'attachment') {
			if (lfs === null)
				return refuse(
					c,
					503,
					'git_unavailable',
					'This server does not keep attachments yet.',
				);
			return endpoint.upload
				? putAttachment({
						lfs,
						ledger,
						repositoryId: folder,
						oid: endpoint.oid,
						request: c.req.raw,
					})
				: getAttachment(lfs, folder, endpoint.oid);
		}
		/** The JSON body of the request, or a refusal when it is over `maxBytes`. */
		const bodyOf = async (maxBytes: number) => {
			const raw = await readBody(c.req.raw, maxBytes);
			if (raw === null) return null;
			try {
				return JSON.parse(new TextDecoder().decode(raw)) as unknown;
			} catch {
				return undefined;
			}
		};
		const tooLarge = () =>
			refuse(
				c,
				413,
				'too_large',
				'The request is too large; send less at once.',
			);
		const objects = host.objects(folder);
		try {
			switch (endpoint.kind) {
				case 'changes':
					return await folderChanges(objects, c.req.query('since'));
				case 'log':
					return await folderLog(objects, c.req.query('limit'));
				case 'tree': {
					const body = await bodyOf(MAX_NAMED * 1100);
					return body === null ? tooLarge() : await folderTree(objects, body);
				}
				case 'blobs': {
					const body = await bodyOf(MAX_NAMED * 50);
					return body === null ? tooLarge() : await folderBlobs(objects, body);
				}
				case 'blob':
					return await folderBlob(objects, endpoint.id);
				case 'commits': {
					const body = await bodyOf(MAX_COMMIT_BYTES);
					if (body === null) return tooLarge();
					const files = readCommitRequest(body);
					if (!Array.isArray(files))
						return c.json(
							{
								error: 'invalid_request',
								error_description: files.message,
								path: files.path,
							},
							400,
						);
					return await folderCommit({
						objects,
						lfs,
						ledger,
						repositoryId: folder,
						files,
						author: {
							name: 'Epicenter',
							email: `${granted.accountId}@accounts.epicenter.invalid`,
						},
					});
				}
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

	/** The folder's Git remote: clone, fetch, push, and Git LFS. */
	async function serveRepository(
		c: Context<CloudEnv>,
		{
			host,
			folder,
			endpoint,
		}: { host: GitHost; folder: string; endpoint: GitEndpoint },
	): Promise<Response> {
		const url = new URL(c.req.url);
		const lfs = resolveLfs(c.env);
		if (endpoint.kind.startsWith('lfs') && !lfs)
			return refuse(
				c,
				503,
				'git_unavailable',
				'This server does not take Git LFS objects yet.',
			);
		let batch: LfsBatch | null = null;
		if (endpoint.kind === 'lfs-batch') {
			const read = readBatch(await c.req.json().catch(() => null));
			if (typeof read === 'string') return lfsJson({ message: read }, 422);
			batch = read;
		}
		const decided = await decide(c, {
			folder,
			operation: operationOf(endpoint, batch),
		});
		if ('refused' in decided) return decided.refused;
		const { granted } = decided;
		/** The remote as the client named it, ending `.git`. */
		const remote = `${url.origin}${url.pathname.slice(0, url.pathname.indexOf('.git/') + 4)}`;

		if (endpoint.kind !== 'git' || endpoint.service === 'git-receive-pack')
			return serveObjects(c, {
				host,
				lfs,
				ledger: uploads(c),
				repositoryId: folder,
				endpoint,
				batch,
				remote,
				mayRewrite: roleAllows(granted.role, 'rewrite'),
			});

		const headers = new Headers();
		for (const header of FORWARDED_HEADERS) {
			const value = c.req.header(header);
			if (value !== undefined) headers.set(header, value);
		}
		let upstream: Response;
		try {
			upstream = await host.serve(folder, {
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
	}

	/** The receiver and LFS, over the store's objects. */
	async function serveObjects(
		c: Context<CloudEnv>,
		{
			host,
			lfs,
			ledger,
			repositoryId,
			endpoint,
			batch,
			remote,
			mayRewrite,
		}: {
			host: GitHost;
			lfs: LfsStore | null;
			ledger: UploadLedger | null;
			repositoryId: string;
			endpoint: GitEndpoint;
			batch: LfsBatch | null;
			remote: string;
			mayRewrite: boolean;
		},
	): Promise<Response> {
		if (lfs) {
			if (endpoint.kind === 'lfs-batch' && batch)
				return answerBatch(lfs, repositoryId, batch, remote);
			if (endpoint.kind === 'lfs-object') {
				if (!endpoint.upload) return getObject(lfs, repositoryId, endpoint.oid);
				const length = c.req.header('content-length');
				const held =
					length !== undefined &&
					/^\d+$/.test(length) &&
					(await lfs.verified(repositoryId, {
						oid: endpoint.oid,
						size: Number(length),
					}));
				const stored = await putObject(
					lfs,
					repositoryId,
					endpoint.oid,
					c.req.raw,
				);
				if (stored.ok && !held)
					await ledger?.pending(repositoryId, endpoint.oid);
				return stored;
			}
			if (endpoint.kind === 'lfs-verify')
				return verifyObject(
					lfs,
					repositoryId,
					await c.req.json().catch(() => null),
				);
		}
		const objects = host.objects(repositoryId);
		try {
			switch (endpoint.kind) {
				case 'git': {
					if (endpoint.advertisement)
						return await receiveAdvertisement(objects);
					const limits = host.receiveLimits ?? RECEIVE_LIMITS;
					const body = await readBody(c.req.raw, limits.pushBytes);
					if (body === null)
						return refuse(
							c,
							413,
							'too_large',
							`A push may be at most ${limits.pushBytes / (1024 * 1024)} MiB; push fewer changes at once.`,
						);
					return await receivePush({
						objects,
						lfs,
						ledger,
						repositoryId,
						body,
						mayRewrite,
						limits,
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

	const serve = createMiddleware<CloudEnv>(async (c) => {
		const target = readGitTarget(
			c.req.method,
			new URL(c.req.url),
			c.var.audiences.git,
		);
		if (target === undefined || target.kind === 'unknown')
			return refuse(
				c,
				404,
				'not_found',
				'Not a Git request this server answers.',
			);
		// Locking is not offered; `git lfs` carries on without it.
		if (target.kind === 'repository' && target.endpoint.kind === 'lfs-locks')
			return lfsJson({ message: 'Git LFS locking is not supported.' }, 404);
		const host = resolveHost(c.env);
		if (!host)
			return refuse(
				c,
				503,
				'git_unavailable',
				'This server does not host Git repositories.',
			);
		switch (target.kind) {
			case 'join':
				return join(c, host);
			case 'heads':
				return heads(c, host);
			case 'folder':
				return serveFolder(c, { host, ...target });
			case 'repository':
				return serveRepository(c, { host, ...target });
		}
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

	mountFolderApi(app, { setup, resolveHost });
}
