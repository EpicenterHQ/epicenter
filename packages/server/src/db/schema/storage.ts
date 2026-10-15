import {
	bigint,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from 'drizzle-orm/pg-core';

/**
 * One absolute physical-size observation per storage source (ADR-0137).
 *
 * No code reads or writes this table today. It stays in the schema because
 * migration `0000_direct_sessions.sql` created it and deployed Postgres holds
 * rows; removing it here would make the next generated migration drop that
 * data. Dropping it is a separate migration decision.
 *
 * `sourceKind` reads `'workspace'` where the rest of the codebase now says
 * store. That value is a stored fact from before the rename, not a word
 * anybody should copy. Historically, zero-byte `workspace` rows registered
 * logical data ids, `structured` recorded the account authority's absolute
 * `databaseSize`, and `blobs` recorded the account's listed object bytes.
 */
export const storageObservation = pgTable(
	'storage_observation',
	{
		principalId: text('principal_id').notNull(),
		sourceKind: text('source_kind', {
			enum: ['workspace', 'structured', 'blobs'],
		}).notNull(),
		sourceId: text('source_id').notNull(),
		observedBytes: bigint('observed_bytes', { mode: 'number' }).notNull(),
		observedAt: timestamp('observed_at').defaultNow().notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.principalId, table.sourceKind, table.sourceId],
		}),
	],
);
