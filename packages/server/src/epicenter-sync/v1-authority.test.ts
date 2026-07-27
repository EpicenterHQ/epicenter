/**
 * Epicenter Sync SQLite V1 Authority Tests
 *
 * Verifies that the SQLite authority realizes the scalar V1 reference model,
 * including byte paging, numbered exact retries, terminal row tombstones,
 * reversible value unsets, parked row patches, and document cleanup.
 *
 * Key behaviors:
 * - Fact reads return one sequence-ordered, byte-bounded current-state feed
 * - Submission retries are idempotent while forks and gaps are typed refusals
 * - Row tombstones dominate later patches and remove owned document state
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	type Intent,
	parseFactsResponse,
	parseSubmissionResponse,
	type RowAddress,
	type ScalarSyncLimits,
	type SubmissionRequest,
	type ValidatedLimits,
	type ValueAddress,
	validateLimits,
} from '@epicenter/data/protocol/v1';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type EpicenterSyncV1Authority,
	openEpicenterSyncV1Authority,
} from './v1-authority.js';

/**
 * Test ceilings, built through the real mandatory validator.
 *
 * Deliberately local rather than imported from the kernel's own fixtures: those
 * are test-only and excluded from the published package, so reaching them would
 * mean crossing the package boundary by relative path. The numbers are small so
 * a test can force paging and parking without constructing megabyte payloads.
 */
const BASE_LIMITS: ScalarSyncLimits = {
	jsonDepth: 16,
	propertiesPerObject: 1024,
	maxNamespaceBytes: 128,
	maxTableKeyBytes: 64,
	maxValueKeyBytes: 64,
	maxLifetimeBytes: 64,
	maxFieldKeyBytes: 128,
	maxUnsetKeysPerIntent: 64,
	maxEncodedFactBytes: 4096,
	maxFactsResponseBytes: 262144,
	maxSubmissionBytes: 262144,
	maxSubmissionResponseBytes: 1048576,
	maxSubmissionAddresses: 64,
};

function makeLimits(
	overrides: Partial<ScalarSyncLimits> = {},
): ValidatedLimits {
	const { data, error } = validateLimits({ ...BASE_LIMITS, ...overrides });
	if (error !== null) throw new Error(error.message);
	return data;
}

const LIFETIME = 'authority-lifetime';
const OTHER_LIFETIME = 'other-authority-lifetime';
const REPLICA = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const NAMESPACE = 'so.epicenter.tests';

const rowAt = (suffix: string): RowAddress => ({
	kind: 'row',
	namespace: NAMESPACE,
	tableName: 'records',
	rowId: suffix.padStart(24, 'a'),
});
const valueAt = (valueName: string): ValueAddress => ({
	kind: 'value',
	namespace: NAMESPACE,
	valueName,
});
const patchRow = (
	address: RowAddress,
	set: Record<string, string>,
): Intent => ({
	address,
	presence: 'present',
	set,
	unset: [],
});
const setValue = (address: ValueAddress, content: string): Intent => ({
	address,
	presence: 'present',
	content,
});
const submission = (
	submissionNumber: number,
	intents: Intent[],
	authorityLifetime = LIFETIME,
): SubmissionRequest => ({
	authorityLifetime,
	replicaId: REPLICA,
	submissionNumber,
	intents,
});

function setup(limits = makeLimits()) {
	const raw = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(raw);
	const authority = openEpicenterSyncV1Authority({
		database,
		limits,
		mintLifetime: () => LIFETIME,
	});
	return { raw, database, authority, limits };
}

test('fresh schema mints one lifetime and a non-current format is refused', () => {
	const raw = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(raw);
	let mintCount = 0;
	const mintLifetime = () => {
		mintCount += 1;
		return LIFETIME;
	};
	openEpicenterSyncV1Authority({ database, mintLifetime });
	openEpicenterSyncV1Authority({ database, mintLifetime });
	expect(mintCount).toBe(1);
	expect(
		raw
			.query<{ authority_lifetime: string }, []>(
				'SELECT authority_lifetime FROM main._authority_v1_metadata',
			)
			.get()?.authority_lifetime,
	).toBe(LIFETIME);

	raw.run(
		`UPDATE main._authority_v1_metadata
		SET format_version = 99 WHERE singleton = 1`,
	);
	expect(() =>
		openEpicenterSyncV1Authority({ database, mintLifetime }),
	).toThrow('format 99 is not supported');
	expect(mintCount).toBe(1);
	raw.close();
});

test('facts from zero include present facts, a row tombstone, and a value unset', () => {
	const { raw, authority, limits } = setup();
	const presentRow = rowAt('1');
	const absentRow = rowAt('2');
	const presentValue = valueAt('theme');
	const absentValue = valueAt('optional');
	const settled = expectOk(
		authority.submit(
			submission(1, [
				patchRow(presentRow, { title: 'live' }),
				{ address: absentRow, presence: 'absent' },
				setValue(presentValue, 'dark'),
				{ address: absentValue, presence: 'absent' },
			]),
		),
	);
	expectOk(parseSubmissionResponse(settled, limits));

	const response = expectOk(authority.readFacts({ afterSequence: 0 }));
	expectOk(parseFactsResponse(response, limits));
	expect(response).toEqual({
		authorityLifetime: LIFETIME,
		facts: [
			{
				address: presentRow,
				sequence: 1,
				presence: 'present',
				fields: { title: 'live' },
			},
			{ address: absentRow, sequence: 2, presence: 'absent' },
			{
				address: presentValue,
				sequence: 3,
				presence: 'present',
				content: 'dark',
			},
			{ address: absentValue, sequence: 4, presence: 'absent' },
		],
		hasMore: false,
	});
	raw.close();
});

test('byte pages continue after the final sequence with no skips or repeats', () => {
	const limits = makeLimits({ maxFactsResponseBytes: 6_000 });
	const { raw, authority } = setup(limits);
	const content = 'x'.repeat(3_800);
	expectOk(
		authority.submit(
			submission(1, [
				setValue(valueAt('a'), content),
				setValue(valueAt('b'), content),
				setValue(valueAt('c'), content),
			]),
		),
	);

	const fullLimits = makeLimits();
	const { raw: fullRaw, authority: fullAuthority } = setup(fullLimits);
	expectOk(
		fullAuthority.submit(
			submission(1, [
				setValue(valueAt('a'), content),
				setValue(valueAt('b'), content),
				setValue(valueAt('c'), content),
			]),
		),
	);
	const full = expectOk(fullAuthority.readFacts({ afterSequence: 0 })).facts;

	const seen = [];
	let afterSequence = 0;
	let authorityLifetime: string | undefined;
	for (;;) {
		const page = expectOk(
			authority.readFacts({
				afterSequence,
				...(authorityLifetime === undefined ? {} : { authorityLifetime }),
			}),
		);
		expectOk(parseFactsResponse(page, limits));
		if (afterSequence === 0) expect(page.hasMore).toBe(true);
		seen.push(...page.facts);
		if (!page.hasMore) break;
		afterSequence = page.facts.at(-1)?.sequence ?? afterSequence;
		authorityLifetime = page.authorityLifetime;
	}
	expect(seen).toEqual(full);
	expect(new Set(seen.map((fact) => fact.sequence)).size).toBe(seen.length);
	raw.close();
	fullRaw.close();
});

test('lifetime mismatch refuses both reads and submissions', () => {
	const { raw, authority } = setup();
	expect(
		expectErr(
			authority.readFacts({
				authorityLifetime: OTHER_LIFETIME,
				afterSequence: 0,
			}),
		).name,
	).toBe('LifetimeMismatch');
	expect(
		expectErr(
			authority.submit(
				submission(1, [setValue(valueAt('theme'), 'dark')], OTHER_LIFETIME),
			),
		).name,
	).toBe('LifetimeMismatch');
	raw.close();
});

test('afterSequence beyond the active sequence returns SequenceAhead', () => {
	const { raw, authority } = setup();
	const error = expectErr(
		authority.readFacts({
			authorityLifetime: LIFETIME,
			afterSequence: 1,
		}),
	);
	expect(error.name).toBe('SequenceAhead');
	if (error.name !== 'SequenceAhead') throw new Error(error.message);
	expect(error.activeSequence).toBe(0);
	raw.close();
});

test('exact retry returns stored parking and does not apply intents twice', () => {
	const limits = makeLimits({ maxEncodedFactBytes: 420 });
	const { raw, authority } = setup(limits);
	const row = rowAt('3');
	const large = 'x'.repeat(150);
	expectOk(authority.submit(submission(1, [patchRow(row, { a: large })])));
	const request = submission(2, [
		patchRow(row, { b: large }),
		setValue(valueAt('appliedOnce'), 'yes'),
	]);
	const first = expectOk(authority.submit(request));
	const beforeRetry = raw
		.query<{ next_sequence: number }, []>(
			'SELECT next_sequence FROM main._authority_v1_metadata',
		)
		.get()?.next_sequence;
	const retry = expectOk(authority.submit(request));
	expectOk(parseSubmissionResponse(retry, limits));
	const afterRetry = raw
		.query<{ next_sequence: number }, []>(
			'SELECT next_sequence FROM main._authority_v1_metadata',
		)
		.get()?.next_sequence;

	expect(first.parked).toHaveLength(1);
	expect(first.parked[0]?.code).toBe('fact-too-large');
	expect(first.parked[0]?.measuredBytes).toBeGreaterThan(
		limits.maxEncodedFactBytes,
	);
	expect(retry.parked).toEqual(first.parked);
	expect(retry.facts).toEqual(first.facts);
	expect(afterRetry).toBe(beforeRetry);
	expect(retry.facts.map((fact) => fact.sequence)).toEqual([1, 2]);
	expect(
		retry.facts[0]?.presence === 'present' && 'fields' in retry.facts[0]
			? retry.facts[0].fields
			: undefined,
	).toEqual({ a: large });
	raw.close();
});

test('a reused number forks and a skipped number gaps without mutation', () => {
	const { raw, authority } = setup();
	expectOk(authority.submit(submission(1, [setValue(valueAt('a'), 'first')])));
	expect(
		expectErr(
			authority.submit(submission(1, [setValue(valueAt('a'), 'different')])),
		).name,
	).toBe('SubmissionFork');
	expect(
		expectErr(
			authority.submit(submission(3, [setValue(valueAt('b'), 'skipped')])),
		).name,
	).toBe('SubmissionGap');
	expect(
		raw
			.query<{ next_sequence: number }, []>(
				'SELECT next_sequence FROM main._authority_v1_metadata',
			)
			.get()?.next_sequence,
	).toBe(2);
	raw.close();
});

test('a row tombstone is terminal and a later row patch cannot resurrect it', () => {
	const { raw, authority } = setup();
	const row = rowAt('4');
	expectOk(authority.submit(submission(1, [patchRow(row, { title: 'live' })])));
	const removed = expectOk(
		authority.submit(submission(2, [{ address: row, presence: 'absent' }])),
	);
	const attempted = expectOk(
		authority.submit(submission(3, [patchRow(row, { title: 'resurrected' })])),
	);
	expect(removed.facts[0]).toEqual({
		address: row,
		sequence: 2,
		presence: 'absent',
	});
	expect(attempted.facts[0]).toEqual(removed.facts[0]);
	expect(
		raw
			.query<{ next_sequence: number }, []>(
				'SELECT next_sequence FROM main._authority_v1_metadata',
			)
			.get()?.next_sequence,
	).toBe(3);
	raw.close();
});

test('a value unset is reversible by a later set', () => {
	const { raw, authority } = setup();
	const address = valueAt('reversible');
	const unset = expectOk(
		authority.submit(submission(1, [{ address, presence: 'absent' }])),
	);
	expect(unset.facts[0]?.presence).toBe('absent');
	const set = expectOk(
		authority.submit(submission(2, [setValue(address, 'restored')])),
	);
	expect(set.facts[0]).toEqual({
		address,
		sequence: 2,
		presence: 'present',
		content: 'restored',
	});
	raw.close();
});

test('a row tombstone deletes its document updates and version', () => {
	const { raw, authority } = setup();
	const row = rowAt('5');
	expectOk(authority.submit(submission(1, [patchRow(row, { title: 'live' })])));
	raw.run('INSERT INTO document_updates VALUES (?, ?, ?, 1, ?)', [
		row.namespace,
		row.tableName,
		row.rowId,
		new Uint8Array([1]),
	]);
	raw.run('INSERT INTO document_versions VALUES (?, ?, ?, 1)', [
		row.namespace,
		row.tableName,
		row.rowId,
	]);

	expectOk(
		authority.submit(submission(2, [{ address: row, presence: 'absent' }])),
	);
	expect(
		raw
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM document_updates',
			)
			.get()?.count,
	).toBe(0);
	expect(
		raw
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM document_versions',
			)
			.get()?.count,
	).toBe(0);
	raw.close();
});

test('invalid requests return ScalarProtocolError without changing storage', () => {
	const { raw, authority } = setup();
	expect(expectErr(authority.readFacts({ afterSequence: -1 })).name).toBe(
		'Invalid',
	);
	expect(
		expectErr(
			authority.submit({
				authorityLifetime: LIFETIME,
				replicaId: REPLICA,
				submissionNumber: 1,
				intents: [],
			}),
		).name,
	).toBe('Invalid');
	expect(
		raw
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM main._authority_v1_replicas',
			)
			.get()?.count,
	).toBe(0);
	raw.close();
});

test('sequence exhaustion rolls back every staged fact', () => {
	const { raw, authority } = setup();
	raw.run(
		`UPDATE main._authority_v1_metadata
		SET next_sequence = ? WHERE singleton = 1`,
		[Number.MAX_SAFE_INTEGER],
	);
	const error = expectErr(
		authority.submit(
			submission(1, [
				setValue(valueAt('last'), 'safe'),
				setValue(valueAt('overflow'), 'refused'),
			]),
		),
	);
	expect(error.name).toBe('SequenceExhausted');
	expect(
		raw
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM main._authority_v1_value_facts',
			)
			.get()?.count,
	).toBe(0);
	raw.close();
});

/**
 * A counting adapter that records how many rows each query materialized.
 *
 * Acquisition cost is the thing under test, and it is invisible to a response
 * assertion: a `readFacts` that selects every qualifying fact and then slices a
 * byte prefix returns exactly the same bytes as one that walks in bounded
 * steps. Only the work done to produce them differs, so the test has to watch
 * the queries.
 */
function countingAdapter(database: SqliteDatabase) {
	let maxRowsInOneQuery = 0;
	let totalRowsRead = 0;
	const counting: SqliteDatabase = {
		run: (sql, parameters) => database.run(sql, parameters),
		transaction: (run) => database.transaction(run),
		all: <TRow extends SqliteRow>(
			sql: string,
			parameters?: readonly SqliteValue[],
		): TRow[] => {
			const rows = database.all<TRow>(sql, parameters);
			// Only the fact feed matters here; metadata and replica lookups are O(1).
			if (sql.includes('_authority_v1_row_facts')) {
				maxRowsInOneQuery = Math.max(maxRowsInOneQuery, rows.length);
				totalRowsRead += rows.length;
			}
			return rows;
		},
	};
	return {
		counting,
		get maxRowsInOneQuery() {
			return maxRowsInOneQuery;
		},
		get totalRowsRead() {
			return totalRowsRead;
		},
	};
}

/** Fill an authority with `count` small value facts, in bounded submissions. */
function seedValueFacts(authority: EpicenterSyncV1Authority, count: number) {
	let submissionNumber = 1;
	for (let start = 0; start < count; start += 32) {
		const intents: Intent[] = [];
		for (let index = start; index < Math.min(start + 32, count); index += 1) {
			intents.push(setValue(valueAt(`v${index}`), 'x'));
		}
		expectOk(authority.submit(submission(submissionNumber, intents)));
		submissionNumber += 1;
	}
}

test('acquisition work is bounded independently of total authority size', () => {
	// One page holds only a handful of facts, so every authority below needs
	// many pages to drain. What must not grow is the work for a single page.
	const limits = makeLimits({ maxFactsResponseBytes: 6_000 });

	function measureFirstPage(factCount: number) {
		const raw = new Database(':memory:', { strict: true });
		const database = createBunSqliteAdapter(raw);
		const seeding = openEpicenterSyncV1Authority({
			database,
			limits,
			mintLifetime: () => LIFETIME,
		});
		seedValueFacts(seeding, factCount);

		const meter = countingAdapter(database);
		const authority = openEpicenterSyncV1Authority({
			database: meter.counting,
			limits,
			mintLifetime: () => LIFETIME,
		});
		const page = expectOk(authority.readFacts({ afterSequence: 0 }));
		expectOk(parseFactsResponse(page, limits));
		raw.close();
		return {
			returned: page.facts.length,
			hasMore: page.hasMore,
			maxRowsInOneQuery: meter.maxRowsInOneQuery,
			totalRowsRead: meter.totalRowsRead,
		};
	}

	const small = measureFirstPage(100);
	const large = measureFirstPage(2_000);

	// The page itself is identical: same facts, same continuation.
	expect(large.returned).toBe(small.returned);
	expect(small.hasMore).toBe(true);
	expect(large.hasMore).toBe(true);

	// And so is the work. A twentyfold larger authority reads no more rows for
	// the same page. The implementation this replaces read every qualifying
	// fact first, so `totalRowsRead` was 100 and then 2000.
	expect(large.totalRowsRead).toBe(small.totalRowsRead);
	expect(large.maxRowsInOneQuery).toBe(small.maxRowsInOneQuery);
	expect(large.totalRowsRead).toBeLessThan(200);
});

test('a bounded scan still drains a large authority with no skips or repeats', () => {
	const limits = makeLimits({ maxFactsResponseBytes: 6_000 });
	const raw = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(raw);
	const authority = openEpicenterSyncV1Authority({
		database,
		limits,
		mintLifetime: () => LIFETIME,
	});
	const total = 500;
	seedValueFacts(authority, total);

	const seen: number[] = [];
	let afterSequence = 0;
	for (;;) {
		const page = expectOk(
			authority.readFacts({
				afterSequence,
				...(afterSequence === 0 ? {} : { authorityLifetime: LIFETIME }),
			}),
		);
		expectOk(parseFactsResponse(page, limits));
		if (page.facts.length === 0) {
			expect(page.hasMore).toBe(false);
			break;
		}
		seen.push(...page.facts.map((fact) => fact.sequence));
		afterSequence = page.facts.at(-1)?.sequence ?? afterSequence;
		if (!page.hasMore) break;
	}

	expect(seen).toHaveLength(total);
	expect(new Set(seen).size).toBe(total);
	// Strictly increasing across page boundaries: nothing skipped, nothing repeated.
	expect(seen).toEqual([...seen].sort((left, right) => left - right));
	raw.close();
});
