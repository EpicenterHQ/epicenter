/**
 * The V1 replica's durable scalar store (ADR-0163).
 *
 * Everything here is synchronous and storage-only: it reads and writes the
 * relations in `v1-schema.ts` and owns no transport, scheduling, or retry. The
 * two synchronization loops in `v1-replica.ts` compose these operations inside
 * their own transactions, which is what lets "install a page and advance the
 * watermark" be one commit without this module knowing what a page is.
 *
 * The convergence law itself is not reimplemented here. Visible state is the
 * kernel's `foldIntent` applied over the confirmed fact, so tombstone dominance,
 * idempotent patches, and reversible value unsets are inherited rather than
 * restated in SQL.
 */
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

import {
	type Address,
	addressKey,
	type Fact,
	foldIntent,
	type Intent,
	type JsonObject,
	type JsonValue,
	type ParkedIntent,
	type RowAddress,
	type ValueAddress,
} from '../protocol/v1/index.js';

/**
 * The lifecycle of one address's local work.
 *
 * `pending` may seal and may compact with a later write. `sealed` belongs to the
 * one in-flight numbered submission and is immutable, because an exact retry
 * must resend the same semantic intents. `parked` was refused by the authority
 * for this address alone; it stays a visible overlay but does not retry until a
 * later local write makes it pending again (ADR-0163).
 */
export type IntentState = 'pending' | 'sealed' | 'parked';

export type ReplicaV1Metadata = {
	formatVersion: number;
	replicaId: string;
	attachment: { deploymentId: string; principalId: string } | undefined;
	authorityLifetime: string | undefined;
	afterSequence: number;
	lastSubmissionNumber: number;
	sealedSubmissionNumber: number | undefined;
};

type MetadataRow = SqliteRow & {
	format_version: number;
	replica_id: string;
	attached_deployment: string | null;
	attached_principal: string | null;
	authority_lifetime: string | null;
	after_sequence: number;
	last_submission_number: number;
	sealed_submission_number: number | null;
};

type RowFactRow = SqliteRow & {
	presence: 'present' | 'absent';
	fields: string | null;
	authority_sequence: number;
};

type ValueFactRow = SqliteRow & {
	presence: 'present' | 'absent';
	content: string | null;
	authority_sequence: number;
};

type IntentRow = SqliteRow & {
	local_sequence: number;
	state: IntentState;
	intent_kind: 'row' | 'value';
	namespace: string;
	local_key: string;
	row_id: string | null;
	presence: 'present' | 'absent';
	set_fields: string | null;
	unset_keys: string | null;
	content: string | null;
};

export function readMetadata(database: SqliteDatabase): ReplicaV1Metadata {
	const row = database.all<MetadataRow>(
		`SELECT format_version, replica_id, attached_deployment, attached_principal,
			authority_lifetime, after_sequence, last_submission_number,
			sealed_submission_number
		FROM main._replica_v1_metadata WHERE singleton = 1`,
	)[0];
	if (row === undefined)
		throw new Error('Replica metadata singleton is missing');
	return {
		formatVersion: row.format_version,
		replicaId: row.replica_id,
		attachment:
			row.attached_deployment === null || row.attached_principal === null
				? undefined
				: {
						deploymentId: row.attached_deployment,
						principalId: row.attached_principal,
					},
		authorityLifetime: row.authority_lifetime ?? undefined,
		afterSequence: row.after_sequence,
		lastSubmissionNumber: row.last_submission_number,
		sealedSubmissionNumber: row.sealed_submission_number ?? undefined,
	};
}

// ---------------------------------------------------------------------------
// Confirmed authority facts
// ---------------------------------------------------------------------------

/**
 * The confirmed authority fact at an address, or `undefined` when the replica
 * has learned nothing there.
 *
 * This is authority truth only. Local work lives in the intent relations and is
 * never written here, which is what lets a fact be installed beneath pending
 * work instead of being skipped.
 */
export function readConfirmedFact(
	database: SqliteDatabase,
	address: Address,
): Fact | undefined {
	if (address.kind === 'row') {
		const row = database.all<RowFactRow>(
			`SELECT presence, fields, authority_sequence
			FROM main._replica_v1_row_facts
			WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[address.namespace, address.tableName, address.rowId],
		)[0];
		if (row === undefined) return undefined;
		return row.presence === 'absent'
			? { address, sequence: row.authority_sequence, presence: 'absent' }
			: {
					address,
					sequence: row.authority_sequence,
					presence: 'present',
					fields: JSON.parse(row.fields ?? 'null') as JsonObject,
				};
	}
	const row = database.all<ValueFactRow>(
		`SELECT presence, content, authority_sequence
		FROM main._replica_v1_value_facts WHERE namespace = ? AND value_name = ?`,
		[address.namespace, address.valueName],
	)[0];
	if (row === undefined) return undefined;
	return row.presence === 'absent'
		? { address, sequence: row.authority_sequence, presence: 'absent' }
		: {
				address,
				sequence: row.authority_sequence,
				presence: 'present',
				content: JSON.parse(row.content ?? 'null') as JsonValue,
			};
}

function writeConfirmedFact(database: SqliteDatabase, fact: Fact): void {
	if (fact.address.kind === 'row') {
		const { namespace, tableName, rowId } = fact.address;
		database.run(
			`INSERT INTO main._replica_v1_row_facts (
				namespace, table_name, row_id, presence, fields, authority_sequence
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (namespace, table_name, row_id) DO UPDATE SET
				presence = excluded.presence,
				fields = excluded.fields,
				authority_sequence = excluded.authority_sequence`,
			[
				namespace,
				tableName,
				rowId,
				fact.presence,
				'fields' in fact ? JSON.stringify(fact.fields) : null,
				fact.sequence,
			],
		);
		return;
	}
	const { namespace, valueName } = fact.address;
	database.run(
		`INSERT INTO main._replica_v1_value_facts (
			namespace, value_name, presence, content, authority_sequence
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (namespace, value_name) DO UPDATE SET
			presence = excluded.presence,
			content = excluded.content,
			authority_sequence = excluded.authority_sequence`,
		[
			namespace,
			valueName,
			fact.presence,
			'content' in fact ? JSON.stringify(fact.content) : null,
			fact.sequence,
		],
	);
}

// ---------------------------------------------------------------------------
// Local intents
// ---------------------------------------------------------------------------

/**
 * One local-sequence-ordered view over both intent relations.
 *
 * The relations keep their own shapes, so the union projects each onto the
 * shared columns: `local_key` carries the table or value name, and `row_id` is
 * NULL for a value intent rather than an empty-string sentinel.
 */
const INTENTS_QUERY = `
	SELECT local_sequence, state, 'row' AS intent_kind, namespace,
		table_name AS local_key, row_id, presence, set_fields, unset_keys,
		NULL AS content
	FROM main._replica_v1_row_intents
	UNION ALL
	SELECT local_sequence, state, 'value' AS intent_kind, namespace,
		value_name AS local_key, NULL AS row_id, presence, NULL AS set_fields,
		NULL AS unset_keys, content
	FROM main._replica_v1_value_intents`;

function intentRowToIntent(row: IntentRow): Intent {
	if (row.intent_kind === 'row') {
		if (row.row_id === null) {
			// `row_intents.row_id` is NOT NULL, so this is unreachable unless the
			// union projection above is edited wrongly. Refuse rather than coerce to
			// an empty string: that sentinel is exactly what split relations exist to
			// make unrepresentable.
			throw new Error('A local row intent is missing its row id');
		}
		const address: RowAddress = {
			kind: 'row',
			namespace: row.namespace,
			tableName: row.local_key,
			rowId: row.row_id,
		};
		return row.presence === 'absent'
			? { address, presence: 'absent' }
			: {
					address,
					presence: 'present',
					set: JSON.parse(row.set_fields ?? 'null') as JsonObject,
					unset: JSON.parse(row.unset_keys ?? 'null') as string[],
				};
	}
	const address: ValueAddress = {
		kind: 'value',
		namespace: row.namespace,
		valueName: row.local_key,
	};
	return row.presence === 'absent'
		? { address, presence: 'absent' }
		: {
				address,
				presence: 'present',
				content: JSON.parse(row.content ?? 'null') as JsonValue,
			};
}

export type StoredIntent = {
	localSequence: number;
	state: IntentState;
	intent: Intent;
};

function toStoredIntent(row: IntentRow): StoredIntent {
	return {
		localSequence: row.local_sequence,
		state: row.state,
		intent: intentRowToIntent(row),
	};
}

/** Every local intent at one address, oldest first. */
export function readIntentsAt(
	database: SqliteDatabase,
	address: Address,
): StoredIntent[] {
	const rows =
		address.kind === 'row'
			? database.all<IntentRow>(
					`SELECT * FROM (${INTENTS_QUERY})
					WHERE intent_kind = 'row' AND namespace = ? AND local_key = ?
						AND row_id = ?
					ORDER BY local_sequence`,
					[address.namespace, address.tableName, address.rowId],
				)
			: database.all<IntentRow>(
					`SELECT * FROM (${INTENTS_QUERY})
					WHERE intent_kind = 'value' AND namespace = ? AND local_key = ?
					ORDER BY local_sequence`,
					[address.namespace, address.valueName],
				);
	return rows.map(toStoredIntent);
}

/** Every local intent in one state, oldest first. */
export function readIntentsInState(
	database: SqliteDatabase,
	state: IntentState,
	limit: number,
): StoredIntent[] {
	return database
		.all<IntentRow>(
			`SELECT * FROM (${INTENTS_QUERY}) WHERE state = ?
			ORDER BY local_sequence LIMIT ?`,
			[state, limit],
		)
		.map(toStoredIntent);
}

function deleteIntentAt(
	database: SqliteDatabase,
	address: Address,
	state: IntentState,
): void {
	if (address.kind === 'row') {
		database.run(
			`DELETE FROM main._replica_v1_row_intents
			WHERE namespace = ? AND table_name = ? AND row_id = ? AND state = ?`,
			[address.namespace, address.tableName, address.rowId, state],
		);
		return;
	}
	database.run(
		`DELETE FROM main._replica_v1_value_intents
		WHERE namespace = ? AND value_name = ? AND state = ?`,
		[address.namespace, address.valueName, state],
	);
}

/**
 * Remove one intent by its local sequence.
 *
 * The sequence space is shared across both relations and unique within it, so a
 * delete from each is one row total. That is what lets the sealer and the
 * settlement path move an intent between states without knowing its kind.
 */
export function deleteIntentBySequence(
	database: SqliteDatabase,
	localSequence: number,
): void {
	database.run(
		'DELETE FROM main._replica_v1_row_intents WHERE local_sequence = ?',
		[localSequence],
	);
	database.run(
		'DELETE FROM main._replica_v1_value_intents WHERE local_sequence = ?',
		[localSequence],
	);
}

function insertIntent(
	database: SqliteDatabase,
	localSequence: number,
	state: IntentState,
	intent: Intent,
): void {
	if (intent.address.kind === 'row') {
		const { namespace, tableName, rowId } = intent.address;
		database.run(
			`INSERT INTO main._replica_v1_row_intents (
				local_sequence, state, namespace, table_name, row_id, presence,
				set_fields, unset_keys
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				localSequence,
				state,
				namespace,
				tableName,
				rowId,
				intent.presence,
				intent.presence === 'present' && 'set' in intent
					? JSON.stringify(intent.set)
					: null,
				intent.presence === 'present' && 'set' in intent
					? JSON.stringify(intent.unset)
					: null,
			],
		);
		return;
	}
	const { namespace, valueName } = intent.address;
	database.run(
		`INSERT INTO main._replica_v1_value_intents (
			local_sequence, state, namespace, value_name, presence, content
		) VALUES (?, ?, ?, ?, ?, ?)`,
		[
			localSequence,
			state,
			namespace,
			valueName,
			intent.presence,
			intent.presence === 'present' && 'content' in intent
				? JSON.stringify(intent.content)
				: null,
		],
	);
}

/**
 * Compose two intents at the same address into one with the same effect.
 *
 * This is what keeps at most one compactable intent per address, so sealing
 * never has to reconcile a queue of overlapping writes at one address.
 *
 * The row-present case is the only one that merges rather than replaces. Both
 * intents are applied as "set, then unset" over some base, so the composition
 * is: later values win, a later unset removes an earlier set, and a later set
 * revives an earlier unset. `set` and `unset` stay disjoint on both sides, which
 * `isAdmissibleIntent` also requires.
 */
export function composeIntents(older: Intent, newer: Intent): Intent {
	// An absent intent discards whatever local work preceded it: a row delete
	// installs a terminal tombstone, and a value unset replaces the value.
	if (newer.presence === 'absent') return newer;

	// A row-present patch after a local row delete is superseded, exactly as the
	// authority would settle it: the tombstone is terminal and does not resurrect.
	if (older.presence === 'absent' && older.address.kind === 'row') return older;

	if ('content' in newer) return newer;
	if (!('set' in newer)) return newer;

	const olderSet =
		older.presence === 'present' && 'set' in older ? older.set : {};
	const olderUnset =
		older.presence === 'present' && 'set' in older ? older.unset : [];

	const newerUnset = new Set(newer.unset);
	const newerSetKeys = new Set(Object.keys(newer.set));

	const set: JsonObject = {};
	for (const [key, value] of Object.entries(olderSet)) {
		if (!newerUnset.has(key)) set[key] = structuredClone(value);
	}
	for (const [key, value] of Object.entries(newer.set)) {
		set[key] = structuredClone(value);
	}

	const unset: string[] = [];
	for (const key of [...olderUnset, ...newer.unset]) {
		if (!newerSetKeys.has(key) && !unset.includes(key)) unset.push(key);
	}

	return { address: newer.address, presence: 'present', set, unset };
}

// ---------------------------------------------------------------------------
// Visible state
// ---------------------------------------------------------------------------

/**
 * The replica's visible state at one address.
 *
 * ADR-0163's identity, computed rather than stored:
 *
 *     confirmed authority facts
 *     + compacted pending local intents
 *     = visible local state
 *
 * The fold is the kernel's, so every law comes with it: a confirmed terminal row
 * tombstone dominates every local row intent without resurrecting the row, a
 * value unset stays reversible, and an idempotent patch changes nothing. The
 * sequence passed to the fold is irrelevant because only the payload is read
 * back; a local overlay has no authority sequence and never claims one.
 */
export function readVisibleFact(
	database: SqliteDatabase,
	address: Address,
): Fact | undefined {
	let current = readConfirmedFact(database, address);
	for (const stored of readIntentsAt(database, address)) {
		const outcome = foldIntent(current, stored.intent, 1);
		if (outcome.kind === 'changed') current = outcome.fact;
	}
	return current;
}

/**
 * Recompute the materialized visible projection at one address.
 *
 * Called after every mutation of a fact or an intent, and only ever from
 * inside the caller's transaction, so the projection commits with the change
 * that caused it and can never be observed disagreeing with the fold.
 *
 * Deliberately recomputed from `readVisibleFact` rather than patched
 * incrementally: the projection is derived state, and deriving it the one way
 * it is defined means a new fold rule cannot leave a stale incremental update
 * path behind that quietly disagrees.
 */
export function refreshVisible(
	database: SqliteDatabase,
	address: Address,
): void {
	const visible = readVisibleFact(database, address);
	if (address.kind === 'row') {
		const { namespace, tableName, rowId } = address;
		if (visible === undefined) {
			database.run(
				`DELETE FROM main._replica_v1_visible_rows
				WHERE namespace = ? AND table_name = ? AND row_id = ?`,
				[namespace, tableName, rowId],
			);
			return;
		}
		database.run(
			`INSERT INTO main._replica_v1_visible_rows (
				namespace, table_name, row_id, presence, fields
			) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (namespace, table_name, row_id) DO UPDATE SET
				presence = excluded.presence,
				fields = excluded.fields`,
			[
				namespace,
				tableName,
				rowId,
				visible.presence,
				'fields' in visible ? JSON.stringify(visible.fields) : null,
			],
		);
		return;
	}
	const { namespace, valueName } = address;
	if (visible === undefined) {
		database.run(
			`DELETE FROM main._replica_v1_visible_values
			WHERE namespace = ? AND value_name = ?`,
			[namespace, valueName],
		);
		return;
	}
	database.run(
		`INSERT INTO main._replica_v1_visible_values (
			namespace, value_name, presence, content
		) VALUES (?, ?, ?, ?)
		ON CONFLICT (namespace, value_name) DO UPDATE SET
			presence = excluded.presence,
			content = excluded.content`,
		[
			namespace,
			valueName,
			visible.presence,
			'content' in visible ? JSON.stringify(visible.content) : null,
		],
	);
}

// ---------------------------------------------------------------------------
// Parked diagnostics
// ---------------------------------------------------------------------------

type ParkedRow = SqliteRow & {
	namespace: string;
	table_name: string;
	row_id: string;
	code: 'fact-too-large';
	measured_bytes: number;
	limit_bytes: number;
};

export function readParked(database: SqliteDatabase): ParkedIntent[] {
	return database
		.all<ParkedRow>(
			`SELECT namespace, table_name, row_id, code, measured_bytes, limit_bytes
			FROM main._replica_v1_parked`,
		)
		.map((row) => ({
			address: {
				kind: 'row' as const,
				namespace: row.namespace,
				tableName: row.table_name,
				rowId: row.row_id,
			},
			code: row.code,
			measuredBytes: row.measured_bytes,
			limitBytes: row.limit_bytes,
		}));
}

function writeParked(database: SqliteDatabase, parked: ParkedIntent): void {
	database.run(
		`INSERT INTO main._replica_v1_parked (
			namespace, table_name, row_id, code, measured_bytes, limit_bytes
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (namespace, table_name, row_id) DO UPDATE SET
			code = excluded.code,
			measured_bytes = excluded.measured_bytes,
			limit_bytes = excluded.limit_bytes`,
		[
			parked.address.namespace,
			parked.address.tableName,
			parked.address.rowId,
			parked.code,
			parked.measuredBytes,
			parked.limitBytes,
		],
	);
}

function clearParked(database: SqliteDatabase, address: Address): void {
	if (address.kind !== 'row') return;
	database.run(
		`DELETE FROM main._replica_v1_parked
		WHERE namespace = ? AND table_name = ? AND row_id = ?`,
		[address.namespace, address.tableName, address.rowId],
	);
}

// ---------------------------------------------------------------------------
// The two mutating operations the loops compose
// ---------------------------------------------------------------------------

/**
 * Apply one local intent optimistically and queue it for the authority.
 *
 * Returns whether anything changed. An intent that folds to nothing over
 * current visible state (an idempotent patch, or any row write beneath a
 * confirmed terminal tombstone) is not queued: it would burn a submission
 * number and wake subscribers to say nothing happened.
 *
 * A `sealed` intent at this address is immutable, so new work becomes a
 * separate `pending` intent beside it. Otherwise the write compacts into
 * whatever compactable intent is already there, and compacting into `parked`
 * work clears its diagnostic and makes it eligible to seal again (ADR-0163).
 */
export function applyLocalWrite(
	database: SqliteDatabase,
	intent: Intent,
	nextLocalSequence: number,
): { applied: boolean } {
	const visible = readVisibleFact(database, intent.address);
	if (foldIntent(visible, intent, 1).kind === 'unchanged') {
		return { applied: false };
	}

	const existing = readIntentsAt(database, intent.address);
	const compactable = existing.find((stored) => stored.state !== 'sealed');

	if (compactable === undefined) {
		insertIntent(database, nextLocalSequence, 'pending', intent);
		refreshVisible(database, intent.address);
		return { applied: true };
	}

	const composed = composeIntents(compactable.intent, intent);
	// Rewritten rather than updated in place so the composed intent takes the new
	// local sequence: it is newer work and must fold after anything sealed.
	deleteIntentAt(database, intent.address, compactable.state);
	clearParked(database, intent.address);
	insertIntent(database, nextLocalSequence, 'pending', composed);
	refreshVisible(database, intent.address);
	return { applied: true };
}

/**
 * What installing one learned fact did.
 *
 * Three outcomes, not two booleans, because the two "did not install" cases
 * need opposite handling and a shared flag made them look alike. `stale` is an
 * older fact arriving after a newer one, which ADR-0163 requires be ignored
 * silently: a delayed submission response routinely carries a fact the facts
 * feed has already moved past. `conflict` is the same sequence carrying
 * different content, which is corruption and must be reported. Reporting a
 * delayed response as corruption would erase a healthy replica.
 */
export type InstallOutcome = 'installed' | 'unchanged' | 'stale' | 'conflict';

/**
 * Install one learned authority fact beneath whatever local work exists.
 *
 * Monotonic per address: a higher sequence replaces the confirmed fact, a lower
 * one is ignored, and an equal sequence must be semantically identical or the
 * caller is looking at corruption. Returns whether the confirmed fact changed,
 * which is what the loops turn into change notifications.
 *
 * Crucially this never consults local work before storing. The layout this
 * replaces stored one merged row per address and therefore skipped any fact
 * whose address had pending work, which silently dropped authority truth and,
 * worst of all, could drop a terminal tombstone the replica must obey.
 *
 * A confirmed terminal row tombstone does dominate afterwards: it retires every
 * unsealed row intent at that address as superseded and discards any parked
 * overlay and diagnostic. A `sealed` intent survives, because the in-flight
 * submission must stay byte-identical for exact retry, but it stops overlaying
 * the tombstone because the kernel fold refuses to resurrect a row.
 */
export function installConfirmedFact(
	database: SqliteDatabase,
	fact: Fact,
): InstallOutcome {
	const existing = readConfirmedFact(database, fact.address);
	if (existing !== undefined) {
		if (existing.sequence > fact.sequence) return 'stale';
		if (existing.sequence === fact.sequence) {
			return factsAreIdentical(existing, fact) ? 'unchanged' : 'conflict';
		}
	}

	writeConfirmedFact(database, fact);

	if (fact.address.kind === 'row' && fact.presence === 'absent') {
		// Scalar death, document death, and obligation death commit together: a
		// deleted row can never leave orphaned bytes or a dirty publication that
		// would republish content for a dead address (ADR-0174).
		const { namespace, tableName, rowId } = fact.address;
		database.run(
			'DELETE FROM document_updates WHERE namespace = ? AND table_name = ? AND row_id = ?',
			[namespace, tableName, rowId],
		);
		database.run(
			'DELETE FROM document_publication WHERE namespace = ? AND table_name = ? AND row_id = ?',
			[namespace, tableName, rowId],
		);
		deleteIntentAt(database, fact.address, 'pending');
		deleteIntentAt(database, fact.address, 'parked');
		clearParked(database, fact.address);
	}

	refreshVisible(database, fact.address);
	return 'installed';
}

function factsAreIdentical(left: Fact, right: Fact): boolean {
	if (left.presence !== right.presence) return false;
	if ('fields' in left) {
		return (
			'fields' in right &&
			JSON.stringify(left.fields) === JSON.stringify(right.fields)
		);
	}
	if ('content' in left) {
		return (
			'content' in right &&
			JSON.stringify(left.content) === JSON.stringify(right.content)
		);
	}
	return !('fields' in right) && !('content' in right);
}

/** Record one address-scoped authority refusal beside its retained intent. */
export function parkIntent(
	database: SqliteDatabase,
	parked: ParkedIntent,
	sealedIntent: Intent,
	nextLocalSequence: number,
): void {
	const address = parked.address;
	const existing = readIntentsAt(database, address);
	const newer = existing.find((stored) => stored.state === 'pending');

	if (newer !== undefined) {
		// A later local write already superseded this work. ADR-0163 has the newer
		// write compact with the parked work rather than discard it, so the retained
		// intent folds first and the diagnostic goes away with it.
		const composed = composeIntents(sealedIntent, newer.intent);
		deleteIntentAt(database, address, 'pending');
		insertIntent(database, nextLocalSequence, 'pending', composed);
		clearParked(database, address);
		refreshVisible(database, address);
		return;
	}

	insertIntent(database, nextLocalSequence, 'parked', sealedIntent);
	writeParked(database, parked);
	refreshVisible(database, address);
}

export type { Address, Fact, Intent, ParkedIntent };
export {
	addressKey,
	deleteIntentAt as deleteIntent,
	insertIntent,
	writeConfirmedFact,
};

/** One page of visible rows in a table, ordered by row id. */
export type VisibleRowPage = {
	rows: { rowId: string; fields: JsonObject }[];
	hasNext: boolean;
};

/**
 * Page the visible rows of one logical table.
 *
 * A table scan has to show what the application can see, which is the fold of
 * confirmed facts with local intents, not the confirmed facts alone. Reading
 * only the fact relation would hide a row the user just created until it
 * settled with the authority, and would keep showing a row they just deleted:
 * local-first reads would lag the network, which is the opposite of the promise.
 *
 * So candidates come from both relations and each is folded through
 * `readVisibleFact`. Candidates that fold to absent are skipped without
 * consuming page capacity, and the scan keeps walking in bounded steps until
 * the page is full or the table is exhausted, so a run of locally deleted rows
 * cannot end a page early and strand the rest behind a cursor.
 */
export function readVisibleRowPage(
	database: SqliteDatabase,
	namespace: string,
	tableName: string,
	limit: number,
	after: string | undefined,
): VisibleRowPage {
	const rows = database.all<SqliteRow & { row_id: string; fields: string }>(
		`SELECT row_id, fields FROM main._replica_v1_visible_rows
		WHERE namespace = ? AND table_name = ? AND presence = 'present'
		${after === undefined ? '' : 'AND row_id > ?'}
		ORDER BY row_id ASC LIMIT ?`,
		after === undefined
			? [namespace, tableName, limit + 1]
			: [namespace, tableName, after, limit + 1],
	);
	const hasNext = rows.length > limit;
	return {
		rows: (hasNext ? rows.slice(0, limit) : rows).map((row) => ({
			rowId: row.row_id,
			fields: JSON.parse(row.fields) as JsonObject,
		})),
		hasNext,
	};
}
