/**
 * Namespaces own hosted repositories (ADR-0547). A person is a namespace of
 * one: every account gets a personal namespace, with itself as the only
 * `owner`, in the same transaction that inserts the account. The
 * `user_personal_namespace` trigger in `apps/api/drizzle` does that inside the
 * inserting statement, so no code path can create an account without one.
 *
 * Whether a namespace is personal is the fact `personal_account_id`, never a
 * stored kind. People never see the word namespace: on screen a personal
 * namespace is "Personal" and any other is a group, by its title.
 */
import { relations, sql } from 'drizzle-orm';
import {
	check,
	index,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const namespace = pgTable(
	'namespace',
	{
		/** Twelve characters of lowercase a-z and 0-9; safe in a URL path segment. */
		id: text('id').primaryKey(),
		title: text('title').notNull(),
		/** The account this namespace is personal to; null for a group. */
		personalAccountId: text('personal_account_id')
			.unique()
			.references(() => user.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		check('namespace_id_format', sql`${table.id} ~ '^[a-z0-9]{12}$'`),
	],
);

export const namespaceMember = pgTable(
	'namespace_member',
	{
		namespaceId: text('namespace_id')
			.notNull()
			.references(() => namespace.id, { onDelete: 'cascade' }),
		accountId: text('account_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ['owner', 'member'] }).notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.namespaceId, table.accountId] }),
		index('namespace_member_account_id_idx').on(table.accountId),
		check('namespace_member_role', sql`${table.role} in ('owner', 'member')`),
	],
);

export const namespaceRelations = relations(namespace, ({ many }) => ({
	members: many(namespaceMember),
}));

export const namespaceMemberRelations = relations(
	namespaceMember,
	({ one }) => ({
		namespace: one(namespace, {
			fields: [namespaceMember.namespaceId],
			references: [namespace.id],
		}),
		account: one(user, {
			fields: [namespaceMember.accountId],
			references: [user.id],
		}),
	}),
);
