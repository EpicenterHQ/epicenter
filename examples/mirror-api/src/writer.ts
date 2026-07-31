/**
 * The live writer: the only handle that may change what is on disk.
 *
 * Opening a writer runs the rebuild gate. The stored declaration either matches
 * the one in hand or the mirror is dropped and starts over, because every value
 * in an external-authority mirror can be pulled again. There is no migration
 * reader and no compatibility range; that asymmetric win is what lets the shape
 * change for free.
 *
 * The writer does not own the database, the file, the directory, or the
 * authority. The caller opens a SQLite database for one authority instance
 * (one QuickBooks realm, one Gmail account) and hands it over. Two instances
 * are two calls sharing one declaration, and neither the declaration nor this
 * module ever learns which realm it is looking at.
 */

import type { SqliteDatabase, SqliteValue } from '@epicenter/sqlite';
import {
	createIndexSql,
	createTableSql,
	type Mirror,
	readPath,
	type TableDeclaration,
} from './declaration.ts';
import {
	CURSOR_KEYS,
	createReads,
	DECLARATION_KEY,
	type MirrorReads,
	type MirrorState,
	readMeta,
	tableExists,
} from './reads.ts';

/** One authority record on its way into the mirror. */
export type MirrorRecord = {
	/** The authority's own id for this record. */
	id: string;
	/** The verbatim authority object. Stored as JSON; projections read it. */
	record: Record<string, unknown>;
	/**
	 * Values for this table's `supplied` columns, all of them. Omitting one is
	 * an error rather than a null, because a silently-null search column is a
	 * bug that only shows up as an empty result page.
	 */
	supplied?: Record<string, SqliteValue>;
};

export type TableWriter = {
	/**
	 * Fold one live record in. Monotonic when the table declares `orderBy`: a
	 * write whose ordering value is older than the stored one is dropped, so a
	 * write-through fold landing after a newer sync cannot regress the row.
	 */
	upsert(row: MirrorRecord): void;
	/**
	 * Mark a record gone while keeping the last blob we saw, so projections keep
	 * reporting its last-known scalars. Requires `softDelete` on the table.
	 */
	softDelete(row: MirrorRecord): void;
	/** Physically drop a record. The authority's delete means the bytes go too. */
	remove(id: string): void;
	/**
	 * Drop every row this pass did not touch, and report how many went. The
	 * closing move of a full pull that has no delete feed to follow.
	 */
	sweep(syncedBefore: string): number;
	/**
	 * Fold an authoritative partial update into a stored record: the authority
	 * told us a field's new value without resending the record. `fold` receives
	 * the parsed record and returns the one to store. Returns false when the row
	 * is not mirrored, which the caller usually resolves by refetching it whole.
	 */
	patch(
		id: string,
		fold: (record: Record<string, unknown>) => Record<string, unknown>,
	): boolean;
};

export type WritePass = {
	/**
	 * A table handle. Creates the table (and its indexes) on first use in this
	 * pass, so table existence stays a meaningful per-table initialization
	 * latch instead of being set by merely opening the writer.
	 */
	table(name: string): TableWriter;
	/**
	 * Move the pull cursor, in the same transaction as the rows it accounts for.
	 * Fields left out keep their stored value: advancing a batch touches the
	 * cursor and `lastSyncedAt`, closing a full pull also touches
	 * `lastFullPullAt`.
	 */
	advance(state: Partial<MirrorState>): void;
};

export type MirrorWriter = MirrorReads & {
	/**
	 * What opening did. `created` is a mirror that did not exist, `reused` is a
	 * declaration match, `rebuilt` is a declaration change that dropped
	 * everything. The three are worth distinguishing in a log line: a rebuild is
	 * a full re-pull the operator did not ask for.
	 */
	readonly opened: 'created' | 'reused' | 'rebuilt';
	/**
	 * One transaction. Everything written inside commits together, including the
	 * cursor, so a crash rolls back to the previous cursor and the next pass
	 * re-pulls a window it already knows how to apply idempotently.
	 */
	write<TResult>(
		pass: { syncedAt: string },
		run: (tx: WritePass) => TResult,
	): TResult;
};

function declaredTable(mirror: Mirror, name: string): TableDeclaration {
	const definition = mirror.tables[name];
	if (!definition) {
		throw new Error(
			`Mirror "${mirror.domain}" declares no table "${name}". Declared: ${Object.keys(mirror.tables).join(', ')}`,
		);
	}
	return definition;
}

function suppliedValues(
	table: string,
	definition: TableDeclaration,
	supplied: Record<string, SqliteValue> | undefined,
): { columns: string[]; values: SqliteValue[] } {
	const columns = Object.keys(definition.supplied ?? {});
	const values = columns.map((column) => {
		const value = supplied?.[column];
		if (value === undefined) {
			throw new Error(
				`Table "${table}" declares supplied column "${column}"; the write did not provide it`,
			);
		}
		return value;
	});
	return { columns, values };
}

export function openMirrorWriter(
	mirror: Mirror,
	{ database }: { database: SqliteDatabase },
): MirrorWriter {
	const reads = createReads(database);

	const opened = database.transaction((): MirrorWriter['opened'] => {
		database.run(
			`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)`,
		);
		const stored = readMeta(database, DECLARATION_KEY);
		if (stored === mirror.canonical) return 'reused';

		// A declaration change drops every derived table and clears the pull
		// cursor, so the next pass starts from nothing. `_meta` survives because
		// it is where the new declaration is about to be stamped, and because the
		// app's own keys are not this API's to discard.
		const derived = database.all<{ name: string }>(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name != '_meta' AND name NOT LIKE 'sqlite_%'`,
		);
		for (const { name } of derived) {
			database.run(`DROP TABLE IF EXISTS ${name}`);
		}
		for (const key of CURSOR_KEYS) {
			database.run(`DELETE FROM _meta WHERE key = ?`, [key]);
		}
		database.run(
			`INSERT INTO _meta (key, value) VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			[DECLARATION_KEY, mirror.canonical],
		);
		return stored === null && derived.length === 0 ? 'created' : 'rebuilt';
	});

	function createTableWriter(
		name: string,
		definition: TableDeclaration,
		syncedAt: string,
	): TableWriter {
		if (!tableExists(database, name)) {
			database.run(createTableSql(name, definition));
			for (const sql of createIndexSql(name, definition)) database.run(sql);
		}

		const orderBy = definition.orderBy;
		const orderColumn = orderBy?.column;

		// The monotonic guard, when there is an authority ordering value to trust.
		// A null on either side falls back to last-writer-wins: there is nothing
		// to order on, and refusing the write would strand the row instead.
		const monotonic = orderColumn
			? ` WHERE excluded.${orderColumn} IS NULL
			     OR ${name}.${orderColumn} IS NULL
			     OR excluded.${orderColumn} >= ${name}.${orderColumn}`
			: '';

		function writeRow(row: MirrorRecord, deleted: boolean): void {
			const supplied = suppliedValues(name, definition, row.supplied);
			const columns = ['id', 'raw', 'synced_at'];
			const values: SqliteValue[] = [
				row.id,
				JSON.stringify(row.record),
				syncedAt,
			];
			if (orderBy) {
				columns.push(orderBy.column);
				values.push(readPath(row.record, orderBy.from));
			}
			if (definition.softDelete) {
				columns.push('deleted');
				values.push(deleted ? 1 : 0);
			}
			columns.push(...supplied.columns);
			values.push(...supplied.values);

			// A soft delete keeps the stored blob: the authority's delete payload is
			// a stub, and the mirror now holds the only copy of what the record was.
			// So the conflict path updates the bookkeeping columns and leaves `raw`
			// and the projections alone.
			const updated = deleted
				? ['synced_at', ...(orderColumn ? [orderColumn] : []), 'deleted']
				: columns.filter((column) => column !== 'id');

			database.run(
				`INSERT INTO ${name} (${columns.join(', ')})
				 VALUES (${columns.map(() => '?').join(', ')})
				 ON CONFLICT(id) DO UPDATE SET ${updated
						.map((column) => `${column} = excluded.${column}`)
						.join(', ')}${monotonic}`,
				values,
			);
		}

		return {
			upsert(row) {
				writeRow(row, false);
			},

			softDelete(row) {
				if (!definition.softDelete) {
					throw new Error(
						`Table "${name}" does not declare softDelete; use remove() or declare it`,
					);
				}
				writeRow(row, true);
			},

			remove(id) {
				database.run(`DELETE FROM ${name} WHERE id = ?`, [id]);
			},

			sweep(syncedBefore) {
				database.run(`DELETE FROM ${name} WHERE synced_at < ?`, [syncedBefore]);
				return database.all<{ n: number }>(`SELECT changes() AS n`)[0]?.n ?? 0;
			},

			patch(id, fold) {
				const rows = database.all<{ raw: string }>(
					`SELECT raw FROM ${name} WHERE id = ?`,
					[id],
				);
				const raw = rows[0]?.raw;
				if (raw === undefined) return false;
				const next = fold(JSON.parse(raw) as Record<string, unknown>);
				const columns = ['raw = ?', 'synced_at = ?'];
				const values: SqliteValue[] = [JSON.stringify(next), syncedAt];
				if (orderBy) {
					columns.push(`${orderBy.column} = ?`);
					values.push(readPath(next, orderBy.from));
				}
				values.push(id);
				database.run(
					`UPDATE ${name} SET ${columns.join(', ')} WHERE id = ?`,
					values,
				);
				return true;
			},
		};
	}

	return {
		...reads,
		opened,

		write(pass, run) {
			return database.transaction(() => {
				const tables = new Map<string, TableWriter>();
				return run({
					table(name) {
						const existing = tables.get(name);
						if (existing) return existing;
						const writer = createTableWriter(
							name,
							declaredTable(mirror, name),
							pass.syncedAt,
						);
						tables.set(name, writer);
						return writer;
					},
					advance(state) {
						const entries: [string, string | null][] = [];
						if ('cursor' in state)
							entries.push(['cursor', state.cursor ?? null]);
						if ('lastFullPullAt' in state) {
							entries.push(['last_full_pull_at', state.lastFullPullAt ?? null]);
						}
						if ('lastSyncedAt' in state) {
							entries.push(['last_synced_at', state.lastSyncedAt ?? null]);
						}
						for (const [key, value] of entries) {
							database.run(
								`INSERT INTO _meta (key, value) VALUES (?, ?)
								 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
								[key, value],
							);
						}
					},
				});
			});
		},
	};
}
