/**
 * Folders (ADR-0811): the one thing that is synced and shared. A folder has
 * an id, minted by the server at its first sync, and its history is a Git
 * repository that storage names by that id. It keeps no name or title: its
 * title is in its `epicenter.json`, read from its files.
 *
 * Its members are people who accepted it (`folder_member`), and equal: a
 * `member` or a `reader`, and no owner (ADR-0820). A share is an invitation
 * to an email (`folder_invitation`): it names no account, grants nothing,
 * and shows only to the person whose verified email it names, whether they
 * had an account when it was made or signed up later, until they accept it
 * and become a member. A folder lives while a member remains: the
 * `folder_member_left` trigger in `apps/api/drizzle` deletes it when its
 * last one leaves, account deletion included.
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

/** What a person holding a folder may do: everything, or read (`folder-roles.ts`). */
export const FOLDER_ROLES = ['member', 'reader'] as const;

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
		/** When the person became a member: made the folder, or accepted its invitation. */
		acceptedAt: timestamp('accepted_at').defaultNow().notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.folderId, table.accountId] }),
		index('folder_member_account_id_idx').on(table.accountId),
		check(
			'folder_member_role',
			sql`${table.role} in ('member', 'reader')`,
		),
	],
);

/**
 * A share waiting to be accepted (ADR-0820): an invitation to an email, in
 * lower case, never to an account, so making one says nothing about whether
 * anyone signs in with it. The person whose account has that email, verified,
 * sees it and may accept it; accepting makes them a member and removes it.
 */
export const folderInvitation = pgTable(
	'folder_invitation',
	{
		folderId: text('folder_id')
			.notNull()
			.references(() => folder.id, { onDelete: 'cascade' }),
		/** The email it is for, in lower case. */
		email: text('email').notNull(),
		/** The role accepting gives. */
		role: text('role', { enum: FOLDER_ROLES }).notNull(),
		/** The member who shared it; null once they are gone. */
		sharedBy: text('shared_by').references(() => user.id, {
			onDelete: 'set null',
		}),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.folderId, table.email] }),
		index('folder_invitation_email_idx').on(table.email),
		check(
			'folder_invitation_role',
			sql`${table.role} in ('member', 'reader')`,
		),
		check('folder_invitation_email_lower', sql`${table.email} = lower(${table.email})`),
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
	invitations: many(folderInvitation),
	apps: many(folderApp),
}));

export const folderInvitationRelations = relations(
	folderInvitation,
	({ one }) => ({
		folder: one(folder, {
			fields: [folderInvitation.folderId],
			references: [folder.id],
		}),
	}),
);

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
