/**
 * Folders (ADR-0811): the one thing that is synced and shared. A folder has
 * an id, minted by the server when it is made, and its history is a log of
 * versions (ADR-0824): `change`, `change_file`, `file`, and `blob` below,
 * with marks naming changes (`mark`, ADR-0826). It keeps no name or title:
 * its title is in its `epicenter.json`, read from its files.
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
 */
import { relations, sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	customType,
	foreignKey,
	index,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const folder = pgTable(
	'folder',
	{
		/** Sixteen characters of lowercase a-z and 0-9; the blob store names its bytes by it too. */
		id: text('id').primaryKey(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		/** The sequence number of its last change, 0 before the first; each commit locks this row to take the next. */
		seq: bigint('seq', { mode: 'number' }).default(0).notNull(),
		/**
		 * Which log `seq` counts in: a cursor is `<epoch>.<seq>`, so a cursor
		 * from a log that was reset or restored names nothing here.
		 */
		epoch: text('epoch')
			.default(sql`substr(md5(gen_random_uuid()::text), 1, 12)`)
			.notNull(),
		/**
		 * Whether an import (ADR-0826) is still replaying history into it: only
		 * then may a change carry its own author, time, and message.
		 */
		importing: boolean('importing').default(false).notNull(),
	},
	(table) => [
		check('folder_id_format', sql`${table.id} ~ '^[a-z0-9]{16}$'`),
		check('folder_epoch_format', sql`${table.epoch} ~ '^[a-z0-9]{1,32}$'`),
	],
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
		check('folder_member_role', sql`${table.role} in ('member', 'reader')`),
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
		check('folder_invitation_role', sql`${table.role} in ('member', 'reader')`),
		check(
			'folder_invitation_email_lower',
			sql`${table.email} = lower(${table.email})`,
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

/** Postgres `bytea`, as bytes. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
	dataType: () => 'bytea',
	toDriver: (bytes) => Buffer.from(bytes),
	fromDriver: (buffer) => new Uint8Array(buffer),
});

/** A path or a folded name, compared byte by byte, so a range over a prefix is one index scan. */
const bytewise = customType<{ data: string }>({
	dataType: () => 'text COLLATE "C"',
});

/** What a folder holds of a version's bytes. */
export const BLOB_STATES = ['pending', 'kept', 'purged'] as const;

/**
 * Each SHA-256 a folder holds bytes for (ADR-0824, amending ADR-0809): its
 * size; its bytes inline when they are small, else in the blob store at
 * `folders/<id>/blobs/<sha256>`; and whether it is `pending` (uploaded, and
 * named by no change yet), `kept` (a change names it), or `purged` (its
 * bytes are gone, and every row naming it stays). Bytes stay per folder.
 */
export const blob = pgTable(
	'blob',
	{
		folderId: text('folder_id')
			.notNull()
			.references(() => folder.id, { onDelete: 'cascade' }),
		sha256: text('sha256').notNull(),
		size: bigint('size', { mode: 'number' }).notNull(),
		state: text('state', { enum: BLOB_STATES }).notNull(),
		inline: bytea('inline'),
		uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.folderId, table.sha256] }),
		index('blob_pending_idx')
			.on(table.uploadedAt)
			.where(sql`${table.state} = 'pending'`),
		check('blob_sha256_format', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
		check('blob_state', sql`${table.state} in ('pending', 'kept', 'purged')`),
		check(
			'blob_purged_inline',
			sql`${table.state} <> 'purged' or ${table.inline} is null`,
		),
	],
);

/**
 * One change of a folder's log (ADR-0824): its sequence number, dense and in
 * commit order; when; who, by account id and as their name and email read
 * then; the program (`via`, the OAuth client the token was issued to); an
 * imported commit's message (ADR-0826), null otherwise; and `digest`, the
 * SHA-256 of the previous change's digest and this change's canonical text
 * (`epicenter_commit` in `apps/api/drizzle`). The account id is no foreign
 * key: history outlives an account.
 */
export const change = pgTable(
	'change',
	{
		folderId: text('folder_id')
			.notNull()
			.references(() => folder.id, { onDelete: 'cascade' }),
		seq: bigint('seq', { mode: 'number' }).notNull(),
		at: timestamp('at', { withTimezone: true }).notNull(),
		accountId: text('account_id'),
		authorText: text('author_text').notNull(),
		via: text('via').notNull(),
		message: text('message'),
		digest: text('digest').notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.folderId, table.seq] }),
		index('change_at_idx').on(table.folderId, table.at),
	],
);

/** Each path a change wrote: its version, or null for a deletion, and its size. */
export const changeFile = pgTable(
	'change_file',
	{
		folderId: text('folder_id').notNull(),
		seq: bigint('seq', { mode: 'number' }).notNull(),
		path: bytewise('path').notNull(),
		version: text('version'),
		size: bigint('size', { mode: 'number' }),
	},
	(table) => [
		primaryKey({ columns: [table.folderId, table.path, table.seq] }),
		index('change_file_seq_idx').on(table.folderId, table.seq),
		foreignKey({
			columns: [table.folderId, table.seq],
			foreignColumns: [change.folderId, change.seq],
		}).onDelete('cascade'),
		foreignKey({
			columns: [table.folderId, table.version],
			foreignColumns: [blob.folderId, blob.sha256],
		}),
	],
);

/**
 * Each path a folder holds now: its version and size, and the change that
 * wrote it. `folded` is the path as a disk that ignores case compares it
 * (NFC, then lower case), unique in the folder; a commit also refuses a file
 * where a folder is, below a file, or in a folder spelled in another case.
 */
export const file = pgTable(
	'file',
	{
		folderId: text('folder_id')
			.notNull()
			.references(() => folder.id, { onDelete: 'cascade' }),
		path: bytewise('path').notNull(),
		folded: bytewise('folded').notNull(),
		version: text('version').notNull(),
		size: bigint('size', { mode: 'number' }).notNull(),
		seq: bigint('seq', { mode: 'number' }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.folderId, table.path] }),
		unique('file_folded_unique').on(table.folderId, table.folded),
		foreignKey({
			columns: [table.folderId, table.version],
			foreignColumns: [blob.folderId, blob.sha256],
		}),
	],
);

/**
 * A name a person gave one change (ADR-0826, `epicenter mark`): the export
 * writes it as a Git tag, and an import reads tags into marks.
 */
export const mark = pgTable(
	'mark',
	{
		folderId: text('folder_id')
			.notNull()
			.references(() => folder.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		seq: bigint('seq', { mode: 'number' }).notNull(),
		accountId: text('account_id'),
		at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.folderId, table.name] }),
		foreignKey({
			columns: [table.folderId, table.seq],
			foreignColumns: [change.folderId, change.seq],
		}).onDelete('cascade'),
	],
);
