/**
 * Folders (ADR-0811): the one thing that is synced and shared. A folder has
 * an id, minted by the server at its first sync, and its history is a Git
 * repository that storage names by that id. It keeps no name or title: its
 * title is in its `epicenter.json`, read from its files.
 *
 * Its members are people (`folder_member`). A share is a member row whose
 * `accepted_at` is null: it grants nothing and shows only to the person it
 * names, until they accept it. Any member may be an owner. A folder lives
 * while an accepted member remains: the `folder_member_left` trigger in
 * `apps/api/drizzle` deletes it when its last one leaves, account deletion
 * included, and makes the earliest member an owner when its last owner
 * leaves others behind.
 *
 * `folder_app` records the apps a folder is attached to (ADR-0811), by the
 * OAuth client id the app signs in as. A token from an app reaches the
 * folders attached to it; a token with `folders:all` (the CLI, the Epicenter
 * app) reaches every folder its person holds.
 *
 * A `blob_upload` is an attachment's bytes uploaded to a folder and not yet
 * kept by a commit (ADR-0809): a commit that references it deletes the row,
 * and `sweepPendingUploads` deletes the bytes of one still pending after a
 * day, with the row. Bytes uploaded before the ledger, or kept, have no row
 * and are never swept.
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

export const folder = pgTable(
	'folder',
	{
		/** Sixteen characters of lowercase a-z and 0-9; storage's name for its repository. */
		id: text('id').primaryKey(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [check('folder_id_format', sql`${table.id} ~ '^[a-z0-9]{16}$'`)],
);

/** What a member may do: read; also write; also rewrite `main` and manage the folder. */
export const FOLDER_ROLES = ['owner', 'writer', 'reader'] as const;

export const folderMember = pgTable(
	'folder_member',
	{
		folderId: text('folder_id')
			.notNull()
			.references(() => folder.id, { onDelete: 'cascade' }),
		accountId: text('account_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		role: text('role', { enum: FOLDER_ROLES }).notNull(),
		/** Who shared it with this person; null for its maker, or once they are gone. */
		sharedBy: text('shared_by').references(() => user.id, {
			onDelete: 'set null',
		}),
		/** When the person accepted the share; null while it waits. */
		acceptedAt: timestamp('accepted_at'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.folderId, table.accountId] }),
		index('folder_member_account_id_idx').on(table.accountId),
		check(
			'folder_member_role',
			sql`${table.role} in ('owner', 'writer', 'reader')`,
		),
	],
);

export const folderApp = pgTable(
	'folder_app',
	{
		folderId: text('folder_id')
			.notNull()
			.references(() => folder.id, { onDelete: 'cascade' }),
		/** The OAuth client id the app signs in as, such as `so.epicenter.todos`. */
		app: text('app').notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.folderId, table.app] }),
		index('folder_app_app_idx').on(table.app),
	],
);

export const folderRelations = relations(folder, ({ many }) => ({
	members: many(folderMember),
	apps: many(folderApp),
}));

export const folderMemberRelations = relations(folderMember, ({ one }) => ({
	folder: one(folder, {
		fields: [folderMember.folderId],
		references: [folder.id],
	}),
	account: one(user, {
		fields: [folderMember.accountId],
		references: [user.id],
	}),
}));

export const folderAppRelations = relations(folderApp, ({ one }) => ({
	folder: one(folder, {
		fields: [folderApp.folderId],
		references: [folder.id],
	}),
}));

export const blobUpload = pgTable(
	'blob_upload',
	{
		folderId: text('folder_id')
			.notNull()
			.references(() => folder.id, { onDelete: 'cascade' }),
		/** The attachment's sha256, its Git LFS object id. */
		oid: text('oid').notNull(),
		uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.folderId, table.oid] }),
		index('blob_upload_uploaded_at_idx').on(table.uploadedAt),
		check('blob_upload_oid_format', sql`${table.oid} ~ '^[0-9a-f]{64}$'`),
	],
);
