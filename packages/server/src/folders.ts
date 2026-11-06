/**
 * Folders as rows (ADR-0811, ADR-0820): making one at its first sync, joining
 * one the person holds before making another, listing a person's folders and
 * the invitations waiting for them, sharing by email, accepting, leaving, and
 * attaching a folder to an app.
 *
 * A share is an invitation to an email (`folder_invitation`), never to an
 * account: sharing answers the same whether or not anyone signs in with that
 * email, and a member sees an invitation by its email alone. The person whose
 * account has that email, verified, sees it among the shares waiting for them
 * and may accept it, whether they had an account when it was made or signed
 * up later; nothing is copied at sign-up, since the invitation is matched to
 * the account's verified email whenever it is read. Accepting makes them a
 * member (`folder_member`), and every member has accepted.
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
	FolderInvitee,
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
 * as a member, and attached to `app` when an app made it.
 */
export async function createFolder(
	db: Db,
	{ id, accountId, app }: { id: string; accountId: string; app: string | null },
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.execute(sql`insert into folder (id) values (${id})`);
		await tx.execute(sql`
			insert into folder_member (folder_id, account_id, role)
			values (${id}, ${accountId}, 'member')
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
		  and (${app}::text is null or exists (
		    select 1 from folder_app a where a.folder_id = m.folder_id and a.app = ${app}
		  ))
		order by m.accepted_at, m.folder_id
	`);
	return rows;
}

/** Each folder's members, the emails invited to it, and its apps, by folder. */
export async function membersOf(
	db: Runner,
	{ folders, accountId }: { folders: readonly string[]; accountId: string },
): Promise<
	Map<
		string,
		{
			members: (FolderPerson & { role: FolderRole; you: boolean })[];
			invited: FolderInvitee[];
			apps: string[];
		}
	>
> {
	const out = new Map<
		string,
		{
			members: (FolderPerson & { role: FolderRole; you: boolean })[];
			invited: FolderInvitee[];
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
		you: boolean;
	}>(sql`
		select m.folder_id, u.email, u.name, m.role,
		       m.account_id = ${accountId} as you
		from folder_member m
		join "user" u on u.id = m.account_id
		where m.folder_id in (${ids})
		order by m.accepted_at, m.created_at, u.email
	`);
	for (const row of members.rows)
		out.get(row.folder_id)?.members.push({
			email: row.email,
			name: row.name,
			role: row.role,
			you: row.you,
		});
	// An invitation is its email: whether anyone signs in with it is not said.
	const invited = await db.execute<{
		folder_id: string;
		email: string;
		role: FolderRole;
	}>(sql`
		select folder_id, email, role from folder_invitation
		where folder_id in (${ids})
		order by created_at, email
	`);
	for (const row of invited.rows)
		out.get(row.folder_id)?.invited.push({ email: row.email, role: row.role });
	const apps = await db.execute<{ folder_id: string; app: string }>(sql`
		select folder_id, app from folder_app
		where folder_id in (${ids})
		order by created_at, app
	`);
	for (const row of apps.rows) out.get(row.folder_id)?.apps.push(row.app);
	return out;
}

/**
 * The invitations waiting for `accountId` that `app` reaches (null: every
 * one): those to its email, once that email is verified, of folders it does
 * not hold. An invitation of a folder attached to the app shows in it.
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
		select i.folder_id as folder, i.role,
		       s.email as from_email, s.name as from_name
		from "user" u
		join folder_invitation i on i.email = lower(u.email)
		left join "user" s on s.id = i.shared_by
		where u.id = ${accountId}
		  and u.email_verified
		  and not exists (
		    select 1 from folder_member m
		    where m.folder_id = i.folder_id and m.account_id = u.id
		  )
		  and (${app}::text is null or exists (
		    select 1 from folder_app a where a.folder_id = i.folder_id and a.app = ${app}
		  ))
		order by i.created_at, i.folder_id
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
	NotMember: ({ person }: { person: string }) => ({
		message: `${person} does not hold that folder and is not invited to it.`,
		person,
	}),
	NotYours: () => ({
		message:
			'A reader may not share the folder, or change or remove anyone else.',
	}),
});
export type ShareError = InferErrors<typeof ShareError>;

/**
 * Share `folder` with `email`, as `role`, from `by`, a member who may
 * manage it. Someone holding it who signs in with that email has their role
 * changed; otherwise the email is invited, or its invitation given the new
 * role. Answers whether the share waits, which is the same whether or not
 * anyone signs in with `email`.
 */
export async function shareFolder(
	db: Db,
	{
		folder,
		by,
		email,
		role,
	}: { folder: string; by: string; email: string; role: FolderRole },
): Promise<{ pending: boolean }> {
	const changed = await db.execute(sql`
		update folder_member m set role = ${role}
		from "user" u
		where m.folder_id = ${folder} and u.id = m.account_id
		  and lower(u.email) = lower(${email})
		returning 1
	`);
	if (changed.rows.length > 0) return { pending: false };
	await db.execute(sql`
		insert into folder_invitation (folder_id, email, role, shared_by)
		values (${folder}, lower(${email}), ${role}, ${by})
		on conflict (folder_id, email)
		do update set role = excluded.role, shared_by = excluded.shared_by
	`);
	return { pending: true };
}

/**
 * Take `email` out of `folder`: the member who signs in with it, or its
 * invitation. `manages` says whether the caller (`accountId`) holds the
 * folder as a `member`; anyone else (a reader, or someone invited) may only
 * take out themselves, leaving or declining an invitation to their verified
 * email. Answers whether the folder is gone with them: the last member took
 * it along.
 */
export async function removeMember(
	db: Db,
	{
		folder,
		accountId,
		manages,
		email,
	}: { folder: string; accountId: string; manages: boolean; email: string },
): Promise<Result<{ folderGone: boolean }, ShareError>> {
	const { rows: callers } = await db.execute<{ self: boolean; verified: boolean }>(
		sql`
			select lower(email) = lower(${email}) as self, email_verified as verified
			from "user" where id = ${accountId}
		`,
	);
	const caller = callers[0];
	const self = caller?.self === true;
	if (!self && !manages) return ShareError.NotYours();
	const member = await db.execute(sql`
		delete from folder_member m
		using "user" u
		where m.folder_id = ${folder} and u.id = m.account_id
		  and lower(u.email) = lower(${email})
		returning 1
	`);
	if (member.rows.length > 0)
		return Ok({ folderGone: !(await folderExists(db, folder)) });
	// Declining reaches only an invitation to the caller's verified email.
	if (manages || caller?.verified === true) {
		const invitation = await db.execute(sql`
			delete from folder_invitation
			where folder_id = ${folder} and email = lower(${email})
			returning 1
		`);
		if (invitation.rows.length > 0) return Ok({ folderGone: false });
	}
	return ShareError.NotMember({ person: email });
}

/**
 * Accept the invitation of `folder` to the verified email of `accountId`:
 * they become a member with its role, and it is gone. Null when none waits.
 */
export async function acceptShare(
	db: Db,
	{ folder, accountId }: { folder: string; accountId: string },
): Promise<{ role: FolderRole } | null> {
	return db.transaction(async (tx) => {
		const { rows } = await tx.execute<{
			email: string;
			role: FolderRole;
			shared_by: string | null;
		}>(sql`
			select i.email, i.role, i.shared_by
			from "user" u
			join folder_invitation i on i.email = lower(u.email)
			where u.id = ${accountId} and u.email_verified
			  and i.folder_id = ${folder}
			for update of i
		`);
		const invitation = rows[0];
		if (invitation === undefined) return null;
		await tx.execute(sql`
			delete from folder_invitation
			where folder_id = ${folder} and email = ${invitation.email}
		`);
		const joined = await tx.execute(sql`
			insert into folder_member (folder_id, account_id, role, shared_by)
			values (${folder}, ${accountId}, ${invitation.role}, ${invitation.shared_by})
			on conflict do nothing
			returning 1
		`);
		return joined.rows.length > 0 ? { role: invitation.role } : null;
	});
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
