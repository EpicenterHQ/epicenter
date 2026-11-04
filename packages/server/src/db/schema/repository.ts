/**
 * Hosted repositories (ADR-0546). A repository belongs to one namespace
 * (ADR-0547) under a name unique within it, and has an immutable id, which is
 * what storage names it by and never appears in a URL. A repository is never
 * renamed or moved (ADR-0771), so its `<namespace>/<name>` is fixed for its
 * life.
 *
 * A `repository_grant` lets one person outside the namespace `read` or
 * `write` one repository. Deleting the repository or the person deletes it.
 */
import { relations, sql } from 'drizzle-orm';
import {
	check,
	index,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { namespace } from './namespace';

/** A stored name: lowercase a-z, 0-9, `.`, `_`, `-`, from a letter or digit, at most 100. */
const NAME_FORMAT = `'^[a-z0-9][a-z0-9._-]{0,99}$'`;

export const repository = pgTable(
	'repository',
	{
		/** Sixteen characters of lowercase a-z and 0-9; storage's name for it. */
		id: text('id').primaryKey(),
		namespaceId: text('namespace_id')
			.notNull()
			.references(() => namespace.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		unique('repository_namespace_id_name_unique').on(
			table.namespaceId,
			table.name,
		),
		check('repository_id_format', sql`${table.id} ~ '^[a-z0-9]{16}$'`),
		check(
			'repository_name_format',
			sql`${table.name} ~ ${sql.raw(NAME_FORMAT)} and ${table.name} !~ '\\.git$'`,
		),
	],
);

/** What a grant lets its person do to one repository. */
export const GRANT_LEVELS = ['read', 'write'] as const;
export type GrantLevel = (typeof GRANT_LEVELS)[number];

export const repositoryGrant = pgTable(
	'repository_grant',
	{
		repositoryId: text('repository_id')
			.notNull()
			.references(() => repository.id, { onDelete: 'cascade' }),
		accountId: text('account_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		level: text('level', { enum: GRANT_LEVELS }).notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.repositoryId, table.accountId] }),
		index('repository_grant_account_id_idx').on(table.accountId),
		check('repository_grant_level', sql`${table.level} in ('read', 'write')`),
	],
);

export const repositoryRelations = relations(repository, ({ one, many }) => ({
	namespace: one(namespace, {
		fields: [repository.namespaceId],
		references: [namespace.id],
	}),
	grants: many(repositoryGrant),
}));

export const repositoryGrantRelations = relations(
	repositoryGrant,
	({ one }) => ({
		repository: one(repository, {
			fields: [repositoryGrant.repositoryId],
			references: [repository.id],
		}),
		account: one(user, {
			fields: [repositoryGrant.accountId],
			references: [user.id],
		}),
	}),
);
