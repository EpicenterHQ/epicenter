/**
 * Folders on their audience (ADR-0811, ADR-0824, ADR-0828): each folder's
 * history is a log in Postgres, with its larger bytes in a blob store,
 * reached at `<folders>/<folder>`.
 *
 * ```txt
 * <folders>                         POST  folders:write: make a folder ({ create, import? }), or join an app's ({ join })
 * <folders>                         GET   folders:read: every folder's head, as a cursor
 * <folders>/<folder>/…                    one folder's routes, folder.ts
 * <api>/api/folders…                      the person's folders, sharing, and apps, folders-api.ts
 * ```
 *
 * `<folders>` is the folders audience, `<api origin>/folders` on every
 * deployment (`resolveOAuthAudiences`): the OAuth resource every folder
 * token names, and the address of the routes themselves. No Git client
 * reaches it: history leaves as Git through `epicenter export --git`, and
 * enters through `epicenter import --git` (ADR-0826).
 *
 * A folder exists from the request that makes it, `POST <folders>
 * { create: true, app? }`, which never joins: it makes a new folder held by
 * the person, attached to the app whose token asked (or, from a token with
 * `folders:all`, to the app it names). `import: true` makes it take
 * imported changes until the import is done. Joining is a separate request
 * that names its app, `{ join: <app> }`, as a web app's first open sends
 * it: the one folder attached to that app the person holds, `choose` when
 * they hold several, and 404 `none` when they hold none. An app's token
 * joins only its own app's folder.
 *
 * Every request is decided by the deployment's `FolderGuard`. The hosted
 * cloud's (`databaseFolderGuard`) is one statement
 * (`authorizeFolderRequest`): the access token with its audience and scope;
 * the caller's membership in the folder and its role (`folder-roles.ts`);
 * and the token's reach, every folder for `folders:all` and the folders
 * attached to its app otherwise. Nothing is cached, so a revoked token, a
 * removed member, or a detached app is refused on the next request.
 *
 * Refusals answer JSON `{ error, error_description }`:
 *   - 401 `invalid_token`        missing, unknown, expired, revoked, or another
 *                                audience's token, with `WWW-Authenticate`
 *                                naming `resource_metadata` (RFC 9728);
 *   - 403 `insufficient_scope`   the token lacks the operation's scope;
 *   - 403 `forbidden`            the caller does not hold the folder, the
 *                                folder is not attached to the token's app, or
 *                                the caller's role may not do this;
 *   - 404 `none`                 a join of an app the person holds no folder
 *                                attached to;
 *   - 409 `choose`               a join of an app whose person holds several
 *                                folders attached to it, listed in `folders`;
 *   - 413 `too_large`            a body over the route's limit;
 *   - 502 `store_failed`         the blob store failed;
 *   - 503 `unavailable`          the database could not decide.
 *
 * Folders are unmetered: Autumn denies by default without a plan, so this
 * mount takes no billing policy.
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
import type { BlobStore } from '../log/blob-store.js';
import { folderHeads } from '../log/read.js';
import type { CloudEnv } from '../types.js';
import {
	type FolderEndpoint,
	folderBlobs,
	folderChanges,
	folderCommit,
	folderFiles,
	folderImport,
	folderLog,
	folderMarks,
	folderMissing,
	folderOperation,
	getBlob,
	MAX_COMMIT_BYTES,
	MAX_NAMED,
	putBlobRoute,
	putMark,
	readFolderEndpoint,
} from './folder.js';
import { mountFolderApi } from './folders-api.js';

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
 * database (`databaseFolderGuard`, the default); a test may inject its own.
 * Every rule after the decision (roles, the log, bytes) is this module's,
 * so each deployment runs the same routes.
 */
export type FolderGuard = {
	/** Decide `operation` on `folder` from the caller's credential (`c.req`). */
	authorize(
		c: Context<CloudEnv>,
		target: { folder: string; operation: 'read' | 'push' },
	): Promise<Result<FolderAccess, ResourceRefusal>>;
	/**
	 * Make a folder (`create`), which never joins; or join the one folder
	 * attached to the app `join` names that the caller holds.
	 */
	join(
		c: Context<CloudEnv>,
		request: FolderRequest,
	): Promise<Result<JoinedFolder, JoinRefusal>>;
};

/**
 * The hosted cloud's guard: one statement (`authorizeFolderRequest`) over
 * the token, the folder's membership, and its attachments. Reads `c.var.db`,
 * which `mountFolders`'s `setup` installs.
 */
export const databaseFolderGuard: FolderGuard = {
	authorize: (c, { folder, operation }) =>
		authorizeFolderRequest(c.var.db, {
			token: readAccessToken(c.req.header('authorization')),
			audience: c.var.audiences.folders,
			scope: operation === 'push' ? 'folders:write' : 'folders:read',
			folder,
		}),
	async join(c, request) {
		const decided = await authorizeAccountRequest(c.var.db, {
			token: readAccessToken(c.req.header('authorization')),
			audience: c.var.audiences.folders,
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
			const id = newFolderId();
			await createFolder(c.var.db, {
				id,
				accountId,
				app: app ?? request.app ?? null,
				importing: request.import === true,
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

/** Operator diagnostics. Their causes stay in the log, off the wire. */
const FolderHostError = defineErrors({
	AuthorizeFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not decide a folder request: ${extractErrorMessage(cause)}`,
		cause,
	}),
	CreateFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not make a folder: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ServeFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not serve a folder request: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const log = createLogger('folders');

/** A request under the folders audience, read from its URL. */
export type FoldersTarget =
	/** One folder's routes (`folder.ts`). */
	| { kind: 'folder'; folder: string; endpoint: FolderEndpoint }
	/** `POST <folders>`: join or make a folder. */
	| { kind: 'join' }
	/** `GET <folders>`: every folder's head. */
	| { kind: 'heads' }
	| { kind: 'unknown' };

/**
 * The request `url` makes under `audience`, `{ kind: 'unknown' }` for any
 * other path under it, or `undefined` when it is not under it at all.
 */
export function readFoldersTarget(
	method: string,
	url: URL,
	audience: string,
): FoldersTarget | undefined {
	const base = new URL(audience);
	if (url.host !== base.host || url.protocol !== base.protocol)
		return undefined;
	const prefix = base.pathname.replace(/\/+$/, '');
	if (
		prefix !== '' &&
		url.pathname !== prefix &&
		!url.pathname.startsWith(`${prefix}/`)
	)
		return undefined;
	const below = url.pathname.slice(prefix.length);
	if (below === '') {
		if (url.search !== '') return { kind: 'unknown' };
		return method === 'POST'
			? { kind: 'join' }
			: method === 'GET'
				? { kind: 'heads' }
				: { kind: 'unknown' };
	}
	const folder = /^\/([^/]+)\/(.+)$/.exec(below);
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
	return refuse(c, status, body.error, body.error_description, [challenge]);
}

/**
 * A request body, read whole: gunzipped when sent so, and null as soon as
 * it passes `maxBytes`, so an oversized body is never held in memory.
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
 * The body of `POST <folders>`, or null when it is neither shape: a
 * create naming at most an app id and whether it imports, or a join naming
 * one app.
 */
export function readFolderRequest(body: unknown): FolderRequest | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body))
		return null;
	const fields = body as Record<string, unknown>;
	const keys = Object.keys(fields);
	const appId = (value: unknown): value is string =>
		typeof value === 'string' && isAppId(value);
	if (fields.create === true) {
		if (keys.some((key) => !['create', 'app', 'import'].includes(key)))
			return null;
		if (fields.import !== undefined && fields.import !== true) return null;
		if (fields.app !== undefined && !appId(fields.app)) return null;
		return {
			create: true,
			...(fields.app === undefined ? {} : { app: fields.app as string }),
			...(fields.import === true ? { import: true as const } : {}),
		};
	}
	if (keys.length === 1 && appId(fields.join)) return { join: fields.join };
	return null;
}

/**
 * Mount folders on their audience, and their listing, sharing, and apps
 * on the API's origin (`folders-api.ts`), both for a folders-audience
 * token. `setup` installs the database (`c.var.db`), which every request
 * reads; `resolveBlobs` is where bytes over `INLINE_MAX` live, null for
 * none (an upload of them answers 503).
 */
export function mountFolders(
	app: Hono<CloudEnv>,
	{
		setup,
		guard = databaseFolderGuard,
		resolveBlobs,
	}: {
		setup: MiddlewareHandler<CloudEnv>;
		guard?: FolderGuard;
		resolveBlobs: (env: CloudEnv['Bindings']) => BlobStore | null;
	},
): void {
	const unavailable = (c: Context<CloudEnv>) =>
		refuse(
			c,
			503,
			'unavailable',
			'The request could not be checked. Try again.',
		);

	/** Decide `operation` on `folder`: what the caller may do, or the refusal to send. */
	async function decide(
		c: Context<CloudEnv>,
		target: { folder: string; operation: 'read' | 'push' },
	): Promise<{ granted: FolderAccess } | { refused: Response }> {
		let decided: Awaited<ReturnType<FolderGuard['authorize']>>;
		try {
			decided = await guard.authorize(c, target);
		} catch (cause) {
			log.error(FolderHostError.AuthorizeFailed({ cause }).error);
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
						`Bearer resource_metadata="${protectedResourceMetadataUrl(c.var.audiences.folders)}"`,
					],
				),
			};
		return { granted: decided.data };
	}

	/** `POST <folders>`: make a folder (never joining), or join an app's. */
	async function join(c: Context<CloudEnv>) {
		const request = readFolderRequest(await c.req.json().catch(() => null));
		if (request === null)
			return refuse(
				c,
				400,
				'invalid_request',
				"Send { create: true, app?, import? } to make a folder, or { join: <app> } to join an app's folder.",
			);
		let joined: Awaited<ReturnType<FolderGuard['join']>>;
		try {
			joined = await guard.join(c, request);
		} catch (cause) {
			log.error(FolderHostError.CreateFailed({ cause }).error);
			return unavailable(c);
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
	 * `GET <folders>`: the head of every folder the token reaches, as a
	 * cursor: one statement a program polls to learn which of its folders
	 * moved (ADR-0819).
	 */
	async function heads(c: Context<CloudEnv>) {
		try {
			const decided = await authorizeAccountRequest(c.var.db, {
				token: readAccessToken(c.req.header('authorization')),
				audience: c.var.audiences.folders,
				scope: 'folders:read',
			});
			if (decided.error !== null) return sendRefusal(c, decided.error);
			return c.json({ heads: await folderHeads(c.var.db, decided.data) }, 200, {
				'cache-control': 'no-store',
			});
		} catch (cause) {
			log.error(FolderHostError.AuthorizeFailed({ cause }).error);
			return unavailable(c);
		}
	}

	/** One folder's routes (`folder.ts`). */
	async function serveFolder(
		c: Context<CloudEnv>,
		{ folder, endpoint }: { folder: string; endpoint: FolderEndpoint },
	): Promise<Response> {
		const decided = await decide(c, {
			folder,
			operation: folderOperation(endpoint),
		});
		if ('refused' in decided) return decided.refused;
		const { granted } = decided;
		const db = c.var.db;
		const store = resolveBlobs(c.env);
		/** The JSON body of the request: null over `maxBytes`, undefined when it is no JSON. */
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
		const writer = {
			folder,
			account: granted.accountId,
			via: granted.clientId,
		};
		try {
			switch (endpoint.kind) {
				case 'changes':
					return await folderChanges(db, folder, c.req.query('since'));
				case 'files': {
					const body = await bodyOf(MAX_NAMED * 1100);
					return body === null
						? tooLarge()
						: await folderFiles(db, folder, body);
				}
				case 'log':
					return await folderLog(db, folder, c.req.query());
				case 'marks':
					return await folderMarks(db, folder);
				case 'mark': {
					const body = await bodyOf(4096);
					return body === null
						? tooLarge()
						: await putMark(db, {
								folder,
								name: endpoint.name,
								account: granted.accountId,
								body,
							});
				}
				case 'blobs': {
					const body = await bodyOf(MAX_NAMED * 80);
					return body === null
						? tooLarge()
						: await folderBlobs(db, folder, body);
				}
				case 'missing': {
					const body = await bodyOf(MAX_NAMED * 80);
					return body === null
						? tooLarge()
						: await folderMissing(db, folder, body);
				}
				case 'blob':
					return endpoint.upload
						? await putBlobRoute({
								db,
								store,
								folder,
								version: endpoint.version,
								request: c.req.raw,
							})
						: await getBlob(db, store, folder, endpoint.version);
				case 'commits': {
					const body = await bodyOf(MAX_COMMIT_BYTES);
					return body === null
						? tooLarge()
						: await folderCommit(db, { ...writer, body });
				}
				case 'import': {
					const body = await bodyOf(MAX_COMMIT_BYTES);
					return body === null
						? tooLarge()
						: await folderImport(db, { ...writer, body, store });
				}
			}
		} catch (cause) {
			log.error(FolderHostError.ServeFailed({ cause }).error);
			return refuse(c, 502, 'store_failed', 'The folder could not be reached.');
		}
	}

	const serve = createMiddleware<CloudEnv>(async (c) => {
		const target = readFoldersTarget(
			c.req.method,
			new URL(c.req.url),
			c.var.audiences.folders,
		);
		switch (target?.kind) {
			case 'join':
				return join(c);
			case 'heads':
				return heads(c);
			case 'folder':
				return serveFolder(c, target);
			default:
				return refuse(c, 404, 'not_found', 'Not a folder request.');
		}
	});

	const handle = every(setup, serve);
	app.use('*', async (c, next) => {
		const target = readFoldersTarget(
			c.req.method,
			new URL(c.req.url),
			c.var.audiences.folders,
		);
		if (target === undefined) return next();
		return handle(c, next);
	});

	mountFolderApi(app, { setup, resolveBlobs });
}
