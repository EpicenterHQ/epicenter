import {
	type AcquireRequest,
	CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	type CurrentStateWireRowIntent,
	canonicalJson,
	encodedJsonBytes,
	foldFields,
	type JsonObject,
	type PullEntry,
	type PullRequest,
	type PushRequest,
	parseAcquireResponse,
	parseCurrentStateRowIntent,
	parsePullResponse,
	parsePushResponse,
	ROW_SYNC_ADMISSION_LIMITS,
	type RoundReceipt,
	rowRoundDigest,
} from '@epicenter/row-sync';
import type { SqliteDatabase } from '@epicenter/sqlite';
import {
	captureLogicalWorkspace,
	type LogicalWorkspaceCopy,
} from './canonical-addition.js';
import type { CanonicalSyncDriverResult } from './canonical-sync-supervisor.js';

/** Incompatible synchronized Account storage. Device storage never opens here. */
const STORAGE_VERSION = 4;

const TABLES = {
	rows: 'rows',
	intents: 'intents',
	replica: 'replica',
	guards: 'installed_guards',
	scratchRows: 'acquisition_scratch_rows',
	scratchGuards: 'acquisition_scratch_guards',
} as const;

type StoredReplica = {
	replica_id: string;
	retired_round: number;
	retired_digest: string | null;
	retired_through: number;
	checkpoint: number;
	admission_head: number;
	sealed_digest: string | null;
	acquired: number;
	recovery_required: number;
};

type StoredIntent = {
	table_key: string;
	row_id: string;
	sealed: number;
	birth_sequence: number;
	kind: 'create' | 'update' | 'delete';
	fields_json: string | null;
};

type StoredGuard = {
	installed_sequence: number;
};

type RowAddress = { table: string; rowId: string };

function mintReplicaId(): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let id = '';
	while (id.length < 24) {
		const bytes = new Uint8Array(24 - id.length);
		globalThis.crypto.getRandomValues(bytes);
		for (const byte of bytes) {
			if (byte < 252) id += alphabet[byte % alphabet.length];
		}
	}
	return id;
}

/** Separate internal operations. Applications never receive this transport. */
export type CurrentStateReplicaTransport = {
	push(request: PushRequest): Promise<unknown>;
	pull(request: PullRequest): Promise<unknown>;
	acquire(request: AcquireRequest): Promise<unknown>;
};

export type CurrentStateReplicaSyncResult = CanonicalSyncDriverResult;

export type CurrentStateReplicaStatus = {
	checkpoint: number;
	admissionHead: number;
	pendingIntents: number;
	hasSealed: boolean;
	isAcquired: boolean;
	isRecoveryRequired: boolean;
};

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function dropTable(sqlite: SqliteDatabase, table: string): void {
	sqlite.run(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
}

function dropScratch(sqlite: SqliteDatabase): void {
	dropTable(sqlite, TABLES.scratchRows);
	dropTable(sqlite, TABLES.scratchGuards);
}

function createSchema(sqlite: SqliteDatabase): void {
	sqlite.run(`
		CREATE TABLE "${TABLES.rows}" (
			table_key TEXT NOT NULL,
			row_id TEXT NOT NULL,
			fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
			PRIMARY KEY(table_key, row_id)
		) WITHOUT ROWID, STRICT
	`);
	sqlite.run(`
		CREATE TABLE "${TABLES.guards}" (
			table_key TEXT NOT NULL,
			row_id TEXT NOT NULL,
			installed_sequence INTEGER NOT NULL CHECK(installed_sequence > 0),
			PRIMARY KEY(table_key, row_id)
		) WITHOUT ROWID, STRICT
	`);
	sqlite.run(`
		CREATE TABLE "${TABLES.intents}" (
			table_key TEXT NOT NULL,
			row_id TEXT NOT NULL,
			sealed INTEGER NOT NULL CHECK(sealed IN (0, 1)),
			birth_sequence INTEGER NOT NULL CHECK(birth_sequence > 0),
			kind TEXT NOT NULL CHECK(kind IN ('create', 'update', 'delete')),
			fields_json TEXT CHECK(fields_json IS NULL OR json_valid(fields_json)),
			PRIMARY KEY(table_key, row_id, sealed),
			CHECK((kind = 'delete' AND fields_json IS NULL) OR
				(kind != 'delete' AND fields_json IS NOT NULL))
		) WITHOUT ROWID, STRICT
	`);
	sqlite.run(`
		CREATE TABLE "${TABLES.replica}" (
			id INTEGER PRIMARY KEY CHECK(id = 1),
			replica_id TEXT NOT NULL,
			retired_round INTEGER NOT NULL CHECK(retired_round >= 0),
			retired_digest TEXT,
			retired_through INTEGER NOT NULL CHECK(retired_through >= 0),
			checkpoint INTEGER NOT NULL CHECK(checkpoint >= 0),
			admission_head INTEGER NOT NULL CHECK(admission_head >= 0),
			sealed_digest TEXT,
			acquired INTEGER NOT NULL CHECK(acquired IN (0, 1)),
			recovery_required INTEGER NOT NULL CHECK(recovery_required IN (0, 1)),
			CHECK(
				(retired_round = 0 AND retired_digest IS NULL AND
					retired_through = 0)
				OR
				(retired_round > 0 AND retired_digest IS NOT NULL AND
					retired_through > 0)
			)
		) STRICT
	`);
	sqlite.run(
		`
		INSERT INTO "${TABLES.replica}"(
			id, replica_id, retired_round, retired_digest, retired_through,
			checkpoint, admission_head, sealed_digest, acquired,
			recovery_required
		) VALUES (1, ?, 0, NULL, 0, 0, 0, NULL, 0, 0)
	`,
		[mintReplicaId()],
	);
}

/** Reset only this synchronized Account file. Device storage never calls this. */
export function initializeCurrentStateReplicaSchema(
	sqlite: SqliteDatabase,
): void {
	sqlite.transaction(() => {
		const version =
			sqlite.all<{ user_version: number }>('PRAGMA user_version')[0]
				?.user_version ?? 0;
		if (version !== STORAGE_VERSION) {
			for (const table of Object.values(TABLES)) dropTable(sqlite, table);
			createSchema(sqlite);
			sqlite.run(`PRAGMA user_version = ${STORAGE_VERSION}`);
		}
		dropScratch(sqlite);
	});
}

function resetCurrentStateReplicaSchema(
	sqlite: SqliteDatabase,
	alsoInTransaction: () => void = () => undefined,
): void {
	sqlite.transaction(() => {
		for (const table of Object.values(TABLES)) dropTable(sqlite, table);
		createSchema(sqlite);
		sqlite.run(`PRAGMA user_version = ${STORAGE_VERSION}`);
		alsoInTransaction();
	});
}

function assertLimit(value: number, maximum: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new TypeError(
			`${label} limit must be an integer from 1 through ${maximum}`,
		);
	}
}

function receiptEquals(left: RoundReceipt, right: RoundReceipt): boolean {
	return (
		left.acceptedRound === right.acceptedRound &&
		left.requestDigest === right.requestDigest &&
		left.appliedThrough === right.appliedThrough
	);
}

function retiredReceipt(replica: StoredReplica): RoundReceipt {
	return {
		acceptedRound: replica.retired_round,
		requestDigest: replica.retired_digest,
		appliedThrough: replica.retired_through,
	};
}

function storedIntentToWire(stored: StoredIntent): CurrentStateWireRowIntent {
	switch (stored.kind) {
		case 'delete':
			return {
				kind: 'delete',
				table: stored.table_key,
				rowId: stored.row_id,
			};
		case 'create':
			return {
				kind: 'create',
				table: stored.table_key,
				rowId: stored.row_id,
				fields: JSON.parse(stored.fields_json ?? '{}'),
			};
		case 'update':
			return {
				kind: 'update',
				table: stored.table_key,
				rowId: stored.row_id,
				fields: JSON.parse(stored.fields_json ?? '{}'),
			};
	}
}

function projectIntent(
	current: JsonObject | undefined,
	intent: CurrentStateWireRowIntent,
): JsonObject | undefined {
	if (intent.kind === 'delete') return undefined;
	const folded = foldFields(current, intent);
	switch (folded.kind) {
		case 'fields':
			return folded.fields;
		case 'deletion':
			return undefined;
		case 'noop':
			return current;
	}
}

function composeFieldChanges(
	older: { set: JsonObject; unset: string[] } | undefined,
	newer: { set: JsonObject; unset: string[] } | undefined,
): { set: JsonObject; unset: string[] } | undefined {
	if (older === undefined) return newer;
	if (newer === undefined) return older;
	const set = Object.create(null) as JsonObject;
	for (const [key, value] of Object.entries(older.set)) {
		if (!newer.unset.includes(key) && !Object.hasOwn(newer.set, key)) {
			Object.defineProperty(set, key, {
				configurable: true,
				enumerable: true,
				value,
				writable: true,
			});
		}
	}
	for (const [key, value] of Object.entries(newer.set)) {
		Object.defineProperty(set, key, {
			configurable: true,
			enumerable: true,
			value,
			writable: true,
		});
	}
	const unset = [
		...older.unset.filter((key) => !Object.hasOwn(set, key)),
		...newer.unset.filter((key) => !older.unset.includes(key)),
	];
	return { set, unset };
}

/**
 * Open the new synchronized Account replica beside the old canonical path.
 * This factory owns no background policy: one workspace supervisor drives its
 * fixed-cut methods and classifies transport interruption.
 */
export function createCurrentStateReplica({
	sqlite,
	transport,
	documents,
	onRemoteCommit = () => undefined,
	onRowsDeleted = () => undefined,
	onAcquisitionPromoted = () => undefined,
	roundLimit = ROW_SYNC_ADMISSION_LIMITS.intentsPerRound,
	pageLimit = ROW_SYNC_ADMISSION_LIMITS.pullEntriesPerPage,
	acquirePageLimit = ROW_SYNC_ADMISSION_LIMITS.acquiredRowsPerPage,
}: {
	sqlite: SqliteDatabase;
	transport: CurrentStateReplicaTransport;
	/**
	 * Owner-side document lifecycle joined to this replica's row lifecycle.
	 * `deleteRows`/`deleteAllRows` run inside the same transaction that ends
	 * a row's projected visible life (local intent compaction, authority page
	 * installation plus intent retirement, acquisition promotion, fresh
	 * lineage), and `capture` folds compact document state into visible
	 * captures. The replica stays ignorant of what a document is; it only
	 * names the lifecycle moments.
	 */
	documents?: {
		capture(address: RowAddress): Uint8Array | undefined;
		deleteRows(addresses: readonly RowAddress[]): void;
		deleteAllRows(): void;
	};
	onRemoteCommit?: () => void;
	onRowsDeleted?: (addresses: RowAddress[]) => void;
	onAcquisitionPromoted?: () => void;
	roundLimit?: number;
	pageLimit?: number;
	acquirePageLimit?: number;
}) {
	assertLimit(roundLimit, ROW_SYNC_ADMISSION_LIMITS.intentsPerRound, 'round');
	assertLimit(pageLimit, ROW_SYNC_ADMISSION_LIMITS.pullEntriesPerPage, 'page');
	assertLimit(
		acquirePageLimit,
		ROW_SYNC_ADMISSION_LIMITS.acquiredRowsPerPage,
		'acquisition page',
	);
	initializeCurrentStateReplicaSchema(sqlite);

	let synchronizationTail = Promise.resolve();

	function readReplica(): StoredReplica {
		const replica = sqlite.all<StoredReplica>(
			`SELECT replica_id, retired_round, retired_digest, retired_through,
			        checkpoint, admission_head, sealed_digest, acquired,
			        recovery_required
			 FROM "${TABLES.replica}" WHERE id = 1`,
		)[0];
		if (!replica) throw new Error('Current-state replica is not initialized');
		return replica;
	}

	function readStoredIntents(sealed: 0 | 1): StoredIntent[] {
		return sqlite.all<StoredIntent>(
			`SELECT table_key, row_id, sealed, birth_sequence, kind,
			        fields_json
			 FROM "${TABLES.intents}"
			 WHERE sealed = ?
			 ORDER BY birth_sequence, table_key, row_id`,
			[sealed],
		);
	}

	function readAddressIntent(
		table: string,
		rowId: string,
		sealed: 0 | 1,
	): StoredIntent | undefined {
		return sqlite.all<StoredIntent>(
			`SELECT table_key, row_id, sealed, birth_sequence, kind,
			        fields_json
			 FROM "${TABLES.intents}"
			 WHERE table_key = ? AND row_id = ? AND sealed = ?`,
			[table, rowId, sealed],
		)[0];
	}

	function writeStoredIntent(
		intent: CurrentStateWireRowIntent,
		sealed: 0 | 1,
		birthSequence: number,
	): void {
		const parsed = parseCurrentStateRowIntent(intent);
		const fieldsJson =
			parsed.kind === 'delete' ? null : JSON.stringify(parsed.fields);
		sqlite.run(
			`INSERT INTO "${TABLES.intents}"(
				table_key, row_id, sealed, birth_sequence, kind, fields_json
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(table_key, row_id, sealed) DO UPDATE SET
				birth_sequence = excluded.birth_sequence,
				kind = excluded.kind,
				fields_json = excluded.fields_json`,
			[
				parsed.table,
				parsed.rowId,
				sealed,
				birthSequence,
				parsed.kind,
				fieldsJson,
			],
		);
	}

	function readConfirmedRow(
		table: string,
		rowId: string,
	): JsonObject | undefined {
		const row = sqlite.all<{ fields_json: string }>(
			`SELECT fields_json FROM "${TABLES.rows}"
			 WHERE table_key = ? AND row_id = ?`,
			[table, rowId],
		)[0];
		return row ? JSON.parse(row.fields_json) : undefined;
	}

	function readCurrentRow(
		table: string,
		rowId: string,
	): JsonObject | undefined {
		let current = readConfirmedRow(table, rowId);
		for (const stored of sqlite.all<StoredIntent>(
			`SELECT table_key, row_id, sealed, birth_sequence, kind,
			        fields_json
			 FROM "${TABLES.intents}"
			 WHERE table_key = ? AND row_id = ?
			 ORDER BY sealed DESC`,
			[table, rowId],
		)) {
			current = projectIntent(current, storedIntentToWire(stored));
		}
		return current;
	}

	function uniqueAddresses(addresses: readonly RowAddress[]): RowAddress[] {
		const unique = new Map<string, RowAddress>();
		for (const address of addresses) {
			unique.set(`${address.table}\u0000${address.rowId}`, address);
		}
		return [...unique.values()];
	}

	function readLiveAddresses(addresses: readonly RowAddress[]): RowAddress[] {
		return uniqueAddresses(addresses).filter(
			({ table, rowId }) => readCurrentRow(table, rowId) !== undefined,
		);
	}

	function rowsWhoseVisibleLifeEnded(
		previouslyLive: readonly RowAddress[],
	): RowAddress[] {
		return previouslyLive.filter(
			({ table, rowId }) => readCurrentRow(table, rowId) === undefined,
		);
	}

	function compactIntoOpen(
		next: CurrentStateWireRowIntent,
		birthSequence: number,
	): void {
		const existing = readAddressIntent(next.table, next.rowId, 0);
		if (!existing) {
			writeStoredIntent(next, 0, birthSequence);
			return;
		}
		const open = storedIntentToWire(existing);
		if (open.kind === 'delete') {
			throw new Error('A locally deleted row accepts no further intent');
		}
		if (next.kind === 'create') {
			writeStoredIntent(next, 0, existing.birth_sequence);
			return;
		}
		if (next.kind === 'delete') {
			if (open.kind === 'create') {
				sqlite.run(
					`DELETE FROM "${TABLES.intents}"
					 WHERE table_key = ? AND row_id = ? AND sealed = 0`,
					[next.table, next.rowId],
				);
				return;
			}
			writeStoredIntent(next, 0, existing.birth_sequence);
			return;
		}
		if (open.kind === 'create') {
			const folded = foldFields(open.fields, next);
			const fields = folded.kind === 'fields' ? folded.fields : undefined;
			if (fields === undefined) {
				throw new Error('Local intent composition exceeded its size cap');
			}
			writeStoredIntent(
				{
					kind: 'create',
					table: next.table,
					rowId: next.rowId,
					fields,
				},
				0,
				existing.birth_sequence,
			);
			return;
		}
		const fields = composeFieldChanges(open.fields, next.fields);
		if (fields === undefined) {
			throw new Error('Scalar update composition produced no field changes');
		}
		writeStoredIntent(
			{
				kind: 'update',
				table: next.table,
				rowId: next.rowId,
				fields,
			},
			0,
			existing.birth_sequence,
		);
	}

	function prepareLocalIntent(
		intent: CurrentStateWireRowIntent,
	): CurrentStateWireRowIntent {
		return parseCurrentStateRowIntent(intent);
	}

	function intentChangesProjection(intent: CurrentStateWireRowIntent): boolean {
		const beforeRow = readCurrentRow(intent.table, intent.rowId);
		const afterRow = projectIntent(beforeRow, intent);
		return canonicalJson(beforeRow ?? null) !== canonicalJson(afterRow ?? null);
	}

	function sealedBirthAtOrBefore(cut: number): boolean {
		return Boolean(
			sqlite.all<{ present: number }>(
				`SELECT 1 AS present FROM "${TABLES.intents}"
				 WHERE sealed = 1 AND birth_sequence <= ? LIMIT 1`,
				[cut],
			)[0],
		);
	}

	function openBirthAtOrBefore(cut: number): boolean {
		return Boolean(
			sqlite.all<{ present: number }>(
				`SELECT 1 AS present FROM "${TABLES.intents}"
				 WHERE sealed = 0 AND birth_sequence <= ? LIMIT 1`,
				[cut],
			)[0],
		);
	}

	function sealRound(maxBirthSequence?: number): void {
		sqlite.transaction(() => {
			const replica = readReplica();
			if (replica.sealed_digest !== null) return;
			const candidates = readStoredIntents(0).filter(
				(intent) =>
					maxBirthSequence === undefined ||
					intent.birth_sequence <= maxBirthSequence,
			);
			if (candidates.length === 0) return;
			let selected = candidates.slice(0, roundLimit);
			let intents = selected.map(storedIntentToWire);
			const encodedBytes = () =>
				encodedJsonBytes({
					protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
					kind: 'push',
					replicaId: replica.replica_id,
					round: replica.retired_round + 1,
					requestDigest: '0'.repeat(64),
					intents,
				});
			while (
				selected.length > 1 &&
				encodedBytes() > ROW_SYNC_ADMISSION_LIMITS.encodedRoundBytes
			) {
				selected = selected.slice(0, -1);
				intents = intents.slice(0, -1);
			}
			if (encodedBytes() > ROW_SYNC_ADMISSION_LIMITS.encodedRoundBytes) {
				throw new Error('One open intent exceeds the sealed round bound');
			}
			const digest = rowRoundDigest(intents);
			for (const intent of selected) {
				sqlite.run(
					`UPDATE "${TABLES.intents}" SET sealed = 1
					 WHERE table_key = ? AND row_id = ? AND sealed = 0`,
					[intent.table_key, intent.row_id],
				);
			}
			sqlite.run(
				`UPDATE "${TABLES.replica}" SET sealed_digest = ? WHERE id = 1`,
				[digest],
			);
		});
	}

	function receiptMatchesLineage(
		replica: StoredReplica,
		receipt: RoundReceipt,
	): boolean {
		const retired = retiredReceipt(replica);
		if (replica.sealed_digest === null) return receiptEquals(receipt, retired);
		if (receiptEquals(receipt, retired)) return true;
		return (
			receipt.acceptedRound === replica.retired_round + 1 &&
			receipt.requestDigest === replica.sealed_digest &&
			receipt.appliedThrough > replica.retired_through
		);
	}

	function enterRecoveryRequired(): CurrentStateReplicaSyncResult {
		sqlite.run(
			`UPDATE "${TABLES.replica}" SET recovery_required = 1 WHERE id = 1`,
		);
		return { outcome: 'recovery-required', reason: 'lineage-mismatch' };
	}

	async function pushSealedIfNeeded(
		maxBirthSequence?: number,
	): Promise<CurrentStateReplicaSyncResult | null> {
		sealRound(maxBirthSequence);
		const replica = readReplica();
		if (replica.sealed_digest === null) return null;
		if (
			maxBirthSequence !== undefined &&
			!sealedBirthAtOrBefore(maxBirthSequence)
		) {
			return null;
		}
		const intents = readStoredIntents(1).map(storedIntentToWire);
		if (intents.length === 0) {
			throw new Error('Stored sealed digest has no immutable intents');
		}
		const digest = rowRoundDigest(intents);
		if (digest !== replica.sealed_digest) {
			throw new Error('Sealed intents no longer match their stored digest');
		}
		const response = parsePushResponse(
			await transport.push({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'push',
				replicaId: replica.replica_id,
				round: replica.retired_round + 1,
				requestDigest: digest,
				intents,
			}),
		);
		if (response.result === 'protocol-mismatch') {
			return { outcome: 'upgrade-required' };
		}
		if (response.result === 'storage-limit') {
			return { outcome: 'pending', reason: 'storage-limit' };
		}
		if (response.result === 'recovery-required') {
			return enterRecoveryRequired();
		}
		if (!receiptMatchesLineage(replica, response.receipt)) {
			return enterRecoveryRequired();
		}
		return null;
	}

	function readInstalledGuard(
		tableName: string,
		table: string,
		rowId: string,
	): number {
		return (
			sqlite.all<StoredGuard>(
				`SELECT installed_sequence FROM ${quoteIdentifier(tableName)}
				 WHERE table_key = ? AND row_id = ?`,
				[table, rowId],
			)[0]?.installed_sequence ?? 0
		);
	}

	function writeGuard(
		tableName: string,
		table: string,
		rowId: string,
		sequence: number,
	): void {
		sqlite.run(
			`INSERT INTO ${quoteIdentifier(tableName)}(
				table_key, row_id, installed_sequence
			) VALUES (?, ?, ?)
			ON CONFLICT(table_key, row_id) DO UPDATE SET
				installed_sequence = excluded.installed_sequence`,
			[table, rowId, sequence],
		);
	}

	type InstallTarget = {
		rows: string;
		guards: string;
	};

	const confirmedTarget: InstallTarget = {
		rows: TABLES.rows,
		guards: TABLES.guards,
	};
	const scratchTarget: InstallTarget = {
		rows: TABLES.scratchRows,
		guards: TABLES.scratchGuards,
	};

	function installEntries(
		target: InstallTarget,
		entries: readonly PullEntry[],
	): boolean {
		let changed = false;
		for (const entry of entries) {
			if (entry.kind !== 'deleted') continue;
			const guard = readInstalledGuard(target.guards, entry.table, entry.rowId);
			if (entry.deletedSequence < guard) continue;
			const existed = Boolean(
				sqlite.all<{ present: number }>(
					`SELECT 1 AS present FROM ${quoteIdentifier(target.rows)}
					 WHERE table_key = ? AND row_id = ?`,
					[entry.table, entry.rowId],
				)[0],
			);
			if (entry.deletedSequence === guard) {
				if (existed) {
					throw new Error(
						'One authority sequence cannot be both a row and a deletion',
					);
				}
				continue;
			}
			sqlite.run(
				`DELETE FROM ${quoteIdentifier(target.rows)}
				 WHERE table_key = ? AND row_id = ?`,
				[entry.table, entry.rowId],
			);
			writeGuard(
				target.guards,
				entry.table,
				entry.rowId,
				entry.deletedSequence,
			);
			if (existed || entry.deletedSequence > guard) {
				changed = true;
			}
		}

		for (const entry of entries) {
			if (entry.kind !== 'row') continue;
			const guard = readInstalledGuard(target.guards, entry.table, entry.rowId);
			if (entry.changedSequence < guard) continue;
			const fieldsJson = JSON.stringify(entry.fields);
			const before = sqlite.all<{ fields_json: string }>(
				`SELECT fields_json FROM ${quoteIdentifier(target.rows)}
				 WHERE table_key = ? AND row_id = ?`,
				[entry.table, entry.rowId],
			)[0];
			if (entry.changedSequence === guard) {
				if (
					before === undefined ||
					canonicalJson(JSON.parse(before.fields_json)) !==
						canonicalJson(entry.fields)
				) {
					throw new Error(
						'One authority sequence returned different current row state',
					);
				}
				continue;
			}
			sqlite.run(
				`INSERT INTO ${quoteIdentifier(target.rows)}(
					table_key, row_id, fields_json
				) VALUES (?, ?, ?)
				ON CONFLICT(table_key, row_id) DO UPDATE SET
					fields_json = excluded.fields_json`,
				[entry.table, entry.rowId, fieldsJson],
			);
			writeGuard(
				target.guards,
				entry.table,
				entry.rowId,
				entry.changedSequence,
			);
			if (
				guard !== entry.changedSequence ||
				before?.fields_json !== fieldsJson
			) {
				changed = true;
			}
		}
		return changed;
	}

	function installPullPage({
		after,
		through,
		response,
	}: {
		after: number;
		through: number;
		response: Extract<ReturnType<typeof parsePullResponse>, { result: 'page' }>;
	}): { changed: boolean; deleted: RowAddress[] } | 'recovery-required' {
		if (
			response.through !== through ||
			response.checkpoint < after ||
			response.checkpoint > through ||
			(response.checkpoint === after && after !== through)
		) {
			throw new Error('Pull page does not advance its fixed checkpoint');
		}
		return sqlite.transaction(() => {
			const replica = readReplica();
			if (!receiptMatchesLineage(replica, response.receipt)) {
				sqlite.run(
					`UPDATE "${TABLES.replica}" SET recovery_required = 1
					 WHERE id = 1`,
				);
				return 'recovery-required' as const;
			}
			if (replica.checkpoint > after) {
				return { changed: false, deleted: [] };
			}
			if (replica.checkpoint !== after) {
				throw new Error('Replica checkpoint changed before page installation');
			}
			const retiresSealedIntents =
				replica.sealed_digest !== null &&
				response.receipt.acceptedRound === replica.retired_round + 1 &&
				response.receipt.requestDigest === replica.sealed_digest &&
				response.checkpoint >= response.receipt.appliedThrough;
			const previouslyLive = readLiveAddresses([
				...response.entries.map(({ table, rowId }) => ({ table, rowId })),
				...(retiresSealedIntents
					? readStoredIntents(1).map(({ table_key, row_id }) => ({
							table: table_key,
							rowId: row_id,
						}))
					: []),
			]);
			const changed = installEntries(confirmedTarget, response.entries);
			sqlite.run(`UPDATE "${TABLES.replica}" SET checkpoint = ? WHERE id = 1`, [
				response.checkpoint,
			]);
			if (response.checkpoint === through && replica.acquired === 0) {
				sqlite.run(`UPDATE "${TABLES.replica}" SET acquired = 1 WHERE id = 1`);
			}
			if (retiresSealedIntents) {
				sqlite.run(`DELETE FROM "${TABLES.intents}" WHERE sealed = 1`);
				sqlite.run(
					`UPDATE "${TABLES.replica}" SET
						retired_round = ?, retired_digest = ?, retired_through = ?,
						sealed_digest = NULL
					 WHERE id = 1`,
					[
						response.receipt.acceptedRound,
						response.receipt.requestDigest,
						response.receipt.appliedThrough,
					],
				);
			}
			const deleted = rowsWhoseVisibleLifeEnded(previouslyLive);
			if (deleted.length > 0) documents?.deleteRows(deleted);
			return { changed, deleted };
		});
	}

	async function pullFixed(): Promise<
		CurrentStateReplicaSyncResult | 'acquisition-required' | null
	> {
		const initial = readReplica();
		let after = initial.checkpoint;
		let through: number | undefined;
		for (;;) {
			const response = parsePullResponse(
				await transport.pull({
					protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
					kind: 'pull',
					replicaId: initial.replica_id,
					after,
					...(through === undefined ? {} : { through }),
					...(pageLimit === ROW_SYNC_ADMISSION_LIMITS.pullEntriesPerPage
						? {}
						: { pageLimit }),
				}),
			);
			if (response.result === 'protocol-mismatch') {
				return { outcome: 'upgrade-required' };
			}
			if (response.result === 'recovery-required') {
				return enterRecoveryRequired();
			}
			if (response.result === 'acquisition-required') {
				const replica = readReplica();
				if (!receiptMatchesLineage(replica, response.receipt)) {
					return enterRecoveryRequired();
				}
				return 'acquisition-required';
			}
			through ??= response.through;
			const installed = installPullPage({ after, through, response });
			if (installed === 'recovery-required') {
				return { outcome: 'recovery-required', reason: 'lineage-mismatch' };
			}
			if (installed.changed) onRemoteCommit();
			if (installed.deleted.length > 0) onRowsDeleted(installed.deleted);
			after = response.checkpoint;
			if (after === through) return null;
		}
	}

	function createScratch(): void {
		dropScratch(sqlite);
		sqlite.run(`
			CREATE TABLE "${TABLES.scratchRows}" (
				table_key TEXT NOT NULL,
				row_id TEXT NOT NULL,
				fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
				PRIMARY KEY(table_key, row_id)
			) WITHOUT ROWID, STRICT
		`);
		sqlite.run(`
			CREATE TABLE "${TABLES.scratchGuards}" (
				table_key TEXT NOT NULL,
				row_id TEXT NOT NULL,
				installed_sequence INTEGER NOT NULL CHECK(installed_sequence > 0),
				PRIMARY KEY(table_key, row_id)
			) WITHOUT ROWID, STRICT
		`);
	}

	function installAcquiredRow(row: {
		table: string;
		rowId: string;
		fields: JsonObject;
		changedSequence: number;
	}): void {
		const guard = readInstalledGuard(
			TABLES.scratchGuards,
			row.table,
			row.rowId,
		);
		if (row.changedSequence < guard) return;
		sqlite.run(
			`INSERT INTO "${TABLES.scratchRows}"(
				table_key, row_id, fields_json
			) VALUES (?, ?, ?)
			ON CONFLICT(table_key, row_id) DO UPDATE SET
				fields_json = excluded.fields_json`,
			[row.table, row.rowId, JSON.stringify(row.fields)],
		);
		writeGuard(TABLES.scratchGuards, row.table, row.rowId, row.changedSequence);
	}

	async function acquireCompleteState(): Promise<CurrentStateReplicaSyncResult | null> {
		for (;;) {
			createScratch();
			const replica = readReplica();
			let afterAddress: RowAddress | undefined;
			let anchor: number | undefined;
			let target = 0;
			let floorRaced = false;
			for (;;) {
				const response = parseAcquireResponse(
					await transport.acquire({
						protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
						kind: 'acquire',
						replicaId: replica.replica_id,
						...(afterAddress === undefined ? {} : { afterAddress }),
						...(acquirePageLimit ===
						ROW_SYNC_ADMISSION_LIMITS.acquiredRowsPerPage
							? {}
							: { pageLimit: acquirePageLimit }),
					}),
				);
				if (response.result === 'protocol-mismatch') {
					dropScratch(sqlite);
					return { outcome: 'upgrade-required' };
				}
				if (response.result === 'recovery-required') {
					dropScratch(sqlite);
					return enterRecoveryRequired();
				}
				const current = readReplica();
				if (!receiptMatchesLineage(current, response.receipt)) {
					dropScratch(sqlite);
					return enterRecoveryRequired();
				}
				if (response.head < target) {
					throw new Error('Authority head regressed during acquisition');
				}
				let previousAddress = afterAddress;
				for (const row of response.rows) {
					if (
						previousAddress !== undefined &&
						(row.table < previousAddress.table ||
							(row.table === previousAddress.table &&
								row.rowId <= previousAddress.rowId))
					) {
						throw new Error('Acquisition rows are not in address order');
					}
					previousAddress = { table: row.table, rowId: row.rowId };
				}
				anchor ??= response.head;
				if (response.retentionFloor > anchor) {
					floorRaced = true;
					break;
				}
				sqlite.transaction(() => {
					for (const row of response.rows) installAcquiredRow(row);
				});
				const last = response.rows.at(-1);
				if (last) afterAddress = { table: last.table, rowId: last.rowId };
				target = response.head;
				if (!response.hasMore) break;
			}
			if (floorRaced) {
				dropScratch(sqlite);
				continue;
			}

			let cursor = anchor ?? 0;
			while (cursor < target) {
				const response = parsePullResponse(
					await transport.pull({
						protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
						kind: 'pull',
						replicaId: replica.replica_id,
						after: cursor,
						through: target,
						...(pageLimit === ROW_SYNC_ADMISSION_LIMITS.pullEntriesPerPage
							? {}
							: { pageLimit }),
					}),
				);
				if (response.result === 'protocol-mismatch') {
					dropScratch(sqlite);
					return { outcome: 'upgrade-required' };
				}
				if (response.result === 'recovery-required') {
					dropScratch(sqlite);
					return enterRecoveryRequired();
				}
				if (response.result === 'acquisition-required') {
					floorRaced = true;
					break;
				}
				if (response.through !== target || response.checkpoint <= cursor) {
					throw new Error('Acquisition catch-up page did not advance');
				}
				const current = readReplica();
				if (!receiptMatchesLineage(current, response.receipt)) {
					dropScratch(sqlite);
					return enterRecoveryRequired();
				}
				sqlite.transaction(() => {
					installEntries(scratchTarget, response.entries);
				});
				cursor = response.checkpoint;
			}
			if (floorRaced) {
				dropScratch(sqlite);
				continue;
			}

			const deleted = sqlite.transaction(() => {
				const current = readReplica();
				if (
					current.replica_id !== replica.replica_id ||
					current.checkpoint !== replica.checkpoint ||
					current.recovery_required === 1
				) {
					throw new Error('Replica lifecycle changed during acquisition');
				}
				const removed = sqlite.all<RowAddress>(
					`SELECT confirmed.table_key AS "table", confirmed.row_id AS "rowId"
					 FROM "${TABLES.rows}" AS confirmed
					 WHERE NOT EXISTS (
						SELECT 1 FROM "${TABLES.scratchRows}" AS acquired
						 WHERE acquired.table_key = confirmed.table_key
						   AND acquired.row_id = confirmed.row_id
					 )
					 ORDER BY confirmed.table_key, confirmed.row_id`,
				);
				const previouslyLive = readLiveAddresses(removed);
				sqlite.run(`DELETE FROM "${TABLES.rows}"`);
				sqlite.run(
					`INSERT INTO "${TABLES.rows}"(table_key, row_id, fields_json)
					 SELECT table_key, row_id, fields_json
					 FROM "${TABLES.scratchRows}"`,
				);
				sqlite.run(`DELETE FROM "${TABLES.guards}"`);
				sqlite.run(
					`INSERT INTO "${TABLES.guards}"(
						table_key, row_id, installed_sequence
					)
					SELECT table_key, row_id, installed_sequence
					FROM "${TABLES.scratchGuards}"`,
				);
				sqlite.run(
					`UPDATE "${TABLES.replica}" SET checkpoint = ?, acquired = 1
					 WHERE id = 1`,
					[cursor],
				);
				dropScratch(sqlite);
				const visiblyDeleted = rowsWhoseVisibleLifeEnded(previouslyLive);
				if (visiblyDeleted.length > 0) {
					documents?.deleteRows(visiblyDeleted);
				}
				return visiblyDeleted;
			});
			if (deleted.length > 0) onRowsDeleted(deleted);
			onAcquisitionPromoted();
			onRemoteCommit();
			return null;
		}
	}

	function status(): CurrentStateReplicaStatus {
		const replica = readReplica();
		const counts = sqlite.all<{ count: number; sealed: number }>(
			`SELECT sealed, COUNT(*) AS count FROM "${TABLES.intents}"
			 GROUP BY sealed`,
		);
		const pendingIntents = counts.reduce((sum, row) => sum + row.count, 0);
		return {
			checkpoint: replica.checkpoint,
			admissionHead: replica.admission_head,
			pendingIntents,
			hasSealed: replica.sealed_digest !== null,
			isAcquired: replica.acquired === 1,
			isRecoveryRequired: replica.recovery_required === 1,
		};
	}

	function captureVisible(): LogicalWorkspaceCopy {
		const addresses = sqlite.all<RowAddress>(
			`SELECT table_key AS "table", row_id AS "rowId" FROM "${TABLES.rows}"
			 UNION
			 SELECT table_key AS "table", row_id AS "rowId" FROM "${TABLES.intents}"
			 ORDER BY "table", "rowId"`,
		);
		return captureLogicalWorkspace({
			addresses,
			readCurrentRow,
			...(documents
				? {
						captureDocument: (address: RowAddress) =>
							documents.capture(address),
					}
				: {}),
		});
	}

	function captureRecovery(): LogicalWorkspaceCopy | null {
		if (readReplica().recovery_required !== 1) return null;
		return captureVisible();
	}

	function startFreshLineage(): void {
		if (readReplica().recovery_required !== 1) {
			throw new Error('A fresh lineage requires a recovery safety halt');
		}
		const visibleAddresses = sqlite.all<RowAddress>(
			`SELECT table_key AS "table", row_id AS "rowId" FROM "${TABLES.rows}"
			 UNION
			 SELECT table_key AS "table", row_id AS "rowId" FROM "${TABLES.intents}"`,
		);
		// The fresh lineage starts empty, and conforming runtimes never reuse a
		// row address across lifetimes (ADR-0145), so every local document log
		// is dead weight after the reset. Unsynchronized document edits survive
		// only through the explicit captureRecovery copy taken before this call.
		resetCurrentStateReplicaSchema(sqlite, () => documents?.deleteAllRows());
		onRowsDeleted(visibleAddresses);
		onRemoteCommit();
	}

	function admitInTransaction(admitted: CurrentStateWireRowIntent): void {
		const replica = readReplica();
		const sealed = readAddressIntent(admitted.table, admitted.rowId, 1);
		if (sealed?.kind === 'delete') {
			throw new Error('A locally deleted row accepts no further intent');
		}
		if (
			admitted.kind === 'create' &&
			readCurrentRow(admitted.table, admitted.rowId) !== undefined
		) {
			return;
		}
		const changed = intentChangesProjection(admitted);
		if (!changed) return;
		const address = { table: admitted.table, rowId: admitted.rowId };
		const wasLive = readCurrentRow(address.table, address.rowId) !== undefined;
		const sequence = replica.admission_head + 1;
		compactIntoOpen(admitted, sequence);
		// Intent compaction can reveal confirmed state below an open create. Only
		// the actual visible-live to absent transition ends the document lifetime.
		if (wasLive && readCurrentRow(address.table, address.rowId) === undefined) {
			documents?.deleteRows([address]);
		}
		sqlite.run(
			`UPDATE "${TABLES.replica}" SET admission_head = ? WHERE id = 1`,
			[sequence],
		);
	}

	function admit(intent: CurrentStateWireRowIntent): void {
		const admitted = prepareLocalIntent(intent);
		sqlite.transaction(() => admitInTransaction(admitted));
	}

	function admitMany(intents: readonly CurrentStateWireRowIntent[]): void {
		const admitted = intents.map(prepareLocalIntent);
		sqlite.transaction(() => {
			for (const intent of admitted) admitInTransaction(intent);
		});
	}

	async function runCycle(
		maxBirthSequence?: number,
	): Promise<CurrentStateReplicaSyncResult> {
		if (readReplica().recovery_required === 1) {
			return { outcome: 'recovery-required', reason: 'lineage-mismatch' };
		}
		const pushed = await pushSealedIfNeeded(maxBirthSequence);
		if (pushed) return pushed;
		const pulled = await pullFixed();
		if (pulled === 'acquisition-required') {
			const acquired = await acquireCompleteState();
			if (acquired) return acquired;
		} else if (pulled) {
			return pulled;
		}
		return status().pendingIntents === 0
			? { outcome: 'caught-up' }
			: { outcome: 'progress' };
	}

	function runExclusive<TResult>(
		run: () => Promise<TResult>,
	): Promise<TResult> {
		const result = synchronizationTail.then(run, run);
		synchronizationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	return {
		/**
		 * Admit and compact one desired local effect. Only a changed visible
		 * projection advances the local watermark. Same-address compaction keeps
		 * the first intent's birth sequence.
		 */
		admit,

		/** Admit one logical transfer atomically before its source may be deleted. */
		admitMany,

		captureAdmissionCut(): number {
			return readReplica().admission_head;
		},

		readCurrentRow,

		status,
		isReady(): boolean {
			return readReplica().acquired === 1;
		},

		/** Discard ambiguous private sync state and mint one empty fresh lineage. */
		startFreshLineage,

		/** Capture visible user content (confirmed rows plus intent overlays). */
		captureVisible,

		/** Capture visible user content after a lineage halt, never protocol state. */
		captureRecovery,

		/** Run at most one outgoing round and one fixed incoming interval. */
		synchronizeOnce(): Promise<CurrentStateReplicaSyncResult> {
			return runExclusive(() => runCycle());
		},

		/**
		 * Settle only intents born at or before `cut`. A fixed pull starts after
		 * every required push, so later admissions cannot extend this call.
		 */
		synchronizeThrough(cut: number): Promise<CurrentStateReplicaSyncResult> {
			if (!Number.isSafeInteger(cut) || cut < 0) {
				throw new TypeError('Admission cut must be a non-negative integer');
			}
			return runExclusive(async () => {
				const result = await runCycle(cut);
				if (result.outcome === 'recovery-required') return result;
				if (!sealedBirthAtOrBefore(cut) && !openBirthAtOrBefore(cut)) {
					return { outcome: 'caught-up' };
				}
				return { outcome: 'progress' };
			});
		},
	};
}

export type CurrentStateReplica = ReturnType<typeof createCurrentStateReplica>;
