/**
 * Hosted repositories as rows (ADR-0546, ADR-0547): creating one on its first
 * push, listing a caller's, and the `manage` role's rename and move, each of
 * which leaves an alias so every existing clone's remote keeps working.
 *
 * Storage is not touched here. It names a repository by its immutable id, so
 * a rename or a move is one row update and an alias, and no copy.
 */
import {
	isNamespaceId,
	isRepositoryName,
	type ListedNamespace,
	repositoryUrl,
} from '@epicenter/constants/repositories';
import { sql } from 'drizzle-orm';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Db } from './db/create-db.js';
import {
	type NamespaceOperation,
	type NamespaceRole,
	roleAllows,
} from './namespace-roles.js';

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
 * The repository `<namespaceId>/<name>` names, created when there is none.
 * A name taken by an alias is freed for the new repository. Two first pushes
 * at once both get the one row the first inserted.
 */
export async function createRepository(
	db: Db,
	{ namespaceId, name }: { namespaceId: string; name: string },
): Promise<{ id: string; name: string; created: boolean }> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`
			delete from repository_alias
			where namespace_id = ${namespaceId} and name = ${name}
		`);
		const inserted = await tx.execute<{ id: string }>(sql`
			insert into repository (id, namespace_id, name)
			values (${newRepositoryId()}, ${namespaceId}, ${name})
			on conflict (namespace_id, name) do nothing
			returning id
		`);
		const created = inserted.rows[0]?.id;
		if (created !== undefined) return { id: created, name, created: true };
		const existing = await tx.execute<{ id: string }>(sql`
			select id from repository
			where namespace_id = ${namespaceId} and name = ${name}
		`);
		const id = existing.rows[0]?.id;
		if (id === undefined)
			throw new Error(
				`repository ${namespaceId}/${name} was neither inserted nor found`,
			);
		return { id, name, created: false };
	});
}

/** Remove a repository's row and its aliases, as when its storage could not be made. */
export async function forgetRepository(db: Db, id: string): Promise<void> {
	await db.execute(sql`delete from repository where id = ${id}`);
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

/** Why a rename or a move was refused. */
export const RepositoryChangeError = defineErrors({
	InvalidName: ({ name }: { name: string }) => ({
		message: `'${name}' is not a repository name: use lowercase a-z, 0-9, '.', '_', and '-', starting with a letter or digit`,
		repository: name,
	}),
	NotFound: ({ namespaceId, name }: { namespaceId: string; name: string }) => ({
		message: `No repository is named ${namespaceId}/${name}.`,
		namespaceId,
		repository: name,
	}),
	Forbidden: ({
		namespaceId,
		operation,
	}: {
		namespaceId: string;
		operation: NamespaceOperation;
	}) => ({
		message: `This account may not ${operation} in namespace ${namespaceId}.`,
		namespaceId,
		operation,
	}),
	NameTaken: ({
		namespaceId,
		name,
	}: {
		namespaceId: string;
		name: string;
	}) => ({
		message: `${namespaceId}/${name} is already a repository.`,
		namespaceId,
		repository: name,
	}),
});
export type RepositoryChangeError = InferErrors<typeof RepositoryChangeError>;

/** The repository a URL's `<namespace>/<name>` names now, by its name or an alias. */
async function resolve(
	tx: Pick<Db, 'execute'>,
	namespaceId: string,
	name: string,
) {
	const { rows } = await tx.execute<{
		id: string;
		namespace_id: string;
		name: string;
	}>(sql`
		select r.id, r.namespace_id, r.name, 0 as via_alias
		from repository r
		where r.namespace_id = ${namespaceId} and r.name = ${name}
		union all
		select r.id, r.namespace_id, r.name, 1 as via_alias
		from repository_alias a
		join repository r on r.id = a.repository_id
		where a.namespace_id = ${namespaceId} and a.name = ${name}
		order by via_alias
		limit 1
	`);
	const found = rows[0];
	if (found === undefined) return undefined;
	// Hold the row, so two changes to one repository happen one after the other.
	await tx.execute(
		sql`select id from repository where id = ${found.id} for update`,
	);
	return found;
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

/**
 * Move `<namespaceId>/<name>` to `<to.namespaceId>/<to.name>`, each
 * defaulting to where the repository is now: a rename when only the name
 * changes, a move when the namespace does. The account needs
 * `manage` where the repository is and `push` where it goes. The old
 * `<namespace>/<name>` stays as an alias, and an alias the new one had is
 * dropped, since the repository now takes that name.
 */
export async function changeRepository(
	db: Db,
	{
		accountId,
		namespaceId,
		name,
		to,
	}: {
		accountId: string;
		namespaceId: string;
		name: string;
		to: { namespaceId?: string; name?: string };
	},
): Promise<
	Result<
		{ id: string; namespaceId: string; name: string },
		RepositoryChangeError
	>
> {
	if (to.name !== undefined && !isRepositoryName(to.name))
		return RepositoryChangeError.InvalidName({ name: to.name });
	if (to.namespaceId !== undefined && !isNamespaceId(to.namespaceId))
		return RepositoryChangeError.Forbidden({
			namespaceId: to.namespaceId,
			operation: 'push',
		});
	return db.transaction(async (tx) => {
		const found = await resolve(tx, namespaceId, name);
		if (found === undefined)
			return RepositoryChangeError.NotFound({ namespaceId, name });
		const target = {
			namespaceId: to.namespaceId ?? found.namespace_id,
			name: to.name ?? found.name,
		};
		const role = await roleIn(tx, accountId, found.namespace_id);
		if (role === undefined || !roleAllows(role, 'manage'))
			return RepositoryChangeError.Forbidden({
				namespaceId: found.namespace_id,
				operation: 'manage',
			});
		if (target.namespaceId !== found.namespace_id) {
			const destination = await roleIn(tx, accountId, target.namespaceId);
			if (destination === undefined || !roleAllows(destination, 'push'))
				return RepositoryChangeError.Forbidden({
					namespaceId: target.namespaceId,
					operation: 'push',
				});
		}
		if (target.namespaceId === found.namespace_id && target.name === found.name)
			return Ok({
				id: found.id,
				namespaceId: target.namespaceId,
				name: target.name,
			});
		const taken = await tx.execute<{ id: string }>(sql`
			select id from repository
			where namespace_id = ${target.namespaceId} and name = ${target.name}
		`);
		if (taken.rows.length > 0)
			return RepositoryChangeError.NameTaken({
				namespaceId: target.namespaceId,
				name: target.name,
			});
		await tx.execute(sql`
			delete from repository_alias
			where namespace_id = ${target.namespaceId} and name = ${target.name}
		`);
		await tx.execute(sql`
			update repository
			set namespace_id = ${target.namespaceId}, name = ${target.name}
			where id = ${found.id}
		`);
		await tx.execute(sql`
			insert into repository_alias (namespace_id, name, repository_id)
			values (${found.namespace_id}, ${found.name}, ${found.id})
			on conflict (namespace_id, name)
			do update set repository_id = excluded.repository_id
		`);
		return Ok({
			id: found.id,
			namespaceId: target.namespaceId,
			name: target.name,
		});
	});
}

/** Rename a repository within its namespace, leaving an alias for the old name. */
export function renameRepository(
	db: Db,
	{
		accountId,
		namespaceId,
		name,
		newName,
	}: { accountId: string; namespaceId: string; name: string; newName: string },
) {
	return changeRepository(db, {
		accountId,
		namespaceId,
		name,
		to: { name: newName },
	});
}

/** Move a repository to another namespace under its name, leaving an alias for the old URL. */
export function moveRepository(
	db: Db,
	{
		accountId,
		namespaceId,
		name,
		toNamespaceId,
	}: {
		accountId: string;
		namespaceId: string;
		name: string;
		toNamespaceId: string;
	},
) {
	return changeRepository(db, {
		accountId,
		namespaceId,
		name,
		to: { namespaceId: toNamespaceId },
	});
}
