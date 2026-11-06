/**
 * A person's folders on the server (ADR-0811), over the account's fetch: the
 * folders they hold and the shares waiting for them, sharing by email,
 * accepting, leaving, attaching a folder to an app, and where `main` is in
 * every folder at once (ADR-0819). Every surface composes these: the CLI,
 * the Epicenter app, and an app's home (ADR-0817).
 *
 * A request the server refuses is `Unavailable` with a `RemoteError.Refused`
 * cause naming its status, code, and message.
 */
import { ClientError } from '@epicenter/definition/contract';
import {
	type FolderListing,
	type FolderRole,
	foldersApiUrl,
	folderUrl,
	type ListedFolder,
	resolveOAuthAudiences,
} from '@epicenter/definition/site';
import { Ok, type Result } from 'wellcrafted/result';
import type { Unavailable } from '../device/store.js';
import { type RemoteAccount, RemoteError } from './repository.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** One JSON request: its body when the status is one of `ok`, else `Unavailable`. */
async function request<T>(
	account: RemoteAccount,
	url: string,
	{ method = 'GET', body }: { method?: string; body?: unknown } = {},
): Promise<Result<T, Unavailable>> {
	let response: Response;
	try {
		response = await account.fetch(url, {
			method,
			headers:
				body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch (cause) {
		return ClientError.Unavailable({ cause });
	}
	const answer: unknown = await response.json().catch(() => null);
	if (response.ok) return Ok(answer as T);
	const fields = isRecord(answer) ? answer : {};
	return ClientError.Unavailable({
		cause: RemoteError.Refused({
			status: response.status,
			code: typeof fields.error === 'string' ? fields.error : null,
			message:
				typeof fields.error_description === 'string'
					? fields.error_description
					: typeof fields.message === 'string'
						? fields.message
						: `status ${response.status}`,
		}).error,
	});
}

/** The folders the person holds that the account reaches, and the shares waiting for them. */
export function listFolders(account: RemoteAccount) {
	return request<FolderListing>(account, foldersApiUrl(account.baseURL));
}

/** One folder the person holds: its title, members, and apps. */
export function getFolder(account: RemoteAccount, folder: string) {
	return request<ListedFolder>(account, foldersApiUrl(account.baseURL, folder));
}

/**
 * Where `main` is in every folder the account reaches, by id (null before a
 * folder's first commit): one request instead of one per folder.
 */
export async function folderHeads(
	account: RemoteAccount,
): Promise<Result<Record<string, string | null>, Unavailable>> {
	const answered = await request<{ heads: Record<string, string | null> }>(
		account,
		folderUrl(resolveOAuthAudiences(account.baseURL).git),
	);
	if (answered.error !== null) return answered;
	return Ok(answered.data.heads);
}

/**
 * Share `folder` with the person who signs in as `email`, as `role` (the
 * person's own role must be `owner`), or change the role of someone who
 * holds it. A new share waits for them to accept it.
 */
export function shareFolder(
	account: RemoteAccount,
	{
		folder,
		email,
		role = 'writer',
	}: { folder: string; email: string; role?: FolderRole },
) {
	return request<{ person: string; role: FolderRole; pending: boolean }>(
		account,
		foldersApiUrl(account.baseURL, folder, 'members', email),
		{ method: 'PUT', body: { role } },
	);
}

/**
 * Take the person who signs in as `email` out of `folder`: an owner's
 * unshare, or, for the person's own email, leaving or declining a share.
 * `folderGone` when the last member left, and the folder with them.
 */
export function unshareFolder(
	account: RemoteAccount,
	{ folder, email }: { folder: string; email: string },
) {
	return request<{ person: string; removed: true; folderGone: boolean }>(
		account,
		foldersApiUrl(account.baseURL, folder, 'members', email),
		{ method: 'DELETE' },
	);
}

/** Accept the share of `folder` waiting for the person: it is theirs, as listed. */
export function acceptShare(
	account: RemoteAccount,
	{ folder }: { folder: string },
) {
	return request<ListedFolder>(
		account,
		foldersApiUrl(account.baseURL, folder, 'accept'),
		{ method: 'POST' },
	);
}

/**
 * Attach `folder` to `app` (the client id it signs in as), so the app
 * reaches it, or detach it: "Use this folder with" (ADR-0811). Only an
 * account with `folders:all` may.
 */
export function attachFolder(
	account: RemoteAccount,
	{ folder, app, attached }: { folder: string; app: string; attached: boolean },
) {
	return request<{ app: string; attached: boolean; changed: boolean }>(
		account,
		foldersApiUrl(account.baseURL, folder, 'apps', app),
		{ method: attached ? 'PUT' : 'DELETE' },
	);
}
