/**
 * Hosted repositories as rows (ADR-0546, ADR-0547): creating one on its first
 * push, listing a caller's, and its grants to people outside the namespace.
 * A repository is never renamed or moved (ADR-0771): its `<namespace>/<name>`
 * is fixed for its life, and a different name is a copy.
 *
 * Storage is not touched here. It names a repository by its immutable id.
 */
import {
	type GrantLevel,
	isNamespaceId,
	type ListedNamespace,
	type RepositoryGrant,
	repositoryUrl,
} from '@epicenter/definition/site';
import { sql } from 'drizzle-orm';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Db } from './db/create-db.js';
import type { NamespaceRole } from './namespace-roles.js';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A new repository id: sixteen characters of lowercase a-z and 0-9. */
export function newRepositoryId(): string {
	// 252 is the largest multiple of 36 below 256, so every character is uniform.
	let id = '';
	while (id.length < 16)
		for (const byte of crypto.getRandomValues(new Uint8Array(16)))
			if (byte < 252 && id.length < 16) id += ID_ALPHABET[byte % 36];
	return id;
}

/**
 * The repository `<namespaceId>/<name>` names, inserted as `id` when there is
 * none; `id`'s storage must already exist. Two first pushes at once both get
 * the one row the first inserted, so the second's `id` is left unnamed.
 */
export async function createRepository(
	db: Db,
	{ id, namespaceId, name }: { id: string; namespaceId: string; name: string },
): Promise<{ id: string; name: string }> {
	return db.transaction(async (tx) => {
		const inserted = await tx.execute<{ id: string }>(sql`
			insert into repository (id, namespace_id, name)
			values (${id}, ${namespaceId}, ${name})
			on conflict (namespace_id, name) do nothing
			returning id
		`);
		if (inserted.rows[0] !== undefined) return { id, name };
		const existing = await tx.execute<{ id: string }>(sql`
			select id from repository
			where namespace_id = ${namespaceId} and name = ${name}
		`);
		const found = existing.rows[0]?.id;
		if (found === undefined)
			throw new Error(
				`repository ${namespaceId}/${name} was neither inserted nor found`,
			);
		return { id: found, name };
	});
}

/** The namespace and name of the repository whose id is `id`, or null when none has it. */
export async function locateRepository(
	db: Db,
	id: string,
): Promise<{ namespaceId: string; name: string } | null> {
	const { rows } = await db.execute<{ namespace_id: string; name: string }>(sql`
		select namespace_id, name from repository where id = ${id}
	`);
	const row = rows[0];
	return row === undefined
		? null
		: { namespaceId: row.namespace_id, name: row.name };
}

/**
 * The namespaces `accountId` belongs to within `target` (`*`, or `ns:<id>`
 * for a grant to one namespace; null reaches none), each with its repositories: the personal
 * namespace first, then groups by title.
 */
export async function listRepositories(
	db: Db,
	{
		accountId,
		target,
		gitAudience,
	}: { accountId: string; target: string | null; gitAudience: string },
): Promise<ListedNamespace[]> {
	if (target === null || (target !== '*' && !target.startsWith('ns:')))
		return [];
	const only = target === '*' ? null : target.slice('ns:'.length);
	const { rows } = await db.execute<{
		namespace_id: string;
		title: string;
		personal: boolean;
		role: NamespaceRole;
		repository_id: string | null;
		repository_name: string | null;
	}>(sql`
		select n.id as namespace_id,
		       n.title,
		       n.personal_account_id is not null as personal,
		       m.role,
		       r.id as repository_id,
		       r.name as repository_name
		from namespace_member m
		join namespace n on n.id = m.namespace_id
		left join repository r on r.namespace_id = n.id
		where m.account_id = ${accountId}
		  and (${only}::text is null or n.id = ${only})
		order by (n.personal_account_id is null), n.title, n.id, r.name
	`);
	const namespaces = new Map<string, ListedNamespace>();
	for (const row of rows) {
		let listed = namespaces.get(row.namespace_id);
		if (listed === undefined) {
			listed = {
				id: row.namespace_id,
				title: row.title,
				personal: row.personal,
				role: row.role,
				repositories: [],
			};
			namespaces.set(row.namespace_id, listed);
		}
		if (row.repository_id !== null && row.repository_name !== null)
			listed.repositories.push({
				id: row.repository_id,
				name: row.repository_name,
				url: repositoryUrl(gitAudience, {
					namespace: row.namespace_id,
					name: row.repository_name,
				}),
			});
	}
	return [...namespaces.values()];
}

async function roleIn(
	tx: Pick<Db, 'execute'>,
	accountId: string,
	namespaceId: string,
): Promise<NamespaceRole | undefined> {
	const { rows } = await tx.execute<{ role: NamespaceRole }>(sql`
		select role from namespace_member
		where account_id = ${accountId} and namespace_id = ${namespaceId}
	`);
	return rows[0]?.role;
}

/** Why a grant could not be made or revoked. */
export const GrantError = defineErrors({
	UnknownPerson: ({ person }: { person: string }) => ({
		message: `No person has the handle ${person}.`,
		person,
	}),
	Member: ({ person }: { person: string }) => ({
		message: `${person} is a member of the repository's namespace already; a grant is for someone outside it.`,
		person,
	}),
});
export type GrantError = InferErrors<typeof GrantError>;

/** The account whose handle (personal namespace id) is `person`. */
async function personOf(
	tx: Pick<Db, 'execute'>,
	person: string,
): Promise<string | undefined> {
	if (!isNamespaceId(person)) return undefined;
	const { rows } = await tx.execute<{ account_id: string }>(sql`
		select personal_account_id as account_id from namespace
		where id = ${person} and personal_account_id is not null
	`);
	return rows[0]?.account_id;
}

/**
 * Let `person` (a handle) `level` the repository `repositoryId` in
 * `namespaceId`, replacing any grant they had. The caller has decided the
 * account may `manage` it. A member of the namespace already has a role
 * there, so granting them is refused rather than silently ignored.
 */
export async function grantRepository(
	db: Db,
	{
		repositoryId,
		namespaceId,
		person,
		level,
	}: {
		repositoryId: string;
		namespaceId: string;
		person: string;
		level: GrantLevel;
	},
): Promise<Result<RepositoryGrant, GrantError>> {
	return db.transaction(async (tx) => {
		const accountId = await personOf(tx, person);
		if (accountId === undefined) return GrantError.UnknownPerson({ person });
		if ((await roleIn(tx, accountId, namespaceId)) !== undefined)
			return GrantError.Member({ person });
		await tx.execute(sql`
			insert into repository_grant (repository_id, account_id, level)
			values (${repositoryId}, ${accountId}, ${level})
			on conflict (repository_id, account_id)
			do update set level = excluded.level
		`);
		return Ok({ person, level });
	});
}

/** Revoke `person`'s grant on `repositoryId`; `false` when they had none. */
export async function revokeRepositoryGrant(
	db: Db,
	{ repositoryId, person }: { repositoryId: string; person: string },
): Promise<Result<boolean, GrantError>> {
	const accountId = await personOf(db, person);
	if (accountId === undefined) return GrantError.UnknownPerson({ person });
	const { rows } = await db.execute<{ account_id: string }>(sql`
		delete from repository_grant
		where repository_id = ${repositoryId} and account_id = ${accountId}
		returning account_id
	`);
	return Ok(rows.length > 0);
}

/** Every grant on `repositoryId`, by handle, in the order granted. */
export async function listRepositoryGrants(
	db: Db,
	repositoryId: string,
): Promise<RepositoryGrant[]> {
	const { rows } = await db.execute<RepositoryGrant>(sql`
		select n.id as person, g.level
		from repository_grant g
		join namespace n on n.personal_account_id = g.account_id
		where g.repository_id = ${repositoryId}
		order by g.created_at, n.id
	`);
	return rows.map(({ person, level }) => ({ person, level }));
}
