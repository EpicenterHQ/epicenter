/**
 * Folders as rows (ADR-0811): making one at its first sync, joining one the
 * person holds before making another, listing a person's folders and the
 * shares waiting for them, sharing with a person by their email, accepting,
 * leaving, and attaching a folder to an app.
 *
 * Storage is not touched here; it names a folder's repository by the
 * folder's id. A folder's title is in its files, which the routes read.
 *
 * `app` is the OAuth client id a request's token was issued to, and null
 * for a token with `folders:all` (the CLI, the Epicenter app), which
 * reaches every folder its person holds. A token from an app reaches only
 * the folders attached to that app.
 */
import type {
	FolderPerson,
	FolderRole,
	PendingShare,
} from '@epicenter/definition/site';
import { sql } from 'drizzle-orm';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Db } from './db/create-db.js';

type Runner = Pick<Db, 'execute'>;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A new folder id: sixteen characters of lowercase a-z and 0-9. */
export function newFolderId(): string {
	// 252 is the largest multiple of 36 below 256, so every character is uniform.
	let id = '';
	while (id.length < 16)
		for (const byte of crypto.getRandomValues(new Uint8Array(16)))
			if (byte < 252 && id.length < 16) id += ID_ALPHABET[byte % 36];
	return id;
}

/**
 * Record the folder `id`, whose storage already exists, held by `accountId`
 * as its owner, and attached to `app` when an app made it.
 */
export async function createFolder(
	db: Db,
	{ id, accountId, app }: { id: string; accountId: string; app: string | null },
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.execute(sql`insert into folder (id) values (${id})`);
		await tx.execute(sql`
			insert into folder_member (folder_id, account_id, role, accepted_at)
			values (${id}, ${accountId}, 'owner', now())
		`);
		if (app !== null)
			await tx.execute(sql`
				insert into folder_app (folder_id, app) values (${id}, ${app})
			`);
	});
}

/** Whether the folder `folder` exists. */
export async function folderExists(db: Runner, folder: string) {
	const { rows } = await db.execute(
		sql`select 1 from folder where id = ${folder}`,
	);
	return rows.length > 0;
}

/**
 * The folders `accountId` holds that `app` reaches (null: every one), with
 * the person's role, oldest first.
 */
export async function heldFolders(
	db: Runner,
	{ accountId, app }: { accountId: string; app: string | null },
): Promise<{ id: string; role: FolderRole }[]> {
	const { rows } = await db.execute<{ id: string; role: FolderRole }>(sql`
		select m.folder_id as id, m.role
		from folder_member m
		where m.account_id = ${accountId}
		  and m.accepted_at is not null
		  and (${app}::text is null or exists (
		    select 1 from folder_app a where a.folder_id = m.folder_id and a.app = ${app}
		  ))
		order by m.accepted_at, m.folder_id
	`);
	return rows;
}

/** Each folder's members who accepted it, and the people invited to it, by folder. */
export async function membersOf(
	db: Runner,
	{ folders, accountId }: { folders: readonly string[]; accountId: string },
): Promise<
	Map<
		string,
		{
			members: (FolderPerson & { role: FolderRole; you: boolean })[];
			invited: (FolderPerson & { role: FolderRole })[];
			apps: string[];
		}
	>
> {
	const out = new Map<
		string,
		{
			members: (FolderPerson & { role: FolderRole; you: boolean })[];
			invited: (FolderPerson & { role: FolderRole })[];
			apps: string[];
		}
	>();
	if (folders.length === 0) return out;
	for (const id of folders) out.set(id, { members: [], invited: [], apps: [] });
	const ids = sql.join(
		folders.map((id) => sql`${id}`),
		sql`, `,
	);
	const members = await db.execute<{
		folder_id: string;
		email: string;
		name: string;
		role: FolderRole;
		accepted: boolean;
		you: boolean;
	}>(sql`
		select m.folder_id, u.email, u.name, m.role,
		       m.accepted_at is not null as accepted,
		       m.account_id = ${accountId} as you
		from folder_member m
		join "user" u on u.id = m.account_id
		where m.folder_id in (${ids})
		order by m.accepted_at nulls last, m.created_at, u.email
	`);
	for (const row of members.rows) {
		const entry = out.get(row.folder_id);
		if (entry === undefined) continue;
		const person = { email: row.email, name: row.name, role: row.role };
		if (row.accepted) entry.members.push({ ...person, you: row.you });
		else entry.invited.push(person);
	}
	const apps = await db.execute<{ folder_id: string; app: string }>(sql`
		select folder_id, app from folder_app
		where folder_id in (${ids})
		order by created_at, app
	`);
	for (const row of apps.rows) out.get(row.folder_id)?.apps.push(row.app);
	return out;
}

/**
 * The shares waiting for `accountId` that `app` reaches (null: every one):
 * a share of a folder attached to the app shows in it.
 */
export async function pendingShares(
	db: Runner,
	{ accountId, app }: { accountId: string; app: string | null },
): Promise<Omit<PendingShare, 'title'>[]> {
	const { rows } = await db.execute<{
		folder: string;
		role: FolderRole;
		from_email: string | null;
		from_name: string | null;
	}>(sql`
		select m.folder_id as folder, m.role,
		       u.email as from_email, u.name as from_name
		from folder_member m
		left join "user" u on u.id = m.shared_by
		where m.account_id = ${accountId}
		  and m.accepted_at is null
		  and (${app}::text is null or exists (
		    select 1 from folder_app a where a.folder_id = m.folder_id and a.app = ${app}
		  ))
		order by m.created_at, m.folder_id
	`);
	return rows.map((row) => ({
		folder: row.folder,
		role: row.role,
		from:
			row.from_email === null
				? null
				: { email: row.from_email, name: row.from_name ?? '' },
	}));
}

/** Why sharing could not be done or undone. */
export const ShareError = defineErrors({
	UnknownPerson: ({ person }: { person: string }) => ({
		message: `No one signs in to Epicenter as ${person}.`,
		person,
	}),
	NotMember: ({ person }: { person: string }) => ({
		message: `${person} does not hold that folder and no share of it waits for them.`,
		person,
	}),
	LastOwner: () => ({
		message:
			'A folder keeps at least one owner while others hold it: make someone else an owner first.',
	}),
	NotYours: () => ({
		message:
			"Only the folder's owners may share it, or change or remove another member.",
	}),
});
export type ShareError = InferErrors<typeof ShareError>;

/** The account that signs in as `email`, compared without case. */
async function accountOf(db: Runner, email: string) {
	const { rows } = await db.execute<{ id: string }>(sql`
		select id from "user" where lower(email) = lower(${email})
	`);
	return rows[0]?.id;
}

/**
 * Share `folder` with the person who signs in as `email`, as `role`, from
 * `by`, who owns it. A person who holds it already has their role changed;
 * anyone else gets a share that waits for them to accept it. Answers whether
 * the share waits.
 */
export async function shareFolder(
	db: Db,
	{
		folder,
		by,
		email,
		role,
	}: { folder: string; by: string; email: string; role: FolderRole },
): Promise<Result<{ pending: boolean }, ShareError>> {
	return db.transaction(async (tx) => {
		const accountId = await accountOf(tx, email);
		if (accountId === undefined)
			return ShareError.UnknownPerson({ person: email });
		const { rows } = await tx.execute<{
			accepted: boolean;
			role: FolderRole;
		}>(sql`
			select accepted_at is not null as accepted, role from folder_member
			where folder_id = ${folder} and account_id = ${accountId}
			for update
		`);
		const held = rows[0];
		if (held === undefined) {
			await tx.execute(sql`
				insert into folder_member (folder_id, account_id, role, shared_by)
				values (${folder}, ${accountId}, ${role}, ${by})
			`);
			return Ok({ pending: true });
		}
		if (held.accepted && held.role === 'owner' && role !== 'owner') {
			const owners = await tx.execute(sql`
				select 1 from folder_member
				where folder_id = ${folder} and role = 'owner'
				  and accepted_at is not null and account_id <> ${accountId}
			`);
			if (owners.rows.length === 0) return ShareError.LastOwner();
		}
		await tx.execute(sql`
			update folder_member set role = ${role}
			where folder_id = ${folder} and account_id = ${accountId}
		`);
		return Ok({ pending: !held.accepted });
	});
}

/**
 * Take the person who signs in as `email` out of `folder`: a member, or a
 * share that waits for them. `byOwner` says whether the caller owns the
 * folder; anyone else may only take themselves out (`accountId`). Answers
 * whether the folder is gone with them: the last member took it along.
 */
export async function removeMember(
	db: Db,
	{
		folder,
		accountId,
		byOwner,
		email,
	}: { folder: string; accountId: string; byOwner: boolean; email: string },
): Promise<Result<{ folderGone: boolean }, ShareError>> {
	const target = await accountOf(db, email);
	if (target === undefined) return ShareError.UnknownPerson({ person: email });
	if (target !== accountId && !byOwner) return ShareError.NotYours();
	const { rows } = await db.execute(sql`
		delete from folder_member
		where folder_id = ${folder} and account_id = ${target}
		returning 1
	`);
	if (rows.length === 0) return ShareError.NotMember({ person: email });
	return Ok({ folderGone: !(await folderExists(db, folder)) });
}

/** Accept the share of `folder` waiting for `accountId`: false when none waits. */
export async function acceptShare(
	db: Runner,
	{ folder, accountId }: { folder: string; accountId: string },
): Promise<boolean> {
	const { rows } = await db.execute(sql`
		update folder_member set accepted_at = now()
		where folder_id = ${folder} and account_id = ${accountId}
		  and accepted_at is null
		returning 1
	`);
	return rows.length > 0;
}

/** Attach `folder` to `app`, or detach it; answers whether anything changed. */
export async function setAttached(
	db: Runner,
	{ folder, app, attached }: { folder: string; app: string; attached: boolean },
): Promise<boolean> {
	const { rows } = attached
		? await db.execute(sql`
				insert into folder_app (folder_id, app) values (${folder}, ${app})
				on conflict do nothing returning 1
			`)
		: await db.execute(sql`
				delete from folder_app where folder_id = ${folder} and app = ${app}
				returning 1
			`);
	return rows.length > 0;
}
