/**
 * A folder on the server (ADR-0811), as the server that keeps it, the
 * `epicenter` CLI, and the apps that sync and share it name it.
 *
 * A folder is its id: sixteen characters of lowercase a-z and 0-9, minted
 * by the server at its first sync and kept in its manifest. Its title is in
 * its `epicenter.json`, which the server reads from its files; the server
 * keeps no name. Its members are people, each named by the email they sign
 * in with, any of whom may own it.
 *
 * Its addresses under a deployment:
 *
 * ```txt
 * <git>/folders                       POST: join the folder named, or make one (join before create)
 * <git>/folders/<id>/…                sync's routes, in Git's vocabulary
 * <git>/folders/<id>.git              its history as a Git remote, for plain Git
 * <api>/api/folders                   the person's folders, and the shares waiting for them
 * <api>/api/folders/<id>              one folder
 * <api>/api/folders/<id>/accept       POST: accept a share
 * <api>/api/folders/<id>/members/<email>   PUT { role } shares or changes a role; DELETE unshares or leaves
 * <api>/api/folders/<id>/apps/<app>   PUT attaches the folder to an app; DELETE detaches it
 * ```
 */

/** A folder's id: sixteen characters of lowercase a-z and 0-9. */
const FOLDER_ID = /^[a-z0-9]{16}$/;

/**
 * Whether `value` is a folder's id: minted by the server at the folder's
 * first sync (ADR-0811), which its manifest stores.
 */
export function isFolderId(value: string): boolean {
	return FOLDER_ID.test(value);
}

/**
 * Whether `value` can name a person: an email address, which a URL path
 * segment carries once encoded. The server decides whether anyone has it.
 */
export function isPersonEmail(value: string): boolean {
	return /^[^\s@/]+@[^\s@/]+$/.test(value) && value.length <= 320;
}

const trimmed = (origin: string) => origin.replace(/\/+$/, '');

/**
 * The address of the folder `folder` under a deployment's Git audience,
 * `<git audience>/folders/<folder>`, where sync reaches its repository: the
 * one place a folder id becomes an address. `folderUrl(audience)` alone is
 * where a folder is joined or made.
 */
export function folderUrl(gitAudience: string, folder?: string): string {
	const folders = `${trimmed(gitAudience)}/folders`;
	return folder === undefined ? folders : `${folders}/${folder}`;
}

/** The folder's history as a Git remote, `<git audience>/folders/<folder>.git`, for `git clone`. */
export function folderRemoteUrl(gitAudience: string, folder: string): string {
	return `${folderUrl(gitAudience, folder)}.git`;
}

/**
 * The folder routes on a deployment's API origin: `<api>/api/folders`, the
 * folder `folder` below it, and `rest` (such as `members`, an email) below
 * that, each segment encoded.
 */
export function foldersApiUrl(
	apiOrigin: string,
	folder?: string,
	...rest: string[]
): string {
	return [
		`${trimmed(apiOrigin)}/api/folders`,
		...(folder === undefined ? [] : [folder, ...rest]).map(encodeURIComponent),
	].join('/');
}

/**
 * What a member may do to a folder: `reader` reads it; `writer` also syncs
 * changes to it; `owner` also rewrites its history with Git and manages who
 * holds it. Any member may be an owner.
 */
export type FolderRole = 'owner' | 'writer' | 'reader';

export const FOLDER_ROLES: readonly FolderRole[] = [
	'owner',
	'writer',
	'reader',
];

/** A person, as a folder's members and shares name them. */
export type FolderPerson = { email: string; name: string };

/** One member of a folder: a person who accepted it, and their role. */
export type FolderMember = FolderPerson & {
	role: FolderRole;
	/** Whether this member is the person asking. */
	you: boolean;
};

/** One folder the person holds, in `GET /api/folders` and `GET /api/folders/<id>`. */
export type ListedFolder = {
	id: string;
	/** The `title` of its `epicenter.json` at `main`; null when it has none. */
	title: string | null;
	/** The person's own role. */
	role: FolderRole;
	/** Who holds it, in the order they joined. */
	members: FolderMember[];
	/** The people it is shared with who have not accepted yet: shown to its owners only. */
	invited: (FolderPerson & { role: FolderRole })[];
	/** The apps it is attached to, by the client id each signs in as. */
	apps: string[];
	/** Its history as a Git remote (`folderRemoteUrl`). */
	remote: string;
};

/** A share waiting for the person to accept it: invisible among their folders until they do. */
export type PendingShare = {
	folder: string;
	title: string | null;
	/** The role accepting gives. */
	role: FolderRole;
	/** Who shared it, while they hold an account. */
	from: FolderPerson | null;
};

/** The body of `GET /api/folders`: the folders the person holds, and the shares waiting for them. */
export type FolderListing = {
	folders: ListedFolder[];
	pending: PendingShare[];
};

/**
 * The body of `POST <git>/folders`: the folder a first sync joined (the one
 * it named, which the person holds, or the one folder attached to the app),
 * or the one it made.
 */
export type JoinedFolder = { folder: string; made: boolean };
