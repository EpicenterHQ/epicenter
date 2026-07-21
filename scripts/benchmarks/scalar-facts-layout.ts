#!/usr/bin/env bun

import { constants, Database, type SQLQueryBindings } from 'bun:sqlite';
import {
	existsSync,
	mkdtempSync,
	rmSync,
	statfsSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';

type Owner = 'replica' | 'authority';
type RelationLayout = 'unified' | 'split';
type CoordinateLayout = 'inline' | 'normalized';

type Candidate = {
	id: string;
	relation: RelationLayout;
	coordinates: CoordinateLayout;
};

type Fact = {
	kind: 'row' | 'value';
	namespace: string;
	localKey: string;
	rowId: string;
	present: 0 | 1;
	payload: string | null;
	sequence: number;
};

type Profile = {
	facts: number;
	payloadBytes: number;
	repetitions: number;
	steadyWrites: number;
	pointReads: number;
	traversals: number;
	feedPageSize: number;
	submissions: number;
};

type Options = Profile & {
	profile: 'smoke' | 'full';
	dataSeed: number;
	orderSeed: number;
	output?: string;
};

type Samples = {
	rawMs: number[];
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	coefficientOfVariation: number;
};

type StorageMetrics = {
	pageSize: number;
	pageCount: number;
	freelistCount: number;
	allocatedBytes: number;
	liveBytes: number;
	databaseFileBytes: number;
};

type RunResult = {
	owner: Owner;
	candidate: Candidate;
	repetition: number;
	dataSeed: number;
	correct: boolean;
	proofs: Record<string, boolean>;
	metrics: Record<string, Samples>;
	storage: StorageMetrics;
	walDiagnostics: Record<string, number>;
	queryPlans: Record<string, unknown[]>;
	integrityCheck: string;
	semanticHash: string;
	reopenedSemanticHash: string;
	logicalPayloadBytes: number;
	currentFacts: number;
	datasetMix: Record<string, number>;
	workloadMix: Record<string, number>;
	ddlHash: string;
	error?: string;
};

const SAFE_SEQUENCE_MAX = Number.MAX_SAFE_INTEGER;
const PAGE_SIZE = 4096;
const CACHE_KIB = 16 * 1024;
const ADDRESS_BATCH = 64;
const NAMESPACE_COUNT = 25;
const TABLE_COUNT = 40;
const VALUE_RATIO = 0.01;

const REPLICA_CRITICAL_METRICS = [
	'acquisition',
	'monotonicFactInstall',
	'confirmedPointRead',
	'confirmedTableTraversal',
	'confirmedPendingOverlayRead',
	'rowTombstoneDocumentCleanup',
	'warmReopen',
] as const;

const AUTHORITY_CRITICAL_METRICS = [
	'orderedFreshFeed',
	'orderedResumeFeed',
	'submission64WriteSettlement',
	'foldPointRead',
	'exactRetrySettlementRead',
	'warmReopen',
] as const;

const CANDIDATES: Candidate[] = [
	{ id: 'unified-inline', relation: 'unified', coordinates: 'inline' },
	{
		id: 'unified-normalized',
		relation: 'unified',
		coordinates: 'normalized',
	},
	{ id: 'split-inline', relation: 'split', coordinates: 'inline' },
	{ id: 'split-normalized', relation: 'split', coordinates: 'normalized' },
];

const PROFILE_DEFAULTS: Record<'smoke' | 'full', Profile> = {
	smoke: {
		facts: 5_000,
		payloadBytes: 1024 * 1024,
		repetitions: 1,
		steadyWrites: 128,
		pointReads: 128,
		traversals: 4,
		feedPageSize: 256,
		submissions: 4,
	},
	full: {
		facts: 1_000_000,
		payloadBytes: 512 * 1024 * 1024,
		repetitions: 5,
		steadyWrites: 10_000,
		pointReads: 2_000,
		traversals: 16,
		feedPageSize: 512,
		submissions: 50,
	},
};

const HELP = `
Benchmark the four scalar-fact SQLite physical layouts.

Usage:
  bun scripts/benchmarks/scalar-facts-layout.ts [options]

Options:
  --profile smoke|full       Defaults to smoke. Full uses 1,000,000 facts and
                             approximately 512 MiB of logical payload.
  --facts <positive-int>     Override the number of current facts.
  --payload-bytes <int>      Override the target logical payload bytes.
  --repetitions <int>        Override repetitions per owner/candidate.
  --data-seed <uint32>       Dataset and workload seed (default: 1597463007).
  --order-seed <uint32>      Candidate-order seed (default: 2654435769).
  --output <path>            Also write the JSON report to this path.
  --help                     Show this help.

The script writes no repository file unless --output is supplied. Temporary
databases, WAL files, and SHM files are removed in finally blocks.
`.trim();

function parsePositiveInteger(name: string, value: string | undefined): number {
	if (value === undefined || !/^[0-9]+$/.test(value)) {
		throw new Error(`${name} requires a positive integer`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive safe integer`);
	}
	return parsed;
}

function parseUint32(name: string, value: string | undefined): number {
	if (value === undefined || !/^[0-9]+$/.test(value)) {
		throw new Error(`${name} requires an unsigned integer`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(`${name} must be a safe integer`);
	}
	if (parsed > 0xffff_ffff) throw new Error(`${name} must fit in uint32`);
	return parsed;
}

function parseOptions(args: string[]): Options | null {
	if (args.includes('--help')) return null;
	let profileName: 'smoke' | 'full' = 'smoke';
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] !== '--profile') continue;
		const value = args[index + 1];
		if (value !== 'smoke' && value !== 'full') {
			throw new Error('--profile must be smoke or full');
		}
		profileName = value;
	}

	const options: Options = {
		profile: profileName,
		...PROFILE_DEFAULTS[profileName],
		dataSeed: 1_597_463_007,
		orderSeed: 2_654_435_769,
	};
	const valued = new Set([
		'--profile',
		'--facts',
		'--payload-bytes',
		'--repetitions',
		'--data-seed',
		'--order-seed',
		'--output',
	]);
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		if (flag === undefined) throw new Error('option parsing escaped argv');
		if (!valued.has(flag)) throw new Error(`Unknown option: ${flag}`);
		const value = args[index + 1];
		if (value === undefined || value.startsWith('--')) {
			throw new Error(`${flag} requires a value`);
		}
		switch (flag) {
			case '--profile':
				break;
			case '--facts':
				options.facts = parsePositiveInteger(flag, value);
				break;
			case '--payload-bytes':
				options.payloadBytes = parsePositiveInteger(flag, value);
				break;
			case '--repetitions':
				options.repetitions = parsePositiveInteger(flag, value);
				break;
			case '--data-seed':
				options.dataSeed = parseUint32(flag, value);
				break;
			case '--order-seed':
				options.orderSeed = parseUint32(flag, value);
				break;
			case '--output':
				options.output = value;
				break;
			default:
				throw new Error(`Unknown option: ${flag}`);
		}
		index += 1;
	}
	if (
		options.facts +
			options.steadyWrites +
			options.submissions * ADDRESS_BATCH >=
		SAFE_SEQUENCE_MAX
	) {
		throw new Error('configured workload would exhaust JSON-safe sequences');
	}
	if (options.facts < ADDRESS_BATCH) {
		throw new Error(`--facts must be at least ${ADDRESS_BATCH}`);
	}
	const configuredRows = options.facts - valueCount(options.facts);
	if (
		configuredRows - Math.max(1, Math.floor(configuredRows * 0.05)) <
		ADDRESS_BATCH
	) {
		throw new Error(
			'configured dataset must retain at least 64 live row addresses',
		);
	}
	return options;
}

function checkTemporarySpace(options: Options) {
	const requiredBytes = Math.ceil(
		Math.max(
			256 * 1024 * 1024,
			options.payloadBytes * 3 + options.facts * 1024 + 64 * 1024 * 1024,
		),
	);
	let availableBytes: number | null = null;
	try {
		const stats = statfsSync(tmpdir());
		availableBytes = Number(stats.bavail) * Number(stats.bsize);
	} catch {
		// Some hosts do not expose filesystem capacity. Report that gap explicitly.
	}
	if (availableBytes !== null && availableBytes < requiredBytes) {
		throw new Error(
			`temporary filesystem has ${availableBytes} bytes free; benchmark requires a conservative ${requiredBytes} bytes`,
		);
	}
	return {
		temporaryDirectory: tmpdir(),
		availableBytes,
		requiredBytes,
		estimateFormula:
			'max(256 MiB, 3×logical payload target + 1 KiB per fact + 64 MiB bounded WAL/headroom)',
	};
}

function hash32(seed: number, value: number): number {
	let state = (seed ^ Math.imul(value + 1, 0x9e37_79b1)) >>> 0;
	state ^= state >>> 16;
	state = Math.imul(state, 0x7feb_352d);
	state ^= state >>> 15;
	state = Math.imul(state, 0x846c_a68b);
	state ^= state >>> 16;
	return state >>> 0;
}

function greatestCommonDivisor(left: number, right: number): number {
	let a = left;
	let b = right;
	while (b !== 0) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return a;
}

function permutationAt(ordinal: number, size: number, seed: number): number {
	if (size <= 1) return 0;
	let step = hash32(seed ^ 0x5354_4550, size) % size || 1;
	while (greatestCommonDivisor(step, size) !== 1) step += 1;
	const offset = hash32(seed ^ 0x4f46_4653, size) % size;
	return (offset + ordinal * step) % size;
}

function shuffle<T>(values: readonly T[], seed: number): T[] {
	const shuffled = [...values];
	let state = seed >>> 0;
	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		state = hash32(state, index);
		const target = state % (index + 1);
		const current = shuffled[index];
		const replacement = shuffled[target];
		if (current === undefined || replacement === undefined) {
			throw new Error('shuffle index escaped the candidate array');
		}
		shuffled[index] = replacement;
		shuffled[target] = current;
	}
	return shuffled;
}

function rowId(index: number): string {
	return index.toString(36).padStart(24, '0');
}

function valueCount(facts: number): number {
	return Math.max(1, Math.min(facts, Math.ceil(facts * VALUE_RATIO)));
}

function addressAt(index: number, facts: number, seed: number) {
	const values = valueCount(facts);
	const namespaceIndex = hash32(seed ^ 0x4e53_5043, index) % NAMESPACE_COUNT;
	const namespace = `com.epicenter.benchmark.ns${namespaceIndex
		.toString()
		.padStart(2, '0')}`;
	if (index < values) {
		return {
			kind: 'value' as const,
			namespace,
			localKey: `setting${index.toString(36)}`,
			rowId: '',
		};
	}
	const tableIndex = hash32(seed ^ 0x5442_4c45, index) % TABLE_COUNT;
	return {
		kind: 'row' as const,
		namespace,
		localKey: `collection${tableIndex.toString().padStart(2, '0')}`,
		rowId: rowId(index - values),
	};
}

function repeatToLength(pattern: string, length: number): string {
	if (length <= 0) return '';
	return pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
}

function makePayload(
	index: number,
	facts: number,
	seed: number,
	targetPerPresent: number,
	phase: number,
): string {
	const address = addressAt(index, facts, seed);
	const mixed = hash32(seed ^ phase, index);
	if (address.kind === 'value') {
		if (mixed % 19 === 0) return 'null';
		if (mixed % 17 === 0) return JSON.stringify(mixed % 10_000);
		const prefix = `setting-${index}-${phase}-`;
		return JSON.stringify(
			prefix +
				repeatToLength(
					(mixed >>> 0).toString(36),
					Math.max(0, targetPerPresent - prefix.length - 2),
				),
		);
	}
	const fixed = JSON.stringify({
		body: '',
		ordinal: index,
		phase,
		active: true,
	}).length;
	return JSON.stringify({
		body: repeatToLength(
			(mixed >>> 0).toString(36),
			Math.max(0, targetPerPresent - fixed),
		),
		ordinal: index,
		phase,
		active: true,
	});
}

function initialFact(
	index: number,
	options: Options,
	targetPerPresent: number,
): Fact {
	const address = addressAt(index, options.facts, options.dataSeed);
	return {
		...address,
		present: 1,
		payload: makePayload(
			index,
			options.facts,
			options.dataSeed,
			targetPerPresent,
			0,
		),
		sequence: index + 1,
	};
}

function factCheck(kindExpression: string): string {
	return `CHECK (
		CASE
			WHEN ${kindExpression} = 'row' AND present = 1 THEN
				typeof(present) = 'integer' AND typeof(payload) = 'text' AND json_valid(payload) = 1 AND json_type(payload) = 'object'
			WHEN ${kindExpression} = 'row' AND present = 0 THEN payload IS NULL
			WHEN ${kindExpression} = 'value' AND present = 1 THEN
				typeof(present) = 'integer' AND typeof(payload) = 'text' AND json_valid(payload) = 1
			WHEN ${kindExpression} = 'value' AND present = 0 THEN payload IS NULL
			ELSE 0
		END
	)`;
}

function fixedKindCheck(kind: 'row' | 'value'): string {
	return factCheck(`'${kind}'`);
}

function triggerFactExpression(kindExpression: string): string {
	return factCheck(kindExpression)
		.replace('CHECK (', '')
		.replace(/\)\s*$/, '')
		.replaceAll('present', 'NEW.present')
		.replaceAll('payload', 'NEW.payload');
}

function splitSequenceTriggers(): string {
	return `
		CREATE TRIGGER row_sequence_insert BEFORE INSERT ON row_facts
		WHEN EXISTS (SELECT 1 FROM value_facts WHERE sequence = NEW.sequence)
		BEGIN SELECT RAISE(ABORT, 'cross-table sequence collision'); END;
		CREATE TRIGGER row_sequence_update BEFORE UPDATE OF sequence ON row_facts
		WHEN EXISTS (SELECT 1 FROM value_facts WHERE sequence = NEW.sequence)
		BEGIN SELECT RAISE(ABORT, 'cross-table sequence collision'); END;
		CREATE TRIGGER value_sequence_insert BEFORE INSERT ON value_facts
		WHEN EXISTS (SELECT 1 FROM row_facts WHERE sequence = NEW.sequence)
		BEGIN SELECT RAISE(ABORT, 'cross-table sequence collision'); END;
		CREATE TRIGGER value_sequence_update BEFORE UPDATE OF sequence ON value_facts
		WHEN EXISTS (SELECT 1 FROM row_facts WHERE sequence = NEW.sequence)
		BEGIN SELECT RAISE(ABORT, 'cross-table sequence collision'); END;
	`;
}

function ddlFor(candidate: Candidate): string {
	const sequence = `CHECK (typeof(sequence) = 'integer' AND sequence >= 1 AND sequence <= ${SAFE_SEQUENCE_MAX})`;
	const rowIdCheck =
		"typeof(row_id) = 'text' AND length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'";
	const textCheck = (column: string) =>
		`typeof(${column}) = 'text' AND length(${column}) > 0`;
	const coordinateTable =
		candidate.coordinates === 'normalized'
			? `CREATE TABLE coordinates (
			coordinate_id INTEGER PRIMARY KEY CHECK (typeof(coordinate_id) = 'integer'),
			kind TEXT NOT NULL CHECK (typeof(kind) = 'text' AND kind IN ('row', 'value')),
			namespace TEXT NOT NULL CHECK (${textCheck('namespace')}),
			local_key TEXT NOT NULL CHECK (${textCheck('local_key')}),
			UNIQUE (kind, namespace, local_key)
		);`
			: '';

	if (candidate.relation === 'unified' && candidate.coordinates === 'inline') {
		return `
			CREATE TABLE facts (
				kind TEXT NOT NULL CHECK (typeof(kind) = 'text' AND kind IN ('row', 'value')),
				namespace TEXT NOT NULL CHECK (${textCheck('namespace')}),
				local_key TEXT NOT NULL CHECK (${textCheck('local_key')}),
				row_id TEXT NOT NULL,
				present INTEGER NOT NULL CHECK (typeof(present) = 'integer' AND present IN (0, 1)),
				payload TEXT CHECK (payload IS NULL OR typeof(payload) = 'text'),
				sequence INTEGER NOT NULL UNIQUE ${sequence},
				CHECK (CASE kind WHEN 'row' THEN ${rowIdCheck} WHEN 'value' THEN row_id = '' ELSE 0 END),
				${factCheck('kind')},
				PRIMARY KEY (kind, namespace, local_key, row_id)
			) WITHOUT ROWID;
		`;
	}

	if (candidate.relation === 'unified') {
		return `
			${coordinateTable}
			CREATE TABLE facts (
				coordinate_id INTEGER NOT NULL CHECK (typeof(coordinate_id) = 'integer') REFERENCES coordinates(coordinate_id),
				row_id TEXT NOT NULL,
				present INTEGER NOT NULL CHECK (typeof(present) = 'integer' AND present IN (0, 1)),
				payload TEXT CHECK (payload IS NULL OR typeof(payload) = 'text'),
				sequence INTEGER NOT NULL UNIQUE ${sequence},
				PRIMARY KEY (coordinate_id, row_id)
			) WITHOUT ROWID;
			CREATE TRIGGER facts_shape_insert BEFORE INSERT ON facts BEGIN
				SELECT CASE WHEN NOT EXISTS (
					SELECT 1 FROM coordinates c WHERE c.coordinate_id = NEW.coordinate_id AND
					CASE
						WHEN c.kind = 'row' THEN ${rowIdCheck.replaceAll('row_id', 'NEW.row_id')}
						WHEN c.kind = 'value' THEN NEW.row_id = ''
						ELSE 0
					END
				) THEN RAISE(ABORT, 'invalid address shape') END;
				SELECT CASE WHEN NOT (${triggerFactExpression('c.kind')})
					THEN RAISE(ABORT, 'invalid fact shape') END
				FROM coordinates c WHERE c.coordinate_id = NEW.coordinate_id;
			END;
			CREATE TRIGGER facts_shape_update BEFORE UPDATE ON facts BEGIN
				SELECT CASE WHEN NOT EXISTS (
					SELECT 1 FROM coordinates c WHERE c.coordinate_id = NEW.coordinate_id AND
					CASE
						WHEN c.kind = 'row' THEN ${rowIdCheck.replaceAll('row_id', 'NEW.row_id')}
						WHEN c.kind = 'value' THEN NEW.row_id = ''
						ELSE 0
					END
				) THEN RAISE(ABORT, 'invalid address shape') END;
				SELECT CASE WHEN NOT (${triggerFactExpression('c.kind')})
					THEN RAISE(ABORT, 'invalid fact shape') END
				FROM coordinates c WHERE c.coordinate_id = NEW.coordinate_id;
			END;
			CREATE TRIGGER coordinate_update_referenced BEFORE UPDATE ON coordinates
			WHEN EXISTS (SELECT 1 FROM facts WHERE coordinate_id = OLD.coordinate_id)
			BEGIN SELECT RAISE(ABORT, 'referenced coordinate is immutable'); END;
			CREATE TRIGGER coordinate_delete_referenced BEFORE DELETE ON coordinates
			WHEN EXISTS (SELECT 1 FROM facts WHERE coordinate_id = OLD.coordinate_id)
			BEGIN SELECT RAISE(ABORT, 'referenced coordinate is immutable'); END;
		`;
	}

	const rowCoordinate =
		candidate.coordinates === 'normalized'
			? "coordinate_id INTEGER NOT NULL CHECK (typeof(coordinate_id) = 'integer') REFERENCES coordinates(coordinate_id),"
			: `namespace TEXT NOT NULL CHECK (${textCheck('namespace')}),\n\t\t\tlocal_key TEXT NOT NULL CHECK (${textCheck('local_key')}),`;
	const valueCoordinate = rowCoordinate;
	const rowPrimary =
		candidate.coordinates === 'normalized'
			? 'PRIMARY KEY (coordinate_id, row_id)'
			: 'PRIMARY KEY (namespace, local_key, row_id)';
	const valuePrimary =
		candidate.coordinates === 'normalized'
			? 'PRIMARY KEY (coordinate_id)'
			: 'PRIMARY KEY (namespace, local_key)';
	const normalizedKindTriggers =
		candidate.coordinates === 'normalized'
			? `
		CREATE TRIGGER row_coordinate_insert BEFORE INSERT ON row_facts
		WHEN NOT EXISTS (SELECT 1 FROM coordinates WHERE coordinate_id=NEW.coordinate_id AND kind='row')
		BEGIN SELECT RAISE(ABORT, 'row fact requires row coordinate'); END;
		CREATE TRIGGER row_coordinate_update BEFORE UPDATE OF coordinate_id ON row_facts
		WHEN NOT EXISTS (SELECT 1 FROM coordinates WHERE coordinate_id=NEW.coordinate_id AND kind='row')
		BEGIN SELECT RAISE(ABORT, 'row fact requires row coordinate'); END;
		CREATE TRIGGER value_coordinate_insert BEFORE INSERT ON value_facts
		WHEN NOT EXISTS (SELECT 1 FROM coordinates WHERE coordinate_id=NEW.coordinate_id AND kind='value')
		BEGIN SELECT RAISE(ABORT, 'value fact requires value coordinate'); END;
		CREATE TRIGGER value_coordinate_update BEFORE UPDATE OF coordinate_id ON value_facts
		WHEN NOT EXISTS (SELECT 1 FROM coordinates WHERE coordinate_id=NEW.coordinate_id AND kind='value')
		BEGIN SELECT RAISE(ABORT, 'value fact requires value coordinate'); END;
		CREATE TRIGGER coordinate_update_referenced BEFORE UPDATE ON coordinates
		WHEN EXISTS (SELECT 1 FROM row_facts WHERE coordinate_id = OLD.coordinate_id)
			OR EXISTS (SELECT 1 FROM value_facts WHERE coordinate_id = OLD.coordinate_id)
		BEGIN SELECT RAISE(ABORT, 'referenced coordinate is immutable'); END;
		CREATE TRIGGER coordinate_delete_referenced BEFORE DELETE ON coordinates
		WHEN EXISTS (SELECT 1 FROM row_facts WHERE coordinate_id = OLD.coordinate_id)
			OR EXISTS (SELECT 1 FROM value_facts WHERE coordinate_id = OLD.coordinate_id)
		BEGIN SELECT RAISE(ABORT, 'referenced coordinate is immutable'); END;
	`
			: '';
	return `
		${coordinateTable}
		CREATE TABLE row_facts (
			${rowCoordinate}
			row_id TEXT NOT NULL CHECK (${rowIdCheck}),
			present INTEGER NOT NULL CHECK (typeof(present) = 'integer' AND present IN (0, 1)),
			payload TEXT CHECK (payload IS NULL OR typeof(payload) = 'text'),
			sequence INTEGER NOT NULL UNIQUE ${sequence},
			${fixedKindCheck('row')},
			${rowPrimary}
		) WITHOUT ROWID;
		CREATE TABLE value_facts (
			${valueCoordinate}
			present INTEGER NOT NULL CHECK (typeof(present) = 'integer' AND present IN (0, 1)),
			payload TEXT CHECK (payload IS NULL OR typeof(payload) = 'text'),
			sequence INTEGER NOT NULL UNIQUE ${sequence},
			${fixedKindCheck('value')},
			${valuePrimary}
		) WITHOUT ROWID;
		${normalizedKindTriggers}
		${splitSequenceTriggers()}
	`;
}

const FIXTURE_DDL = `
	CREATE TABLE pending_intents (
		kind TEXT NOT NULL CHECK (typeof(kind)='text' AND kind IN ('row','value')),
		namespace TEXT NOT NULL CHECK (typeof(namespace)='text'),
		local_key TEXT NOT NULL CHECK (typeof(local_key)='text'),
		row_id TEXT NOT NULL CHECK (typeof(row_id)='text'),
		present INTEGER NOT NULL CHECK (typeof(present)='integer' AND present IN (0,1)),
		payload TEXT CHECK (payload IS NULL OR typeof(payload)='text'),
		PRIMARY KEY (kind, namespace, local_key, row_id)
	) WITHOUT ROWID;
	CREATE TABLE parked_work (
		kind TEXT NOT NULL,
		namespace TEXT NOT NULL,
		local_key TEXT NOT NULL,
		row_id TEXT NOT NULL,
		reason TEXT NOT NULL CHECK (typeof(reason)='text'),
		PRIMARY KEY (kind, namespace, local_key, row_id)
	) WITHOUT ROWID;
	CREATE TABLE row_documents (
		namespace TEXT NOT NULL CHECK (typeof(namespace)='text'),
		table_key TEXT NOT NULL CHECK (typeof(table_key)='text'),
		row_id TEXT NOT NULL CHECK (typeof(row_id)='text'),
		bytes BLOB NOT NULL CHECK (typeof(bytes)='blob'),
		PRIMARY KEY (namespace, table_key, row_id)
	) WITHOUT ROWID;
`;

function sha256(value: string): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(value);
	return hasher.digest('hex');
}

function configureNewDatabase(database: Database): void {
	database.exec(`PRAGMA page_size=${PAGE_SIZE}`);
	database.exec(`PRAGMA cache_size=-${CACHE_KIB}`);
	database.exec('PRAGMA foreign_keys=ON');
	database.exec('PRAGMA journal_mode=WAL');
	database.exec('PRAGMA synchronous=NORMAL');
	database.exec('PRAGMA wal_autocheckpoint=1000');
	database.exec('PRAGMA temp_store=MEMORY');
}

function configureReopenedDatabase(database: Database): void {
	database.exec(`PRAGMA cache_size=-${CACHE_KIB}`);
	database.exec('PRAGMA foreign_keys=ON');
	database.exec('PRAGMA synchronous=NORMAL');
	database.exec('PRAGMA wal_autocheckpoint=1000');
	database.exec('PRAGMA temp_store=MEMORY');
}

function createStore(database: Database, candidate: Candidate) {
	const prepared: Array<{ finalize(): void }> = [];
	function prepare(sql: string) {
		const statement = database.prepare(sql);
		prepared.push(statement);
		return statement;
	}
	const coordinateCache = new Map<string, number>();
	const coordinateInsert =
		candidate.coordinates === 'normalized'
			? prepare(
					'INSERT OR IGNORE INTO coordinates (kind, namespace, local_key) VALUES (?, ?, ?)',
				)
			: null;
	const coordinateSelect =
		candidate.coordinates === 'normalized'
			? prepare(
					'SELECT coordinate_id FROM coordinates WHERE kind = ? AND namespace = ? AND local_key = ?',
				)
			: null;

	function coordinateId(fact: Fact): number {
		const key = `${fact.kind}\u0000${fact.namespace}\u0000${fact.localKey}`;
		const cached = coordinateCache.get(key);
		if (cached !== undefined) return cached;
		if (coordinateInsert === null || coordinateSelect === null) {
			throw new Error('normalized coordinate statements are unavailable');
		}
		coordinateInsert.run(fact.kind, fact.namespace, fact.localKey);
		const found = coordinateSelect.get(
			fact.kind,
			fact.namespace,
			fact.localKey,
		) as { coordinate_id: number } | null;
		if (found === null) throw new Error(`coordinate lookup failed: ${key}`);
		coordinateCache.set(key, found.coordinate_id);
		return found.coordinate_id;
	}

	function factSql(mode: 'insert' | 'upsert', kind: 'row' | 'value'): string {
		const conflict =
			mode === 'insert'
				? ''
				: candidate.relation === 'unified'
					? candidate.coordinates === 'inline'
						? 'ON CONFLICT(kind, namespace, local_key, row_id) DO UPDATE SET present=excluded.present, payload=excluded.payload, sequence=excluded.sequence'
						: 'ON CONFLICT(coordinate_id, row_id) DO UPDATE SET present=excluded.present, payload=excluded.payload, sequence=excluded.sequence'
					: kind === 'row'
						? candidate.coordinates === 'inline'
							? 'ON CONFLICT(namespace, local_key, row_id) DO UPDATE SET present=excluded.present, payload=excluded.payload, sequence=excluded.sequence'
							: 'ON CONFLICT(coordinate_id, row_id) DO UPDATE SET present=excluded.present, payload=excluded.payload, sequence=excluded.sequence'
						: candidate.coordinates === 'inline'
							? 'ON CONFLICT(namespace, local_key) DO UPDATE SET present=excluded.present, payload=excluded.payload, sequence=excluded.sequence'
							: 'ON CONFLICT(coordinate_id) DO UPDATE SET present=excluded.present, payload=excluded.payload, sequence=excluded.sequence';
		if (candidate.relation === 'unified') {
			return candidate.coordinates === 'inline'
				? `INSERT INTO facts (kind, namespace, local_key, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?, ?, ?) ${conflict}`
				: `INSERT INTO facts (coordinate_id, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?) ${conflict}`;
		}
		const table = kind === 'row' ? 'row_facts' : 'value_facts';
		if (candidate.coordinates === 'normalized') {
			return kind === 'row'
				? `INSERT INTO ${table} (coordinate_id, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?) ${conflict}`
				: `INSERT INTO ${table} (coordinate_id, present, payload, sequence) VALUES (?, ?, ?, ?) ${conflict}`;
		}
		return kind === 'row'
			? `INSERT INTO ${table} (namespace, local_key, row_id, present, payload, sequence) VALUES (?, ?, ?, ?, ?, ?) ${conflict}`
			: `INSERT INTO ${table} (namespace, local_key, present, payload, sequence) VALUES (?, ?, ?, ?, ?) ${conflict}`;
	}

	const statements = {
		rowInsert: prepare(factSql('insert', 'row')),
		valueInsert: prepare(factSql('insert', 'value')),
		rowUpsert: prepare(factSql('upsert', 'row')),
		valueUpsert: prepare(factSql('upsert', 'value')),
	};
	const pendingUpsert = prepare(`
		INSERT INTO pending_intents (kind, namespace, local_key, row_id, present, payload)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(kind, namespace, local_key, row_id)
		DO UPDATE SET present=excluded.present, payload=excluded.payload
	`);
	const parkedUpsert = prepare(`
		INSERT INTO parked_work (kind, namespace, local_key, row_id, reason)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(kind, namespace, local_key, row_id)
		DO UPDATE SET reason=excluded.reason
	`);
	const documentUpsert = prepare(`
		INSERT INTO row_documents (namespace, table_key, row_id, bytes)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(namespace, table_key, row_id) DO UPDATE SET bytes=excluded.bytes
	`);

	function write(fact: Fact, mode: 'insert' | 'upsert' = 'upsert'): void {
		const statement =
			fact.kind === 'row'
				? mode === 'insert'
					? statements.rowInsert
					: statements.rowUpsert
				: mode === 'insert'
					? statements.valueInsert
					: statements.valueUpsert;
		if (candidate.coordinates === 'normalized') {
			const id = coordinateId(fact);
			if (candidate.relation === 'split' && fact.kind === 'value') {
				statement.run(id, fact.present, fact.payload, fact.sequence);
			} else {
				statement.run(
					id,
					fact.rowId,
					fact.present,
					fact.payload,
					fact.sequence,
				);
			}
			return;
		}
		if (candidate.relation === 'unified') {
			statement.run(
				fact.kind,
				fact.namespace,
				fact.localKey,
				fact.rowId,
				fact.present,
				fact.payload,
				fact.sequence,
			);
		} else if (fact.kind === 'row') {
			statement.run(
				fact.namespace,
				fact.localKey,
				fact.rowId,
				fact.present,
				fact.payload,
				fact.sequence,
			);
		} else {
			statement.run(
				fact.namespace,
				fact.localKey,
				fact.present,
				fact.payload,
				fact.sequence,
			);
		}
	}

	const pointSql =
		candidate.relation === 'unified'
			? candidate.coordinates === 'inline'
				? 'SELECT present, payload, sequence FROM facts WHERE kind=? AND namespace=? AND local_key=? AND row_id=?'
				: 'SELECT f.present, f.payload, f.sequence FROM facts f JOIN coordinates c USING(coordinate_id) WHERE c.kind=? AND c.namespace=? AND c.local_key=? AND f.row_id=?'
			: candidate.coordinates === 'inline'
				? {
						row: 'SELECT present, payload, sequence FROM row_facts WHERE namespace=? AND local_key=? AND row_id=?',
						value:
							'SELECT present, payload, sequence FROM value_facts WHERE namespace=? AND local_key=?',
					}
				: {
						row: "SELECT f.present, f.payload, f.sequence FROM row_facts f JOIN coordinates c USING(coordinate_id) WHERE c.kind='row' AND c.namespace=? AND c.local_key=? AND f.row_id=?",
						value:
							"SELECT f.present, f.payload, f.sequence FROM value_facts f JOIN coordinates c USING(coordinate_id) WHERE c.kind='value' AND c.namespace=? AND c.local_key=?",
					};
	const pointStatements =
		typeof pointSql === 'string'
			? { unified: prepare(pointSql) }
			: {
					row: prepare(pointSql.row),
					value: prepare(pointSql.value),
				};

	function get(fact: Fact): {
		present: 0 | 1;
		payload: string | null;
		sequence: number;
	} | null {
		let found: unknown;
		if ('unified' in pointStatements && pointStatements.unified !== undefined) {
			found = pointStatements.unified.get(
				fact.kind,
				fact.namespace,
				fact.localKey,
				fact.rowId,
			);
		} else {
			found =
				fact.kind === 'row'
					? pointStatements.row.get(fact.namespace, fact.localKey, fact.rowId)
					: pointStatements.value.get(fact.namespace, fact.localKey);
		}
		return found as {
			present: 0 | 1;
			payload: string | null;
			sequence: number;
		} | null;
	}

	const overlaySql =
		candidate.relation === 'unified'
			? candidate.coordinates === 'inline'
				? `SELECT CASE WHEN p.kind IS NULL THEN f.present ELSE p.present END AS present,
					CASE WHEN p.kind IS NULL THEN f.payload ELSE p.payload END AS payload
					FROM facts f LEFT JOIN pending_intents p
					ON p.kind=f.kind AND p.namespace=f.namespace AND p.local_key=f.local_key AND p.row_id=f.row_id
					WHERE f.kind='row' AND f.namespace=? AND f.local_key=? AND f.row_id=?`
				: `SELECT CASE WHEN p.kind IS NULL THEN f.present ELSE p.present END AS present,
					CASE WHEN p.kind IS NULL THEN f.payload ELSE p.payload END AS payload
					FROM facts f JOIN coordinates c USING(coordinate_id) LEFT JOIN pending_intents p
					ON p.kind=c.kind AND p.namespace=c.namespace AND p.local_key=c.local_key AND p.row_id=f.row_id
					WHERE c.kind='row' AND c.namespace=? AND c.local_key=? AND f.row_id=?`
			: candidate.coordinates === 'inline'
				? `SELECT CASE WHEN p.kind IS NULL THEN f.present ELSE p.present END AS present,
					CASE WHEN p.kind IS NULL THEN f.payload ELSE p.payload END AS payload
					FROM row_facts f LEFT JOIN pending_intents p
					ON p.kind='row' AND p.namespace=f.namespace AND p.local_key=f.local_key AND p.row_id=f.row_id
					WHERE f.namespace=? AND f.local_key=? AND f.row_id=?`
				: `SELECT CASE WHEN p.kind IS NULL THEN f.present ELSE p.present END AS present,
					CASE WHEN p.kind IS NULL THEN f.payload ELSE p.payload END AS payload
					FROM row_facts f JOIN coordinates c USING(coordinate_id) LEFT JOIN pending_intents p
					ON p.kind='row' AND p.namespace=c.namespace AND p.local_key=c.local_key AND p.row_id=f.row_id
					WHERE c.kind='row' AND c.namespace=? AND c.local_key=? AND f.row_id=?`;
	const overlay = prepare(overlaySql);
	const cleanupDocumentsSql =
		candidate.relation === 'unified'
			? candidate.coordinates === 'inline'
				? `DELETE FROM row_documents AS d WHERE EXISTS (
					SELECT 1 FROM facts f WHERE f.kind='row' AND f.present=0
					AND f.namespace=d.namespace AND f.local_key=d.table_key AND f.row_id=d.row_id)`
				: `DELETE FROM row_documents AS d WHERE EXISTS (
					SELECT 1 FROM facts f JOIN coordinates c USING(coordinate_id)
					WHERE c.kind='row' AND f.present=0 AND c.namespace=d.namespace
					AND c.local_key=d.table_key AND f.row_id=d.row_id)`
			: candidate.coordinates === 'inline'
				? `DELETE FROM row_documents AS d WHERE EXISTS (
					SELECT 1 FROM row_facts f WHERE f.present=0 AND f.namespace=d.namespace
					AND f.local_key=d.table_key AND f.row_id=d.row_id)`
				: `DELETE FROM row_documents AS d WHERE EXISTS (
					SELECT 1 FROM row_facts f JOIN coordinates c USING(coordinate_id)
					WHERE c.kind='row' AND f.present=0 AND c.namespace=d.namespace
					AND c.local_key=d.table_key AND f.row_id=d.row_id)`;
	const cleanupDocuments = prepare(cleanupDocumentsSql);

	const traversalSql =
		candidate.relation === 'unified'
			? candidate.coordinates === 'inline'
				? "SELECT row_id, present, payload, sequence FROM facts WHERE kind='row' AND namespace=? AND local_key=? ORDER BY row_id"
				: "SELECT f.row_id, f.present, f.payload, f.sequence FROM facts f JOIN coordinates c USING(coordinate_id) WHERE c.kind='row' AND c.namespace=? AND c.local_key=? ORDER BY f.row_id"
			: candidate.coordinates === 'inline'
				? 'SELECT row_id, present, payload, sequence FROM row_facts WHERE namespace=? AND local_key=? ORDER BY row_id'
				: "SELECT f.row_id, f.present, f.payload, f.sequence FROM row_facts f JOIN coordinates c USING(coordinate_id) WHERE c.kind='row' AND c.namespace=? AND c.local_key=? ORDER BY f.row_id";
	const traversal = prepare(traversalSql);

	const feedSql =
		candidate.relation === 'unified'
			? candidate.coordinates === 'inline'
				? 'SELECT kind, namespace, local_key, row_id, present, payload, sequence FROM facts WHERE sequence > ? ORDER BY sequence LIMIT ?'
				: 'SELECT c.kind, c.namespace, c.local_key, f.row_id, f.present, f.payload, f.sequence FROM facts f JOIN coordinates c USING(coordinate_id) WHERE f.sequence > ? ORDER BY f.sequence LIMIT ?'
			: candidate.coordinates === 'inline'
				? `SELECT 'row' AS kind, namespace, local_key, row_id, present, payload, sequence FROM row_facts WHERE sequence > ?
				UNION ALL
				SELECT 'value' AS kind, namespace, local_key, '' AS row_id, present, payload, sequence FROM value_facts WHERE sequence > ?
				ORDER BY sequence LIMIT ?`
				: `SELECT 'row' AS kind, c.namespace, c.local_key, f.row_id, f.present, f.payload, f.sequence FROM row_facts f JOIN coordinates c USING(coordinate_id) WHERE f.sequence > ?
				UNION ALL
				SELECT 'value' AS kind, c.namespace, c.local_key, '' AS row_id, f.present, f.payload, f.sequence FROM value_facts f JOIN coordinates c USING(coordinate_id) WHERE f.sequence > ?
				ORDER BY sequence LIMIT ?`;
	const feed = prepare(feedSql);

	function feedPage(
		after: number,
		limit: number,
	): Array<Record<string, unknown>> {
		return (
			candidate.relation === 'unified'
				? feed.all(after, limit)
				: feed.all(after, after, limit)
		) as Array<Record<string, unknown>>;
	}

	const semanticSql =
		candidate.relation === 'unified'
			? candidate.coordinates === 'inline'
				? 'SELECT kind, namespace, local_key, row_id, present, payload, sequence FROM facts ORDER BY kind, namespace, local_key, row_id'
				: 'SELECT c.kind, c.namespace, c.local_key, f.row_id, f.present, f.payload, f.sequence FROM facts f JOIN coordinates c USING(coordinate_id) ORDER BY c.kind, c.namespace, c.local_key, f.row_id'
			: candidate.coordinates === 'inline'
				? `SELECT * FROM (
				SELECT 'row' AS kind, namespace, local_key, row_id, present, payload, sequence FROM row_facts
				UNION ALL SELECT 'value', namespace, local_key, '', present, payload, sequence FROM value_facts
			) ORDER BY kind, namespace, local_key, row_id`
				: `SELECT * FROM (
				SELECT 'row' AS kind, c.namespace, c.local_key, f.row_id, f.present, f.payload, f.sequence FROM row_facts f JOIN coordinates c USING(coordinate_id)
				UNION ALL SELECT 'value', c.namespace, c.local_key, '', f.present, f.payload, f.sequence FROM value_facts f JOIN coordinates c USING(coordinate_id)
			) ORDER BY kind, namespace, local_key, row_id`;

	function semanticHash(): string {
		const hasher = new Bun.CryptoHasher('sha256');
		const statement = database.prepare(semanticSql);
		try {
			for (const row of statement.iterate()) {
				hasher.update(JSON.stringify(row));
				hasher.update('\n');
			}
		} finally {
			statement.finalize();
		}
		return hasher.digest('hex');
	}

	function count(): number {
		const sql =
			candidate.relation === 'unified'
				? 'SELECT count(*) AS count FROM facts'
				: 'SELECT (SELECT count(*) FROM row_facts) + (SELECT count(*) FROM value_facts) AS count';
		const statement = database.prepare(sql);
		try {
			return (statement.get() as { count: number }).count;
		} finally {
			statement.finalize();
		}
	}

	return {
		database,
		write,
		get,
		putPending(fact: Fact) {
			pendingUpsert.run(
				fact.kind,
				fact.namespace,
				fact.localKey,
				fact.rowId,
				fact.present,
				fact.payload,
			);
		},
		putParked(fact: Fact) {
			parkedUpsert.run(
				fact.kind,
				fact.namespace,
				fact.localKey,
				fact.rowId,
				'benchmark-fixture',
			);
		},
		putDocument(fact: Fact) {
			if (fact.kind !== 'row')
				throw new Error('documents require row addresses');
			documentUpsert.run(
				fact.namespace,
				fact.localKey,
				fact.rowId,
				new Uint8Array([1, 2, 3, 4]),
			);
		},
		readOverlay(fact: Fact) {
			if (fact.kind !== 'row')
				throw new Error('overlay benchmark expects a row');
			return overlay.get(fact.namespace, fact.localKey, fact.rowId);
		},
		cleanupTombstonedDocuments() {
			return cleanupDocuments.run().changes;
		},
		traverse(namespace: string, localKey: string) {
			return traversal.all(namespace, localKey);
		},
		feedPage,
		semanticHash,
		count,
		clearCoordinateCache() {
			coordinateCache.clear();
		},
		close() {
			for (const statement of prepared) statement.finalize();
			prepared.length = 0;
		},
		queryPlans: {
			point: typeof pointSql === 'string' ? pointSql : pointSql.row,
			traversal: traversalSql,
			feed: feedSql,
		},
	};
}

function withSavepoint(database: Database, run: () => void): void {
	database.exec('SAVEPOINT constraint_proof');
	try {
		run();
	} finally {
		database.exec('ROLLBACK TO constraint_proof');
		database.exec('RELEASE constraint_proof');
	}
}

function proveConstraints(
	store: ReturnType<typeof createStore>,
	candidate: Candidate,
): Record<string, boolean> {
	const baseRow: Fact = {
		kind: 'row',
		namespace: 'com.example.proof',
		localKey: 'records',
		rowId: '000000000000000000000001',
		present: 1,
		payload: '{"ok":true}',
		sequence: 1,
	};
	const baseValue: Fact = {
		kind: 'value',
		namespace: 'com.example.proof',
		localKey: 'setting',
		rowId: '',
		present: 1,
		payload: 'null',
		sequence: 2,
	};
	function rejects(run: () => void): boolean {
		let rejected = false;
		withSavepoint(store.database, () => {
			try {
				run();
			} catch {
				rejected = true;
			}
		});
		store.clearCoordinateCache();
		return rejected;
	}
	function accepts(run: () => void): boolean {
		return !rejects(run);
	}
	const proofs: Record<string, boolean> = {
		validRowObjectAccepted: accepts(() => store.write(baseRow, 'insert')),
		validValueJsonNullAccepted: accepts(() => store.write(baseValue, 'insert')),
		invalidRowIdRejected: rejects(() =>
			store.write({ ...baseRow, rowId: 'INVALID', sequence: 3 }, 'insert'),
		),
		blobNamespaceRejected: rejects(() =>
			store.write(
				{
					...baseRow,
					namespace: new Uint8Array([1, 2, 3]),
					sequence: 3,
				} as unknown as Fact,
				'insert',
			),
		),
		blobRowIdRejected: rejects(() =>
			store.write(
				{
					...baseRow,
					rowId: new Uint8Array(24),
					sequence: 3,
				} as unknown as Fact,
				'insert',
			),
		),
		blobPayloadRejected: rejects(() =>
			store.write(
				{
					...baseRow,
					payload: new Uint8Array([123, 125]),
					sequence: 3,
				} as unknown as Fact,
				'insert',
			),
		),
		rowScalarPayloadRejected: rejects(() =>
			store.write({ ...baseRow, payload: '7', sequence: 4 }, 'insert'),
		),
		absentPayloadRejected: rejects(() =>
			store.write(
				{ ...baseValue, present: 0, payload: 'null', sequence: 5 },
				'insert',
			),
		),
		unsafeSequenceRejected: rejects(() =>
			store.write({ ...baseRow, sequence: SAFE_SEQUENCE_MAX + 1 }, 'insert'),
		),
		duplicateAddressRejected: rejects(() => {
			store.write(baseRow, 'insert');
			store.write({ ...baseRow, sequence: 6 }, 'insert');
		}),
		duplicateSequenceRejected: rejects(() => {
			store.write(baseRow, 'insert');
			store.write({ ...baseValue, sequence: baseRow.sequence }, 'insert');
		}),
	};
	if (candidate.coordinates === 'normalized') {
		proofs.blobCoordinateIdRejected = rejects(() => {
			const statement = store.database.prepare(
				'INSERT INTO coordinates (coordinate_id, kind, namespace, local_key) VALUES (?, ?, ?, ?)',
			);
			try {
				statement.run(
					new Uint8Array([1]),
					'row',
					'com.example.proof',
					'records',
				);
			} finally {
				statement.finalize();
			}
		});
		proofs.referencedCoordinateUpdateRefused = rejects(() => {
			store.write(baseRow, 'insert');
			store.database.exec(
				"UPDATE coordinates SET namespace='com.example.changed' WHERE namespace='com.example.proof'",
			);
		});
		proofs.referencedCoordinateDeleteRefused = rejects(() => {
			store.write(baseRow, 'insert');
			store.database.exec(
				"DELETE FROM coordinates WHERE namespace='com.example.proof'",
			);
		});
	} else {
		proofs.coordinateRowsAbsent = true;
	}
	if (candidate.relation === 'split') {
		proofs.crossTableSequenceCollisionRejected =
			proofs.duplicateSequenceRejected === true;
	}
	return proofs;
}

function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const selected =
		sorted[
			Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
		];
	if (selected === undefined) throw new Error('percentile selection failed');
	return selected;
}

function summarize(rawMs: number[]): Samples {
	const mean =
		rawMs.length === 0
			? 0
			: rawMs.reduce((sum, value) => sum + value, 0) / rawMs.length;
	const variance =
		rawMs.length < 2
			? 0
			: rawMs.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
				(rawMs.length - 1);
	return {
		rawMs,
		p50Ms: percentile(rawMs, 0.5),
		p95Ms: percentile(rawMs, 0.95),
		p99Ms: percentile(rawMs, 0.99),
		coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / mean,
	};
}

function timed(run: () => void): number {
	const started = performance.now();
	run();
	return performance.now() - started;
}

function readOne<TRow>(database: Database, sql: string): TRow {
	const statement = database.prepare(sql);
	try {
		return statement.get() as TRow;
	} finally {
		statement.finalize();
	}
}

function storageMetrics(database: Database, path: string): StorageMetrics {
	const pageSize = readOne<{ page_size: number }>(
		database,
		'PRAGMA page_size',
	).page_size;
	const pageCount = readOne<{ page_count: number }>(
		database,
		'PRAGMA page_count',
	).page_count;
	const freelistCount = readOne<{ freelist_count: number }>(
		database,
		'PRAGMA freelist_count',
	).freelist_count;
	const fileSize = (filePath: string) =>
		existsSync(filePath) ? statSync(filePath).size : 0;
	return {
		pageSize,
		pageCount,
		freelistCount,
		allocatedBytes: pageSize * pageCount,
		liveBytes: pageSize * (pageCount - freelistCount),
		databaseFileBytes: fileSize(path),
	};
}

function walBytes(path: string): number {
	return existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
}

function truncateWal(database: Database): void {
	database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

function explain(
	database: Database,
	sql: string,
	candidate: Candidate,
): unknown[] {
	const bindingCount = (sql.match(/\?/g) ?? []).length;
	const bindings =
		candidate.relation === 'split' && sql.includes('UNION ALL')
			? [0, 0, 256]
			: bindingCount === 4
				? ['row', 'com.example.app0', 'records0', '000000000000000000000000']
				: bindingCount === 3
					? ['com.example.app0', 'records0', '000000000000000000000000']
					: bindingCount === 2 && sql.includes('LIMIT')
						? [0, 256]
						: ['com.example.app0', 'records0'];
	const statement = database.prepare(`EXPLAIN QUERY PLAN ${sql}`);
	try {
		return statement.all(...(bindings as SQLQueryBindings[]));
	} finally {
		statement.finalize();
	}
}

function closeForCleanup(database: Database): void {
	try {
		database.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
		database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	} finally {
		database.close();
	}
}

function runOne(
	owner: Owner,
	candidate: Candidate,
	repetition: number,
	options: Options,
): RunResult {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-scalar-layout-'));
	const path = join(directory, `${owner}-${candidate.id}-${repetition}.sqlite`);
	const ddl = ddlFor(candidate);
	const ddlHash = sha256(ddl);
	let database: Database | undefined;
	let reopened: Database | undefined;
	let closeStore: (() => void) | undefined;
	let closeReopenedStore: (() => void) | undefined;
	try {
		database = new Database(path, { create: true, strict: true });
		const activeDatabase = database;
		configureNewDatabase(activeDatabase);
		activeDatabase.exec(ddl);
		activeDatabase.exec(FIXTURE_DDL);
		const store = createStore(activeDatabase, candidate);
		closeStore = store.close;
		const proofs = proveConstraints(store, candidate);
		if (Object.values(proofs).some((proof) => !proof)) {
			throw new Error(`constraint proof failed: ${JSON.stringify(proofs)}`);
		}

		const targetPerPresent = Math.max(
			8,
			Math.floor(options.payloadBytes / options.facts),
		);
		const values = valueCount(options.facts);
		const rows = options.facts - values;
		const rewriteCount = Math.max(1, Math.floor(options.facts * 0.1));
		const tombstoneCount = Math.max(1, Math.floor(rows * 0.05));
		const unsetValueCount = Math.max(1, Math.floor(values * 0.01));
		const acquisitionBatchSize = owner === 'replica' ? 512 : 128;
		const datasetMix = {
			namespaces: NAMESPACE_COUNT,
			tableKeysPerNamespace: TABLE_COUNT,
			rowCoordinatePrefixes: NAMESPACE_COUNT * TABLE_COUNT,
			rowFacts: rows,
			valueFacts: values,
			initiallyPresent: options.facts,
			agedRewrites: rewriteCount,
			rowTombstones: tombstoneCount,
			valueUnsets: unsetValueCount,
			acquisitionBatchSize,
			acquisitionTransactions: Math.ceil(options.facts / acquisitionBatchSize),
		};
		const walDiagnostics: Record<string, number> = {};
		const buildSamples: number[] = [];
		let logicalPayloadBytes = 0;
		truncateWal(activeDatabase);
		const installAcquisitionBatch = activeDatabase.transaction(
			(facts: Fact[]) => {
				for (const fact of facts) store.write(fact);
			},
		);
		for (let start = 0; start < options.facts; start += acquisitionBatchSize) {
			const batch: Fact[] = [];
			const end = Math.min(options.facts, start + acquisitionBatchSize);
			for (let index = start; index < end; index += 1) {
				const fact = initialFact(index, options, targetPerPresent);
				logicalPayloadBytes += Buffer.byteLength(fact.payload ?? '');
				batch.push(fact);
			}
			buildSamples.push(timed(() => installAcquisitionBatch(batch)));
		}
		walDiagnostics.buildPostPhaseBytes = walBytes(path);
		if (store.count() !== options.facts) {
			throw new Error(`build count mismatch: expected ${options.facts}`);
		}

		let nextSequence = options.facts + 1;
		const agedTombstones = new Set<number>();
		const rowIndex = (ordinal: number, salt: number) =>
			values + permutationAt(ordinal % rows, rows, options.dataSeed ^ salt);
		const liveRowIndex = (ordinal: number, salt: number) => {
			let candidateIndex = rowIndex(ordinal, salt);
			while (agedTombstones.has(candidateIndex)) {
				candidateIndex = values + ((candidateIndex - values + 1) % rows);
			}
			return candidateIndex;
		};
		truncateWal(activeDatabase);
		const age = activeDatabase.transaction(() => {
			for (let ordinal = 0; ordinal < rewriteCount; ordinal += 1) {
				const index = permutationAt(
					ordinal,
					options.facts,
					options.dataSeed ^ 0x5257_5254,
				);
				store.write({
					...addressAt(index, options.facts, options.dataSeed),
					present: 1,
					payload: makePayload(
						index,
						options.facts,
						options.dataSeed,
						targetPerPresent,
						1,
					),
					sequence: nextSequence++,
				});
			}
			for (let ordinal = 0; ordinal < tombstoneCount; ordinal += 1) {
				const index = rowIndex(ordinal, 0x544f_4d42);
				agedTombstones.add(index);
				store.write({
					...addressAt(index, options.facts, options.dataSeed),
					present: 0,
					payload: null,
					sequence: nextSequence++,
				});
			}
			for (let ordinal = 0; ordinal < unsetValueCount; ordinal += 1) {
				const index = permutationAt(
					ordinal,
					values,
					options.dataSeed ^ 0x554e_5345,
				);
				store.write({
					...addressAt(index, options.facts, options.dataSeed),
					present: 0,
					payload: null,
					sequence: nextSequence++,
				});
			}
		});
		age();
		walDiagnostics.agePostPhaseBytes = walBytes(path);
		activeDatabase.exec('ANALYZE');
		truncateWal(activeDatabase);

		function sameState(
			left: Fact,
			right: NonNullable<ReturnType<typeof store.get>>,
		) {
			return left.present === right.present && left.payload === right.payload;
		}
		function installConfirmed(
			fact: Fact,
		): 'written' | 'stale' | 'identical' | 'terminal' {
			const current = store.get(fact);
			if (current === null) {
				store.write(fact);
				return 'written';
			}
			if (fact.sequence < current.sequence) return 'stale';
			if (fact.sequence === current.sequence) {
				if (!sameState(fact, current))
					throw new Error('equal sequence carried different fact state');
				return 'identical';
			}
			if (fact.kind === 'row' && current.present === 0) return 'terminal';
			store.write(fact);
			return 'written';
		}

		const valueProbe = initialFact(0, options, targetPerPresent);
		installConfirmed({ ...valueProbe, present: 1, sequence: nextSequence++ });
		installConfirmed({
			...valueProbe,
			present: 0,
			payload: null,
			sequence: nextSequence++,
		});
		installConfirmed({
			...valueProbe,
			present: 1,
			payload: makePayload(
				0,
				options.facts,
				options.dataSeed,
				targetPerPresent,
				9,
			),
			sequence: nextSequence++,
		});
		proofs.valuePresentAbsentPresent = store.get(valueProbe)?.present === 1;
		const terminalIndex = liveRowIndex(tombstoneCount + 3, 0x5052_4f42);
		const terminalProbe = initialFact(terminalIndex, options, targetPerPresent);
		installConfirmed({
			...terminalProbe,
			present: 0,
			payload: null,
			sequence: nextSequence++,
		});
		installConfirmed({ ...terminalProbe, sequence: nextSequence++ });
		proofs.rowTombstoneNonResurrection =
			store.get(terminalProbe)?.present === 0;
		agedTombstones.add(terminalIndex);

		const rollbackProbe = valueProbe;
		const corruptProbe = initialFact(
			liveRowIndex(tombstoneCount + 10, 0x524f_4c4c),
			options,
			targetPerPresent,
		);
		const corruptCurrent = store.get(corruptProbe);
		if (corruptCurrent === null) throw new Error('corruption probe missing');
		const rollbackBefore = store.get(rollbackProbe);
		proofs.atomicEqualDifferentRefused = false;
		try {
			activeDatabase.transaction(() => {
				installConfirmed({
					...rollbackProbe,
					present: 1,
					payload: makePayload(
						0,
						options.facts,
						options.dataSeed,
						targetPerPresent,
						13,
					),
					sequence: nextSequence++,
				});
				installConfirmed({
					...corruptProbe,
					payload: '{"corrupt":true}',
					sequence: corruptCurrent.sequence,
				});
			})();
		} catch {
			proofs.atomicEqualDifferentRefused = true;
		}
		proofs.atomicEqualDifferentRolledBack =
			JSON.stringify(store.get(rollbackProbe)) ===
			JSON.stringify(rollbackBefore);

		const metrics: Record<string, Samples> = {};
		const workloadMix = {
			transactions: 0,
			batchSize: ADDRESS_BATCH,
			rowAddresses: 0,
			valueAddresses: 0,
			targetValueFraction: VALUE_RATIO,
			observedValueFraction: 0,
		};
		function isValueWorkloadOrdinal(
			ordinal: number,
			totalAddresses: number,
			targetValues: number,
		): boolean {
			return (
				Math.floor(((ordinal + 1) * targetValues) / totalAddresses) >
				Math.floor((ordinal * targetValues) / totalAddresses)
			);
		}
		truncateWal(activeDatabase);
		if (owner === 'replica') {
			metrics.acquisition = summarize(buildSamples);
			const installSamples: number[] = [];
			const transactionCount = Math.max(
				1,
				Math.ceil(options.steadyWrites / ADDRESS_BATCH),
			);
			const totalAddresses = transactionCount * ADDRESS_BATCH;
			const targetValues = Math.max(
				1,
				Math.round(totalAddresses * VALUE_RATIO),
			);
			for (
				let transaction = 0;
				transaction < transactionCount;
				transaction += 1
			) {
				const mixed: Fact[] = [];
				const usedRows = new Set<number>();
				let rowCursor = 0;
				for (let item = 0; item < ADDRESS_BATCH; item += 1) {
					const ordinal = transaction * ADDRESS_BATCH + item;
					if (isValueWorkloadOrdinal(ordinal, totalAddresses, targetValues)) {
						const valueIndex = workloadMix.valueAddresses % values;
						mixed.push({
							...initialFact(valueIndex, options, targetPerPresent),
							payload: makePayload(
								valueIndex,
								options.facts,
								options.dataSeed,
								targetPerPresent,
								12 + transaction,
							),
							sequence: nextSequence++,
						});
						workloadMix.valueAddresses += 1;
						continue;
					}
					let index: number;
					do {
						index = liveRowIndex(
							tombstoneCount + 100 + transaction * ADDRESS_BATCH + rowCursor,
							0x494e_5354,
						);
						rowCursor += 1;
					} while (usedRows.has(index));
					usedRows.add(index);
					const probe = initialFact(index, options, targetPerPresent);
					const current = store.get(probe);
					if (current === null) throw new Error('install probe missing');
					const mode = ordinal % 3;
					mixed.push(
						mode === 0
							? { ...probe, sequence: nextSequence++ }
							: mode === 1
								? { ...probe, sequence: Math.max(1, current.sequence - 1) }
								: {
										...probe,
										sequence: current.sequence,
										present: current.present,
										payload: current.payload,
									},
					);
					workloadMix.rowAddresses += 1;
				}
				installSamples.push(
					timed(() =>
						activeDatabase.transaction(() => {
							for (const fact of mixed) installConfirmed(fact);
						})(),
					),
				);
				workloadMix.transactions += 1;
			}
			metrics.monotonicFactInstall = summarize(installSamples);
			walDiagnostics.monotonicInstallPostPhaseBytes = walBytes(path);
			truncateWal(activeDatabase);
			const pointSamples: number[] = [];
			for (let sample = 0; sample < options.pointReads; sample += 1) {
				const fact = initialFact(
					hash32(options.dataSeed, sample) % options.facts,
					options,
					targetPerPresent,
				);
				pointSamples.push(
					timed(() => {
						if (store.get(fact) === null)
							throw new Error('confirmed point miss');
					}),
				);
			}
			metrics.confirmedPointRead = summarize(pointSamples);
			const traversalSamples: number[] = [];
			for (let sample = 0; sample < options.traversals; sample += 1) {
				const fact = initialFact(
					rowIndex(sample, 0x5452_4156),
					options,
					targetPerPresent,
				);
				traversalSamples.push(
					timed(() => store.traverse(fact.namespace, fact.localKey)),
				);
			}
			metrics.confirmedTableTraversal = summarize(traversalSamples);
			const overlayFacts: Fact[] = [];
			for (let item = 0; item < ADDRESS_BATCH; item += 1) {
				const fact = initialFact(
					rowIndex(tombstoneCount + 500 + item, 0x4f56_4552),
					options,
					targetPerPresent,
				);
				store.putPending({
					...fact,
					payload: makePayload(
						item,
						options.facts,
						options.dataSeed,
						targetPerPresent,
						11,
					),
				});
				if (item % 8 === 0) store.putParked(fact);
				overlayFacts.push(fact);
			}
			metrics.confirmedPendingOverlayRead = summarize(
				overlayFacts.map((fact) =>
					timed(() => {
						if (store.readOverlay(fact) === null)
							throw new Error('overlay miss');
					}),
				),
			);
			const cleanupSamples: number[] = [];
			for (
				let sample = 0;
				sample < Math.max(1, options.traversals);
				sample += 1
			) {
				const fact = initialFact(
					liveRowIndex(tombstoneCount + 700 + sample, 0x444f_4353),
					options,
					targetPerPresent,
				);
				cleanupSamples.push(
					timed(() =>
						activeDatabase.transaction(() => {
							store.putDocument(fact);
							installConfirmed({
								...fact,
								present: 0,
								payload: null,
								sequence: nextSequence++,
							});
							if (store.cleanupTombstonedDocuments() < 1)
								throw new Error('document cleanup missed tombstone');
						})(),
					),
				);
			}
			metrics.rowTombstoneDocumentCleanup = summarize(cleanupSamples);
			walDiagnostics.livenessPostPhaseBytes = walBytes(path);
		} else {
			const freshSamples: number[] = [];
			let after = 0;
			let feedRows = 0;
			for (;;) {
				let page: Array<Record<string, unknown>> = [];
				freshSamples.push(
					timed(() => {
						page = store.feedPage(after, options.feedPageSize);
					}),
				);
				if (page.length === 0) break;
				feedRows += page.length;
				const sequence = page.at(-1)?.sequence;
				if (typeof sequence !== 'number' || sequence <= after)
					throw new Error('fresh feed failed to advance');
				after = sequence;
			}
			if (feedRows !== options.facts)
				throw new Error('fresh feed count mismatch');
			metrics.orderedFreshFeed = summarize(freshSamples);
			const resumeAfter = Math.floor(nextSequence / 2);
			metrics.orderedResumeFeed = summarize(
				Array.from({ length: Math.max(3, options.traversals) }, () =>
					timed(() => store.feedPage(resumeAfter, options.feedPageSize)),
				),
			);
			const submissionSamples: number[] = [];
			let retryFacts: Fact[] = [];
			const totalAddresses = options.submissions * ADDRESS_BATCH;
			const targetValues = Math.max(
				1,
				Math.round(totalAddresses * VALUE_RATIO),
			);
			for (
				let submission = 0;
				submission < options.submissions;
				submission += 1
			) {
				retryFacts = [];
				const used = new Set<number>();
				let rowCursor = 0;
				for (let item = 0; item < ADDRESS_BATCH; item += 1) {
					const ordinal = submission * ADDRESS_BATCH + item;
					if (isValueWorkloadOrdinal(ordinal, totalAddresses, targetValues)) {
						const valueIndex = workloadMix.valueAddresses % values;
						retryFacts.push({
							...initialFact(valueIndex, options, targetPerPresent),
							payload: makePayload(
								valueIndex,
								options.facts,
								options.dataSeed,
								targetPerPresent,
								20 + submission,
							),
							sequence: nextSequence++,
						});
						workloadMix.valueAddresses += 1;
						continue;
					}
					let index: number;
					do {
						index = liveRowIndex(
							tombstoneCount + 1000 + submission * ADDRESS_BATCH + rowCursor,
							0x5355_424d,
						);
						rowCursor += 1;
					} while (used.has(index));
					used.add(index);
					retryFacts.push({
						...initialFact(index, options, targetPerPresent),
						sequence: nextSequence++,
					});
					workloadMix.rowAddresses += 1;
				}
				submissionSamples.push(
					timed(() =>
						activeDatabase.transaction(() => {
							for (const fact of retryFacts) installConfirmed(fact);
							for (const fact of retryFacts)
								if (store.get(fact) === null)
									throw new Error('settlement miss');
						})(),
					),
				);
				workloadMix.transactions += 1;
			}
			metrics.submission64WriteSettlement = summarize(submissionSamples);
			walDiagnostics.submissionPostPhaseBytes = walBytes(path);
			metrics.foldPointRead = summarize(
				Array.from({ length: options.pointReads }, (_, sample) => {
					const fact = initialFact(
						hash32(options.dataSeed ^ 0x464f_4c44, sample) % options.facts,
						options,
						targetPerPresent,
					);
					return timed(() => {
						if (store.get(fact) === null) throw new Error('fold point miss');
					});
				}),
			);
			const changesBeforeRetry = readOne<{ changes: number }>(
				activeDatabase,
				'SELECT total_changes() AS changes',
			).changes;
			metrics.exactRetrySettlementRead = summarize(
				Array.from({ length: Math.max(3, options.traversals) }, () =>
					timed(() => {
						for (const fact of retryFacts)
							if (store.get(fact) === null)
								throw new Error('retry settlement miss');
					}),
				),
			);
			proofs.exactRetryPerformsNoWrites =
				readOne<{ changes: number }>(
					activeDatabase,
					'SELECT total_changes() AS changes',
				).changes === changesBeforeRetry;
		}
		workloadMix.observedValueFraction =
			workloadMix.valueAddresses /
			(workloadMix.rowAddresses + workloadMix.valueAddresses);

		const plans = Object.fromEntries(
			Object.entries(store.queryPlans).map(([name, sql]) => [
				name,
				explain(activeDatabase, sql, candidate),
			]),
		);
		if (candidate.relation === 'split') {
			const feedPlan = plans.feed;
			if (feedPlan === undefined) throw new Error('split feed plan is missing');
			const details = feedPlan.map((row) =>
				String((row as { detail?: unknown }).detail ?? ''),
			);
			proofs.splitFeedUsesMerge = details.some((detail) =>
				detail.includes('MERGE'),
			);
			proofs.splitFeedIsDirectCompound =
				!store.queryPlans.feed.includes('SELECT * FROM (');
			proofs.splitFeedAvoidsTempBtree = details.every(
				(detail) => !detail.includes('USE TEMP B-TREE'),
			);
			if (
				!proofs.splitFeedUsesMerge ||
				!proofs.splitFeedAvoidsTempBtree ||
				!proofs.splitFeedIsDirectCompound
			) {
				throw new Error(
					`split feed plan is not merge-only: ${JSON.stringify(details)}`,
				);
			}
		}
		if (Object.values(proofs).some((proof) => !proof))
			throw new Error(`semantic proof failed: ${JSON.stringify(proofs)}`);
		const semanticHash = store.semanticHash();
		const storage = storageMetrics(activeDatabase, path);
		walDiagnostics.maximumPostPhaseBytes = Math.max(
			...Object.values(walDiagnostics),
			0,
		);
		const integrity = readOne<{ integrity_check: string }>(
			activeDatabase,
			'PRAGMA integrity_check',
		);
		if (integrity.integrity_check !== 'ok')
			throw new Error(`integrity_check: ${integrity.integrity_check}`);
		store.close();
		closeStore = undefined;
		closeForCleanup(activeDatabase);
		database = undefined;
		let reopenedStore: ReturnType<typeof createStore> | undefined;
		const reopenProbe = initialFact(0, options, targetPerPresent);
		const reopenSamples = [
			timed(() => {
				reopened = new Database(path, { strict: true });
				const activeReopened = reopened;
				configureReopenedDatabase(activeReopened);
				const schema = readOne<{ count: number }>(
					activeReopened,
					"SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('facts','row_facts','value_facts','pending_intents','parked_work','row_documents')",
				);
				if (schema.count < 4)
					throw new Error('schema validation failed during reopen');
				reopenedStore = createStore(activeReopened, candidate);
				closeReopenedStore = reopenedStore.close;
				if (reopenedStore.get(reopenProbe) === null)
					throw new Error('warm reopen point read failed');
			}),
		];
		if (reopenedStore === undefined || reopened === undefined) {
			throw new Error('reopen did not create a store');
		}
		metrics.warmReopen = summarize(reopenSamples);
		if (reopenedStore.count() !== options.facts)
			throw new Error('reopen count mismatch');
		const reopenedSemanticHash = reopenedStore.semanticHash();
		const reopenedIntegrity = readOne<{ integrity_check: string }>(
			reopened,
			'PRAGMA integrity_check',
		);
		const correct =
			reopenedIntegrity.integrity_check === 'ok' &&
			semanticHash === reopenedSemanticHash &&
			Object.values(proofs).every(Boolean);
		const result: RunResult = {
			owner,
			candidate,
			repetition,
			dataSeed: options.dataSeed,
			correct,
			proofs,
			metrics,
			storage,
			walDiagnostics,
			queryPlans: plans,
			integrityCheck: reopenedIntegrity.integrity_check,
			semanticHash,
			reopenedSemanticHash,
			logicalPayloadBytes,
			currentFacts: options.facts,
			datasetMix,
			workloadMix,
			ddlHash,
		};
		reopenedStore.close();
		closeReopenedStore = undefined;
		return result;
	} catch (error) {
		return {
			owner,
			candidate,
			repetition,
			dataSeed: options.dataSeed,
			correct: false,
			proofs: {},
			metrics: {},
			storage: {
				pageSize: 0,
				pageCount: 0,
				freelistCount: 0,
				allocatedBytes: 0,
				liveBytes: 0,
				databaseFileBytes: 0,
			},
			walDiagnostics: {},
			queryPlans: {},
			integrityCheck: 'failed',
			semanticHash: '',
			reopenedSemanticHash: '',
			logicalPayloadBytes: 0,
			currentFacts: 0,
			datasetMix: {},
			workloadMix: {},
			ddlHash,
			error:
				error instanceof Error ? (error.stack ?? error.message) : String(error),
		};
	} finally {
		try {
			closeStore?.();
		} catch {
			// Database close and recursive removal below remain authoritative.
		}
		try {
			closeReopenedStore?.();
		} catch {
			// Database close and recursive removal below remain authoritative.
		}
		if (database !== undefined) {
			try {
				closeForCleanup(database);
			} catch {
				// The recursive temporary-directory cleanup below remains authoritative.
			}
		}
		if (reopened !== undefined) {
			try {
				closeForCleanup(reopened);
			} catch {
				// The recursive temporary-directory cleanup below remains authoritative.
			}
		}
		rmSync(directory, { recursive: true, force: true });
	}
}

const LATENCY_MATERIALITY = 0.1;
const STORAGE_MATERIALITY = 0.05;
const LATENCY_PAIRED_LOG_RATIO_SD_LIMIT = 0.1;
const STORAGE_PAIRED_LOG_RATIO_SD_LIMIT = 0.05;

function recommendations(results: RunResult[], options: Options) {
	function candidateById(id: string): Candidate {
		const found = CANDIDATES.find((candidate) => candidate.id === id);
		if (found === undefined) throw new Error(`unknown candidate: ${id}`);
		return found;
	}
	function cv(values: number[]): number {
		if (values.length < 2) return 0;
		const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
		if (mean === 0) return 0;
		const variance =
			values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
			(values.length - 1);
		return Math.sqrt(variance) / mean;
	}
	function sampleStandardDeviation(values: number[]): number {
		if (values.length < 2) return 0;
		const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
		const variance =
			values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
			(values.length - 1);
		return Math.sqrt(variance);
	}
	const allExpectedCellsPass =
		results.length === 2 * CANDIDATES.length * options.repetitions &&
		(['replica', 'authority'] as const).every((owner) =>
			CANDIDATES.every((candidate) =>
				Array.from({ length: options.repetitions }, (_, repetition) =>
					results.filter(
						(result) =>
							result.owner === owner &&
							result.candidate.id === candidate.id &&
							result.repetition === repetition,
					),
				).every((cell) => cell.length === 1 && cell[0]?.correct === true),
			),
		);
	return (['replica', 'authority'] as const).map((owner) => {
		const critical =
			owner === 'replica'
				? [...REPLICA_CRITICAL_METRICS]
				: [...AUTHORITY_CRITICAL_METRICS];
		const ownerResults = results.filter((result) => result.owner === owner);
		const hasEveryCell =
			allExpectedCellsPass &&
			ownerResults.length === CANDIDATES.length * options.repetitions &&
			CANDIDATES.every((candidate) =>
				Array.from({ length: options.repetitions }, (_, repetition) =>
					ownerResults.filter(
						(result) =>
							result.candidate.id === candidate.id &&
							result.repetition === repetition,
					),
				).every(
					(cell) =>
						cell.length === 1 &&
						cell[0]?.correct === true &&
						critical.every((metric) => cell[0]?.metrics[metric] !== undefined),
				),
			);
		// This harness exercises Bun's native SQLite only. A full run can support a
		// native recommendation, but cannot freeze the browser or Cloudflare format.
		const provisional = true;
		const evidenceScope = 'bun-native-sqlite';
		const requiresBrowserEvidence = owner === 'replica';
		const requiresCloudflareEvidence = owner === 'authority';
		if (!hasEveryCell) {
			return {
				owner,
				provisional,
				evidenceScope,
				requiresBrowserEvidence,
				requiresCloudflareEvidence,
				recommendation: null,
				reason:
					'missing or failed owner×candidate×repetition cell anywhere in the matrix; partial evidence cannot recommend',
				criticalMetrics: critical,
				aggregates: [],
			};
		}
		const effectiveMateriality = Object.fromEntries(
			critical.map((metric) => [metric, LATENCY_MATERIALITY]),
		) as Record<string, number>;
		const effectiveStorageMateriality = STORAGE_MATERIALITY;
		const aggregates = CANDIDATES.map((candidate) => {
			const runs = ownerResults.filter(
				(run) => run.candidate.id === candidate.id,
			);
			return {
				id: candidate.id,
				runs: runs.length,
				critical: Object.fromEntries(
					critical.map((metric) => {
						const p95ByRepetition = runs.map(
							(run) => run.metrics[metric]?.p95Ms ?? Number.POSITIVE_INFINITY,
						);
						return [
							metric,
							{
								meanP95Ms:
									p95ByRepetition.reduce((sum, value) => sum + value, 0) /
									p95ByRepetition.length,
								p95ByRepetition,
								betweenRepetitionCv: cv(p95ByRepetition),
								withinRepetitionCv: runs.map(
									(run) => run.metrics[metric]?.coefficientOfVariation ?? 0,
								),
								repetitions: runs.map((run) => ({
									repetition: run.repetition,
									dataSeed: run.dataSeed,
									p95Ms: run.metrics[metric]?.p95Ms ?? Number.POSITIVE_INFINITY,
									coefficientOfVariation:
										run.metrics[metric]?.coefficientOfVariation ?? 0,
								})),
							},
						];
					}),
				) as Record<string, { meanP95Ms: number }>,
				liveBytes: {
					mean:
						runs.reduce((sum, run) => sum + run.storage.liveBytes, 0) /
						runs.length,
					byRepetition: runs.map((run) => run.storage.liveBytes),
					betweenRepetitionCv: cv(runs.map((run) => run.storage.liveBytes)),
				},
			};
		});
		function criticalValue(
			aggregate: (typeof aggregates)[number],
			metric: string,
		): number {
			const found = aggregate.critical[metric];
			if (found === undefined)
				throw new Error(`missing aggregate metric: ${metric}`);
			return found.meanP95Ms;
		}
		function materiality(metric: string): number {
			const found = effectiveMateriality[metric];
			if (found === undefined)
				throw new Error(`missing materiality: ${metric}`);
			return found;
		}
		function resultFor(candidateId: string, repetition: number): RunResult {
			const found = ownerResults.find(
				(run) =>
					run.candidate.id === candidateId && run.repetition === repetition,
			);
			if (found === undefined) {
				throw new Error(
					`missing ${owner}/${candidateId} repetition ${repetition}`,
				);
			}
			return found;
		}
		const pairedStability = CANDIDATES.flatMap((left, leftIndex) =>
			CANDIDATES.slice(leftIndex + 1).map((right) => ({
				left: left.id,
				right: right.id,
				critical: Object.fromEntries(
					critical.map((metric) => [
						metric,
						sampleStandardDeviation(
							Array.from({ length: options.repetitions }, (_, repetition) => {
								const leftValue = resultFor(left.id, repetition).metrics[metric]
									?.p95Ms;
								const rightValue = resultFor(right.id, repetition).metrics[
									metric
								]?.p95Ms;
								if (leftValue === undefined || rightValue === undefined) {
									throw new Error(`missing paired metric: ${metric}`);
								}
								return Math.log(leftValue / rightValue);
							}),
						),
					]),
				) as Record<string, number>,
				liveBytesLogRatioSd: sampleStandardDeviation(
					Array.from({ length: options.repetitions }, (_, repetition) => {
						const leftBytes = resultFor(left.id, repetition).storage.liveBytes;
						const rightBytes = resultFor(right.id, repetition).storage
							.liveBytes;
						return Math.log(leftBytes / rightBytes);
					}),
				),
			})),
		);
		const unstableComparisons = pairedStability.filter(
			(pair) =>
				Object.values(pair.critical).some(
					(logRatioSd) => logRatioSd > LATENCY_PAIRED_LOG_RATIO_SD_LIMIT,
				) || pair.liveBytesLogRatioSd > STORAGE_PAIRED_LOG_RATIO_SD_LIMIT,
		);
		if (unstableComparisons.length > 0) {
			return {
				owner,
				provisional,
				evidenceScope,
				requiresBrowserEvidence,
				requiresCloudflareEvidence,
				recommendation: null,
				reason:
					'paired candidate log-ratio dispersion exceeds the predeclared stability limit; add repetitions instead of widening equivalence',
				criticalMetrics: critical,
				effectiveMateriality,
				effectiveStorageMateriality,
				pairedStability,
				unstableComparisons,
				aggregates,
			};
		}
		function noRegression(
			left: (typeof aggregates)[number],
			right: (typeof aggregates)[number],
		) {
			return (
				critical.every(
					(metric) =>
						criticalValue(left, metric) <=
						criticalValue(right, metric) * (1 + materiality(metric)),
				) &&
				left.liveBytes.mean <=
					right.liveBytes.mean * (1 + effectiveStorageMateriality)
			);
		}
		function materiallyBetter(
			left: (typeof aggregates)[number],
			right: (typeof aggregates)[number],
		) {
			return (
				critical.some(
					(metric) =>
						criticalValue(left, metric) * (1 + materiality(metric)) <
						criticalValue(right, metric),
				) ||
				left.liveBytes.mean * (1 + effectiveStorageMateriality) <
					right.liveBytes.mean
			);
		}
		const candidatePool = aggregates.filter(
			(candidate) =>
				!aggregates.some(
					(other) =>
						other.id !== candidate.id &&
						noRegression(other, candidate) &&
						materiallyBetter(other, candidate),
				),
		);
		const allEquivalent = candidatePool.every((left) =>
			candidatePool.every(
				(right) => noRegression(left, right) && noRegression(right, left),
			),
		);
		if (candidatePool.length > 1 && !allEquivalent) {
			return {
				owner,
				provisional,
				evidenceScope,
				requiresBrowserEvidence,
				requiresCloudflareEvidence,
				recommendation: null,
				reason:
					'unresolved Pareto tradeoff across owner-critical metrics or live bytes',
				unresolvedCandidates: candidatePool.map((candidate) => candidate.id),
				criticalMetrics: critical,
				effectiveMateriality,
				effectiveStorageMateriality,
				pairedStability,
				aggregates,
			};
		}
		candidatePool.sort((left, right) => {
			const leftCandidate = candidateById(left.id);
			const rightCandidate = candidateById(right.id);
			// Predeclared spec tie-break: direct one-index global sequence uniqueness,
			// fewer relations/indexes/feed branches, then fewer mixed-shape clauses.
			if (leftCandidate.relation !== rightCandidate.relation) {
				return leftCandidate.relation === 'unified' ? -1 : 1;
			}
			if (leftCandidate.coordinates !== rightCandidate.coordinates) {
				return leftCandidate.coordinates === 'inline' ? -1 : 1;
			}
			return 0;
		});
		const recommendation = candidatePool[0];
		if (recommendation === undefined) {
			throw new Error(`no recommendation candidate remained for ${owner}`);
		}
		return {
			owner,
			provisional,
			evidenceScope,
			requiresBrowserEvidence,
			requiresCloudflareEvidence,
			recommendation: recommendation.id,
			reason:
				candidatePool.length > 1
					? 'all owner-critical metrics and live bytes are materially equivalent; applied ADR tie-break order'
					: 'sole non-dominated candidate with no material regression in any owner-critical metric',
			criticalMetrics: critical,
			effectiveMateriality,
			effectiveStorageMateriality,
			pairedStability,
			aggregates,
		};
	});
}

function readEnvironment() {
	const probeDirectory = mkdtempSync(join(tmpdir(), 'epicenter-sqlite-probe-'));
	const path = join(probeDirectory, 'probe.sqlite');
	const database = new Database(path, { create: true, strict: true });
	try {
		const compileOptions = database.prepare('PRAGMA compile_options');
		let values: unknown[][];
		try {
			values = compileOptions.values();
		} finally {
			compileOptions.finalize();
		}
		return {
			bunVersion: Bun.version,
			platform: platform(),
			osRelease: release(),
			arch: process.arch,
			cpu: cpus()[0]?.model ?? 'unknown',
			cpuCount: cpus().length,
			sqliteVersion: readOne<{ version: string }>(
				database,
				'SELECT sqlite_version() AS version',
			).version,
			compileOptions: values.flat(),
		};
	} finally {
		database.close();
		rmSync(probeDirectory, { recursive: true, force: true });
	}
}

function main(): void {
	let options: Options | null;
	try {
		options = parseOptions(Bun.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error('\nRun with --help for usage.');
		process.exitCode = 1;
		return;
	}
	if (options === null) {
		console.log(HELP);
		return;
	}
	let temporarySpace: ReturnType<typeof checkTemporarySpace>;
	try {
		temporarySpace = checkTemporarySpace(options);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return;
	}

	const startedAt = new Date().toISOString();
	const started = performance.now();
	const results: RunResult[] = [];
	const runOrder: Array<{
		owner: Owner;
		candidate: Candidate;
		repetition: number;
	}> = [];
	for (const owner of ['replica', 'authority'] as const) {
		for (
			let repetition = 0;
			repetition < options.repetitions;
			repetition += 1
		) {
			const ordered = shuffle(
				CANDIDATES,
				hash32(options.orderSeed ^ (owner === 'replica' ? 1 : 2), repetition),
			);
			for (const candidate of ordered)
				runOrder.push({ owner, candidate, repetition });
		}
	}
	for (const run of runOrder) {
		console.error(
			`[${run.owner}] ${run.candidate.id} repetition ${run.repetition + 1}/${options.repetitions}`,
		);
		results.push(
			runOne(run.owner, run.candidate, run.repetition, {
				...options,
				dataSeed: hash32(options.dataSeed, run.repetition),
			}),
		);
	}
	for (const owner of ['replica', 'authority'] as const) {
		for (
			let repetition = 0;
			repetition < options.repetitions;
			repetition += 1
		) {
			const peers = results.filter(
				(result) =>
					result.owner === owner &&
					result.repetition === repetition &&
					result.correct,
			);
			const expected = peers[0]?.semanticHash;
			if (expected === undefined) continue;
			for (const peer of peers) {
				if (peer.semanticHash === expected) continue;
				peer.correct = false;
				peer.error = `cross-candidate semantic hash mismatch: expected ${expected}, got ${peer.semanticHash}`;
			}
		}
	}

	const ownerRecommendations = recommendations(results, options);
	const simulatedFailure = results.map((result, index) =>
		index === 0 ? { ...result, correct: false } : result,
	);
	const recommendationFailureGateProof = recommendations(
		simulatedFailure,
		options,
	).every((recommendation) => recommendation.recommendation === null);
	const recommendationMissingCellGateProof = recommendations(
		results.slice(1),
		options,
	).every((recommendation) => recommendation.recommendation === null);
	const syntheticOptions = { ...options, repetitions: 2 };
	const stableSyntheticResults = (['replica', 'authority'] as const).flatMap(
		(owner) => {
			const critical =
				owner === 'replica'
					? REPLICA_CRITICAL_METRICS
					: AUTHORITY_CRITICAL_METRICS;
			return CANDIDATES.flatMap((candidate) => {
				const template = results.find(
					(result) =>
						result.owner === owner && result.candidate.id === candidate.id,
				);
				if (template === undefined) {
					throw new Error(
						`missing synthetic template: ${owner}/${candidate.id}`,
					);
				}
				return [0, 1].map(
					(repetition): RunResult => ({
						...template,
						repetition,
						correct: true,
						metrics: Object.fromEntries(
							critical.map((metric) => [
								metric,
								{
									rawMs: [100],
									p50Ms: 100,
									p95Ms: 100,
									p99Ms: 100,
									coefficientOfVariation: 0,
								},
							]),
						),
						storage: { ...template.storage, liveBytes: 1_000_000 },
					}),
				);
			});
		},
	);
	const stableSyntheticRecommendations = recommendations(
		stableSyntheticResults,
		syntheticOptions,
	);
	const perturbedSyntheticResults = stableSyntheticResults.map((result) => {
		if (
			result.owner !== 'replica' ||
			result.candidate.id !== CANDIDATES[0]?.id ||
			result.repetition !== 0
		) {
			return result;
		}
		const metric = REPLICA_CRITICAL_METRICS[0];
		const samples = result.metrics[metric];
		if (samples === undefined) throw new Error(`missing synthetic ${metric}`);
		return {
			...result,
			metrics: {
				...result.metrics,
				[metric]: { ...samples, p95Ms: samples.p95Ms * 100 },
			},
		};
	});
	const unstableSyntheticRecommendation = recommendations(
		perturbedSyntheticResults,
		syntheticOptions,
	).find((recommendation) => recommendation.owner === 'replica');
	const recommendationInstabilityGateProof =
		stableSyntheticRecommendations.every(
			(recommendation) => recommendation.recommendation === 'unified-inline',
		) &&
		unstableSyntheticRecommendation?.recommendation === null &&
		unstableSyntheticRecommendation.reason.startsWith(
			'paired candidate log-ratio dispersion',
		) &&
		'unstableComparisons' in unstableSyntheticRecommendation &&
		Array.isArray(unstableSyntheticRecommendation.unstableComparisons) &&
		unstableSyntheticRecommendation.unstableComparisons.length > 0;
	if (
		!recommendationFailureGateProof ||
		!recommendationMissingCellGateProof ||
		!recommendationInstabilityGateProof
	) {
		throw new Error('recommendation refusal gate self-proof failed');
	}
	const report = {
		schemaVersion: 3,
		benchmark: 'scalar-facts-physical-layout',
		startedAt,
		finishedAt: new Date().toISOString(),
		durationMs: performance.now() - started,
		environment: readEnvironment(),
		configuration: {
			...options,
			output: options.output ?? null,
			pragmas: {
				journalMode: 'WAL',
				synchronous: 'NORMAL',
				pageSize: PAGE_SIZE,
				cacheKib: CACHE_KIB,
				tempStore: 'MEMORY',
				foreignKeys: true,
				walAutocheckpoint: 1000,
			},
			fixtureDdlHash: sha256(FIXTURE_DDL),
			temporarySpace,
		},
		methodology: {
			ownersEvaluatedIndependently: true,
			ownerCriticalMetrics: {
				replica: REPLICA_CRITICAL_METRICS,
				authority: AUTHORITY_CRITICAL_METRICS,
			},
			latencyMaterialityFraction: LATENCY_MATERIALITY,
			storageMaterialityFraction: STORAGE_MATERIALITY,
			latencyPairedLogRatioSdLimit: LATENCY_PAIRED_LOG_RATIO_SD_LIMIT,
			storagePairedLogRatioSdLimit: STORAGE_PAIRED_LOG_RATIO_SD_LIMIT,
			latencyVariancePolicy:
				'materiality remains fixed; paired per-seed log-ratio standard deviation is an order-invariant refusal gate, and within-run CV is diagnostic only',
			tieBreak: [
				'direct SQLite enforcement of address and global-sequence uniqueness',
				'fewer relations, indexes, and feed branches',
				'fewer sentinel, nullable, and mixed-shape clauses',
			],
			splitSequenceProof:
				'cross-table INSERT and UPDATE triggers reject collisions; the untimed proof inserts the same sequence into row_facts and value_facts and requires refusal',
			streamingDataset: true,
			acquisitionTiming:
				'each bounded streaming batch is generated before timing; raw samples time only its transaction/install',
			agingOrder:
				'deterministic seeded affine permutations with coprime steps provide unique pseudorandom rewrite, tombstone, and unset addresses',
			legacyOrProductionImports: false,
			analyzePhase:
				'after identical untimed aging and before every measured read/query-plan workload',
			walDiagnostics: {
				gate: false,
				policy:
					'production-style wal_autocheckpoint=1000 remains active during every timing; checkpoint(TRUNCATE) only separates declared phases; post-phase file sizes are bounded diagnostics, not cumulative write amplification',
			},
			recommendationFailureGateProof,
			recommendationMissingCellGateProof,
			recommendationInstabilityGateProof,
			browserReplicaEvidence: {
				attached: false,
				required: true,
				requiredDimensions: [
					'browser SQLite and OPFS acquisition, install, reads, cleanup, and reopen',
					'browser storage footprint at the million-address envelope',
					'browser constraint and crash-recovery conformance for the selected layout',
				],
			},
			cloudflareAuthorityEvidence: {
				attached: false,
				required: true,
				requiredDimensions: [
					'Durable Object SQLite rowsRead and rowsWritten per critical workload, including index-update writes',
					'2 MB maximum string, BLOB, and table-row conformance',
					'100 bound-parameter conformance',
					'30 second default CPU-limit conformance at the full envelope',
				],
			},
		},
		runOrder: runOrder.map(({ owner, candidate, repetition }) => ({
			owner,
			candidate: candidate.id,
			repetition,
			dataSeed: hash32(options.dataSeed, repetition),
		})),
		results,
		recommendations: ownerRecommendations,
	};
	const json = `${JSON.stringify(report, null, 2)}\n`;
	if (options.output !== undefined) writeFileSync(options.output, json);
	console.log(json.trimEnd());
	if (results.some((result) => !result.correct)) process.exitCode = 1;
}

main();
