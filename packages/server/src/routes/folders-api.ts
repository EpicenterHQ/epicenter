/**
 * A person's folders on the API's origin (ADR-0811), for a token on the Git
 * audience, which a client already holds for the folders themselves:
 *
 * ```txt
 * GET    /api/folders                         folders:read   the folders the token reaches, and the shares waiting
 * GET    /api/folders/<id>                    folders:read   one folder
 * POST   /api/folders/<id>/accept             folders:write  accept the share waiting for the caller
 * PUT    /api/folders/<id>/members/<email>    folders:write  { role }: share with a person, or change their role (owner)
 * DELETE /api/folders/<id>/members/<email>    folders:write  unshare (owner), or leave or decline (the person)
 * PUT    /api/folders/<id>/apps/<app>         folders:write  attach the folder to an app (folders:all, writer)
 * DELETE /api/folders/<id>/apps/<app>         folders:write  detach it
 * ```
 *
 * A folder's title is read from its `epicenter.json` at `main`
 * (`folderTitle`); the server keeps none. A share waits for its person to
 * accept it, and until then grants nothing and shows only in `pending`. A
 * token from an app sees the folders attached to it, and the shares of
 * them; attaching a folder to an app is the platform's (`folders:all`), so
 * no app can reach a folder by attaching it to itself. When the last member
 * leaves, the folder is deleted (the `folder_member_left` trigger) and its
 * repository's storage with it.
 */
import {
	FOLDER_ROLES,
	type FolderListing,
	type FolderRole,
	folderRemoteUrl,
	isFolderId,
	isPersonEmail,
	type ListedFolder,
} from '@epicenter/definition/site';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import {
	type AccountAccess,
	authorizeAccountRequest,
	authorizeFolderRequest,
	type FolderAccess,
	readAccessToken,
} from '../auth/resource-access.js';
import { roleAllows } from '../folder-roles.js';
import {
	acceptShare,
	heldFolders,
	membersOf,
	pendingShares,
	removeMember,
	setAttached,
	shareFolder,
} from '../folders.js';
import type { CloudEnv } from '../types.js';
import { folderTitle } from './folder.js';
import type { GitHost } from './git.js';

const FolderApiError = defineErrors({
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `A folder request failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StorageLeft: ({ folder, cause }: { folder: string; cause: unknown }) => ({
		message: `Could not remove the storage of folder ${folder}, which its last member left: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const log = createLogger('folders');

const noStore = { 'cache-control': 'no-store' };

function refuse(
	c: Context<CloudEnv>,
	status: 400 | 401 | 403 | 404 | 409 | 502 | 503,
	error: string,
	description: string,
	challenge?: string,
) {
	const response = c.json({ error, error_description: description }, status);
	if (challenge !== undefined)
		response.headers.set('www-authenticate', challenge);
	return response;
}

/** Mount the folder routes; `setup` installs the database. */
export function mountFolderApi(
	app: Hono<CloudEnv>,
	{
		setup,
		resolveHost,
	}: {
		setup: MiddlewareHandler<CloudEnv>;
		resolveHost: (env: CloudEnv['Bindings']) => GitHost | null;
	},
) {
	/** The titles of `folders` read from their files, by id; null for one without. */
	async function titles(c: Context<CloudEnv>, folders: readonly string[]) {
		const host = resolveHost(c.env);
		const out = new Map<string, string | null>();
		await Promise.all(
			folders.map(async (id) => {
				if (host === null) return out.set(id, null);
				const objects = host.objects(id);
				try {
					out.set(id, await folderTitle(objects));
				} catch (cause) {
					log.warn(FolderApiError.Failed({ cause }).error);
					out.set(id, null);
				} finally {
					objects.close();
				}
			}),
		);
		return out;
	}

	/** The folders `ids` as listed for `access`, in the order given. */
	async function listed(
		c: Context<CloudEnv>,
		access: { accountId: string },
		held: readonly { id: string; role: FolderRole }[],
	): Promise<ListedFolder[]> {
		const ids = held.map(({ id }) => id);
		const [people, named] = await Promise.all([
			membersOf(c.var.db, { folders: ids, accountId: access.accountId }),
			titles(c, ids),
		]);
		return held.map(({ id, role }) => {
			const of = people.get(id);
			return {
				id,
				title: named.get(id) ?? null,
				role,
				members: of?.members ?? [],
				invited: roleAllows(role, 'manage') ? (of?.invited ?? []) : [],
				apps: of?.apps ?? [],
				remote: folderRemoteUrl(c.var.audiences.git, id),
			};
		});
	}

	/** Decide a request on the account, then run `answer` with what it may reach. */
	const onAccount = (
		scope: 'folders:read' | 'folders:write',
		answer: (c: Context<CloudEnv>, access: AccountAccess) => Promise<Response>,
	) =>
		createMiddleware<CloudEnv>(async (c) => {
			try {
				const decided = await authorizeAccountRequest(c.var.db, {
					token: readAccessToken(c.req.header('authorization')),
					audience: c.var.audiences.git,
					scope,
				});
				if (decided.error !== null)
					return refuse(
						c,
						decided.error.status,
						decided.error.body.error,
						decided.error.body.error_description,
						decided.error.challenge,
					);
				return await answer(c, decided.data);
			} catch (cause) {
				log.error(FolderApiError.Failed({ cause }).error);
				return refuse(
					c,
					503,
					'unavailable',
					'The request could not be answered. Try again.',
				);
			}
		});

	/** Decide a request on the folder in the path, then run `answer`. */
	const onFolder = (
		scope: 'folders:read' | 'folders:write',
		answer: (c: Context<CloudEnv>, access: FolderAccess) => Promise<Response>,
	) =>
		createMiddleware<CloudEnv>(async (c) => {
			const folder = c.req.param('folder') ?? '';
			if (!isFolderId(folder))
				return refuse(c, 404, 'not_found', 'That is not a folder id.');
			try {
				const decided = await authorizeFolderRequest(c.var.db, {
					token: readAccessToken(c.req.header('authorization')),
					audience: c.var.audiences.git,
					scope,
					folder,
				});
				if (decided.error !== null)
					return refuse(
						c,
						decided.error.status,
						decided.error.body.error,
						decided.error.body.error_description,
						decided.error.challenge,
					);
				return await answer(c, decided.data);
			} catch (cause) {
				log.error(FolderApiError.Failed({ cause }).error);
				return refuse(
					c,
					503,
					'unavailable',
					'The request could not be answered. Try again.',
				);
			}
		});

	app.get(
		'/api/folders',
		setup,
		onAccount('folders:read', async (c, access) => {
			const [held, pending] = await Promise.all([
				heldFolders(c.var.db, access),
				pendingShares(c.var.db, access),
			]);
			const waiting = await titles(
				c,
				pending.map(({ folder }) => folder),
			);
			const body: FolderListing = {
				folders: await listed(c, access, held),
				pending: pending.map((share) => ({
					...share,
					title: waiting.get(share.folder) ?? null,
				})),
			};
			return c.json(body, 200, noStore);
		}),
	);

	app.get(
		'/api/folders/:folder',
		setup,
		onFolder('folders:read', async (c, access) => {
			const [one] = await listed(c, access, [
				{ id: access.folder, role: access.role },
			]);
			return c.json(one, 200, noStore);
		}),
	);

	app.post(
		'/api/folders/:folder/accept',
		setup,
		onAccount('folders:write', async (c, access) => {
			const folder = c.req.param('folder') ?? '';
			const waiting = isFolderId(folder)
				? (await pendingShares(c.var.db, access)).find(
						(share) => share.folder === folder,
					)
				: undefined;
			if (
				waiting === undefined ||
				!(await acceptShare(c.var.db, {
					folder,
					accountId: access.accountId,
				}))
			)
				return refuse(
					c,
					404,
					'not_found',
					'No share of that folder waits for you.',
				);
			const [one] = await listed(c, access, [
				{ id: folder, role: waiting.role },
			]);
			return c.json(one, 200, noStore);
		}),
	);

	app.put(
		'/api/folders/:folder/members/:person',
		setup,
		onFolder('folders:write', async (c, access) => {
			if (!roleAllows(access.role, 'manage'))
				return refuse(
					c,
					403,
					'forbidden',
					"Only the folder's owners may share it.",
				);
			const person = c.req.param('person') ?? '';
			const body = (await c.req.json().catch(() => null)) as {
				role?: unknown;
			} | null;
			const role = body?.role;
			if (
				!isPersonEmail(person) ||
				typeof role !== 'string' ||
				!FOLDER_ROLES.includes(role as FolderRole)
			)
				return refuse(
					c,
					400,
					'invalid_request',
					`Name a person by their email, and send { "role": ${FOLDER_ROLES.map((r) => `"${r}"`).join(' | ')} }.`,
				);
			const shared = await shareFolder(c.var.db, {
				folder: access.folder,
				by: access.accountId,
				email: person,
				role: role as FolderRole,
			});
			if (shared.error !== null)
				return refuse(
					c,
					shared.error.name === 'UnknownPerson' ? 404 : 409,
					shared.error.name === 'UnknownPerson' ? 'not_found' : 'conflict',
					shared.error.message,
				);
			return c.json(
				{ person, role, pending: shared.data.pending },
				200,
				noStore,
			);
		}),
	);

	app.delete(
		'/api/folders/:folder/members/:person',
		setup,
		onAccount('folders:write', async (c, access) => {
			const folder = c.req.param('folder') ?? '';
			const person = c.req.param('person') ?? '';
			if (!isFolderId(folder) || !isPersonEmail(person))
				return refuse(
					c,
					400,
					'invalid_request',
					'Name a folder by its id and a person by their email.',
				);
			// Anyone takes themselves out of a folder, or declines a share;
			// taking someone else out is an owner's, of a folder the token reaches.
			const held = (await heldFolders(c.var.db, access)).find(
				({ id }) => id === folder,
			);
			const removed = await removeMember(c.var.db, {
				folder,
				accountId: access.accountId,
				byOwner: held !== undefined && roleAllows(held.role, 'manage'),
				email: person,
			});
			if (removed.error !== null)
				return refuse(
					c,
					removed.error.name === 'NotYours' ? 403 : 404,
					removed.error.name === 'NotYours' ? 'forbidden' : 'not_found',
					removed.error.message,
				);
			if (removed.data.folderGone) {
				const host = resolveHost(c.env);
				await host?.delete(folder).catch((cause) => {
					log.error(FolderApiError.StorageLeft({ folder, cause }).error);
				});
			}
			return c.json(
				{ person, removed: true, folderGone: removed.data.folderGone },
				200,
				noStore,
			);
		}),
	);

	const attach = (attached: boolean) =>
		onFolder('folders:write', async (c, access) => {
			if (access.app !== null)
				return refuse(
					c,
					403,
					'forbidden',
					'Only Epicenter attaches a folder to an app, as the person chooses.',
				);
			if (!roleAllows(access.role, 'push'))
				return refuse(
					c,
					403,
					'forbidden',
					'Your role in this folder may not change it.',
				);
			const app = c.req.param('app') ?? '';
			if (app === '' || app.length > 255)
				return refuse(c, 400, 'invalid_request', 'Name the app by its id.');
			const changed = await setAttached(c.var.db, {
				folder: access.folder,
				app,
				attached,
			});
			return c.json({ app, attached, changed }, 200, noStore);
		});
	app.put('/api/folders/:folder/apps/:app', setup, attach(true));
	app.delete('/api/folders/:folder/apps/:app', setup, attach(false));
}
