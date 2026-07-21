#!/usr/bin/env bun
/**
 * The modular exact-trace measurement-method pilot.
 *
 * This executes the full declared bounded method: real owner-specific work for
 * every declared metric, the executed balanced Williams schedule with real
 * idle-plus-connection-reopen boundaries, per-owner-and-metric balanced
 * calibration with three immediate untimed warmups before each timed block,
 * balanced reopen sequences whose every retained witness is compared to the
 * oracle, and mutating checkpoint tails (monotonic install, row-tombstone plus
 * document cleanup, authority submission settlement) each run after a true
 * byte-equivalent reset with three warmup transactions and a second restore
 * before timing the profile-declared production-autocheckpoint transactions.
 * Headroom is
 * a conservative bound across all four candidates and both owner populations.
 * Every proof gate is DERIVED from retained observations, and the full raw
 * per-seed observations are persisted so a resumed run's gates cover committed
 * and fresh seeds identically.
 *
 * Method validation is not evidence readiness. This pilot emits no final-readiness
 * or SLO verdict because those product policies have no owner yet. Browser OPFS,
 * Cloudflare Durable Object, and full-envelope final data remain explicit external
 * requirements. Nothing here selects, ranks, recommends, or returns a candidate
 * id.
 */

import { Database } from 'bun:sqlite';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalize } from '../../../packages/data/src/protocol/v1/canonical.js';
import {
	allAuxiliaryBound,
	DEFAULT_AUXILIARY_OPTIONS,
	makeAuxiliaryTraces,
} from './auxiliary-traces.js';
import { CANDIDATE_IDS, CANDIDATES, type Candidate } from './candidates.js';
import {
	commitSeed,
	completenessExpectations,
	createManifest,
	decideResume,
	type PilotManifest,
	type ProvenanceConfig,
	parseManifest,
	persistManifest,
	type SeedRecord,
} from './checkpoint.js';
import { buildSeedEstimators, estimatorsMatchRaw } from './estimators.js';
import { type ProofGateInputs, validateMethod } from './evidence-status.js';
import {
	configureNewDatabase,
	configureReopenedDatabase,
	createLayoutStore,
	ddlFor,
	ddlHash,
	type LayoutStore,
} from './layouts.js';
import { Sha256Stream } from './portable-hash.js';
import {
	buildProbePlan,
	buildProbeSource,
	PROBE_PHASES,
	type ProbePhase,
	type ProbePlan,
} from './probe-plan.js';
import {
	buildIdFor,
	expectedObservationCounts,
	RAW_MACRO_METRIC,
	RAW_OWNERS,
	RAW_READ_METRICS,
	RAW_TAIL_METRICS,
	validateSeedCompleteness,
	validateSeedRawClosed,
} from './raw-schema.js';
import {
	buildCalibrationRound,
	buildSeedSchedule,
	evaluateCalibrationTrials,
	type SeedSchedule,
} from './schedule.js';
import type { Address, Fact, RowAddress } from './trace.js';
import { factsForPresentTarget, makeTrace, type Trace } from './trace.js';
import { pilotLimits, verifyTraceV1Binding } from './v1-binding.js';

type Owner = (typeof RAW_OWNERS)[number];
const OWNERS = RAW_OWNERS;
// --- Profiles ----------------------------------------------------------------

const VALUE_RATIO = 0.08;

/**
 * The frozen exact-envelope pilot dimensions (spec 483-553). Only a run at these
 * exact dimensions can be method-validated; a bounded smoke never can.
 */
const EXACT_PRESENT_ADDRESSES = 1_000_000;
const EXACT_PROXY_BYTES = 536_870_912; // 512 MiB
const EXACT_CYCLES = 3;
const EXACT_SEEDS = 4;
const EXACT_REOPENS = 20;
const EXACT_TAIL_TRANSACTIONS = 400;
const WALL_TIME_CAP_SECONDS = 8 * 60 * 60;

type Profile = {
	name: string;
	/** Whether this profile is the frozen exact-envelope pilot. */
	exact: boolean;
	/** Intended final-present address count. */
	present: number;
	facts: number;
	targetLogicalStateBytes: number;
	maxEncodedFactBytes: number;
	seedCount: number;
	cycles: number;
	minBlockMs: number;
	maxBlockOps: number;
	reopenObservations: number;
	tailTransactions: number;
};

/** The frozen exact-envelope pilot. Never run in-process here; estimated then refused. */
function exactPilotProfile(): Profile {
	const facts = factsForPresentTarget(EXACT_PRESENT_ADDRESSES, VALUE_RATIO);
	if (facts === null) {
		throw new Error('no exact corpus reaches 1,000,000 present addresses');
	}
	return {
		name: 'exact-envelope-pilot',
		exact: true,
		present: EXACT_PRESENT_ADDRESSES,
		facts,
		targetLogicalStateBytes: EXACT_PROXY_BYTES,
		maxEncodedFactBytes: 4096,
		seedCount: EXACT_SEEDS,
		cycles: EXACT_CYCLES,
		minBlockMs: 20,
		maxBlockOps: 1 << 20,
		reopenObservations: EXACT_REOPENS,
		tailTransactions: EXACT_TAIL_TRANSACTIONS,
	};
}

/**
 * A bounded complete-method smoke. It exercises the full method wiring but at
 * small dimensions, so it can NEVER be method-validated (the exact-envelope gate
 * fails). Cycles are kept at the frozen three so the schedule shape is faithful.
 */
const SMOKE: Profile = {
	name: 'complete-method-smoke',
	exact: false,
	present: 2400,
	facts: factsForPresentTarget(2400, VALUE_RATIO) ?? 2600,
	targetLogicalStateBytes: 2400 * 160,
	maxEncodedFactBytes: 4096,
	seedCount: EXACT_SEEDS,
	cycles: EXACT_CYCLES,
	minBlockMs: 20,
	maxBlockOps: 1 << 20,
	reopenObservations: EXACT_REOPENS,
	tailTransactions: EXACT_TAIL_TRANSACTIONS,
};

const NAMESPACE_COUNT = 12;
const TABLE_COUNT = 200;
const BASE_SEED = 1000;
const HEADROOM_MARGIN = 1.25;
const MAX_READ_BLOCKS = 64; // spec cap per seed/candidate/owner/metric

/** Whether a run's dimensions match the frozen exact-envelope pilot exactly. */
function isExactEnvelope(profile: Profile): boolean {
	const exact = exactPilotProfile();
	return (
		profile.exact &&
		profile.present === EXACT_PRESENT_ADDRESSES &&
		profile.facts === exact.facts &&
		profile.targetLogicalStateBytes === EXACT_PROXY_BYTES &&
		profile.seedCount === EXACT_SEEDS &&
		profile.cycles === EXACT_CYCLES &&
		profile.minBlockMs === exact.minBlockMs &&
		profile.maxBlockOps === exact.maxBlockOps &&
		profile.reopenObservations === EXACT_REOPENS &&
		profile.tailTransactions === EXACT_TAIL_TRANSACTIONS
	);
}

// --- Strict CLI --------------------------------------------------------------

type CliOptions = {
	output: string | null;
	seedCount: number;
	keepArtifacts: boolean;
	profile: 'smoke' | 'pilot';
};

const USAGE = `scalar-facts-layout measurement pilot

Usage: bun scripts/benchmarks/scalar-facts-layout/pilot.ts [options]
  --profile smoke|pilot  smoke (default) runs the complete method at bounded scale
                         and can never be method-validated; pilot ESTIMATES the
                         exact-envelope disk/wall-time and refuses to run it here.
  --output <path>        Write the JSON report to <path> (default: a temp file).
  --seeds <n>            Number of fresh seeds, >= 4 (default: ${SMOKE.seedCount}).
  --keep-artifacts       Keep the temporary database/manifest directory.
`;

class CliError extends Error {}

function parseCli(argv: readonly string[]): CliOptions {
	const options: CliOptions = {
		output: null,
		seedCount: SMOKE.seedCount,
		keepArtifacts: false,
		profile: 'smoke',
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		switch (arg) {
			case '--output': {
				const value = argv[i + 1];
				if (value === undefined || value.startsWith('--')) {
					throw new CliError('--output requires a path');
				}
				options.output = value;
				i += 1;
				break;
			}
			case '--seeds': {
				const value = argv[i + 1];
				if (value === undefined || value.startsWith('--')) {
					throw new CliError('--seeds requires a number');
				}
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed < 4) {
					throw new CliError('--seeds must be an integer >= 4');
				}
				options.seedCount = parsed;
				i += 1;
				break;
			}
			case '--profile': {
				const value = argv[i + 1];
				if (value !== 'smoke' && value !== 'pilot') {
					throw new CliError('--profile must be smoke or pilot');
				}
				options.profile = value;
				i += 1;
				break;
			}
			case '--keep-artifacts':
				options.keepArtifacts = true;
				break;
			case '--help':
				throw new CliError(USAGE);
			default:
				throw new CliError(`unknown option: ${arg}`);
		}
	}
	return options;
}

function resolveSourceVersion(): string {
	const fromEnv = process.env.PILOT_SOURCE_VERSION;
	if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
	const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD']);
	if (git.exitCode === 0) {
		const head = git.stdout.toString().trim();
		const dirty = Bun.spawnSync(['git', 'status', '--porcelain']);
		const suffix =
			dirty.exitCode === 0 && dirty.stdout.toString().trim().length > 0
				? '-dirty'
				: '';
		if (head.length > 0) return `${head}${suffix}`;
	}
	throw new CliError(
		'cannot determine the source version; set PILOT_SOURCE_VERSION or run inside a git repository',
	);
}

// --- Small helpers -----------------------------------------------------------

function timeMs(run: () => void): number {
	const start = performance.now();
	run();
	return performance.now() - start;
}

function percentile(sortedAsc: number[], fraction: number): number {
	if (sortedAsc.length === 0) return Number.NaN;
	const rank = Math.ceil(fraction * sortedAsc.length);
	return sortedAsc[
		Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))
	] as number;
}
function finalFacts(trace: Trace): Fact[] {
	const out: Fact[] = new Array(trace.options.facts);
	for (let i = 0; i < trace.options.facts; i += 1)
		out[i] = trace.finalFactAt(i);
	return out;
}
function digestOf(...parts: (string | number)[]): string {
	return new Sha256Stream().update(parts.join('|')).digestHex();
}
const BOUNDARY_IDLE_MS = 50; // fixed idle at pair/cycle boundaries

/**
 * A real fixed idle at a boundary: a non-spinning synchronous sleep that parks the
 * thread instead of heating the CPU (unlike a busy loop). Returns the measured
 * elapsed idle. The idle is recorded and never claimed to clear the OS cache or
 * thermal history (spec).
 */
function fixedIdle(ms: number): number {
	const start = performance.now();
	Bun.sleepSync(ms);
	return performance.now() - start;
}

// --- Raw observation model ---------------------------------------------------

type BlockObservation = {
	owner: Owner;
	metric: string;
	candidate: string;
	/** The retained-database build identity this block ran against. */
	buildId: string;
	cycle: number;
	ordinal: number;
	position: number;
	/** The Williams letter for this block and its full sequence label. */
	letter: string;
	sequenceLabel: string;
	predecessor: string | null;
	boundary: string;
	ops: number;
	calibrationId: string;
	warmupProbeId: string;
	warmupProbeDigest: string;
	timedProbeId: string;
	timedProbeDigest: string;
	temporalOrdinal: number;
	warmupMs: [number, number, number];
	elapsedMs: number;
};
export type CalibrationObservation = {
	configIdentity: string;
	seedId: number;
	owner: Owner;
	metric: string;
	candidate: string;
	buildId: string;
	roundIndex: number;
	trialIndex: number;
	sequenceOrder: number;
	sequenceIndex: number;
	position: number;
	letter: 'A' | 'B' | 'C' | 'D';
	ops: number;
	elapsedMs: number;
	minBlockMs: number;
	probeId: string;
	probeDigest: string;
	calibrationId: string;
	temporalOrdinal: number;
};
type ProbeObservation = ProbePlan;
type ReopenObservation = {
	owner: Owner;
	candidate: string;
	buildId: string;
	index: number;
	/** Position of this candidate within the balanced rotation for this observation. */
	orderPosition: number;
	elapsedMs: number;
	witnessDigest: string;
	witnessMatchesOracle: boolean;
};
type TailObservation = {
	owner: Owner;
	metric: string;
	candidate: string;
	transactions: number;
	/** Every raw per-transaction sample in milliseconds, retained (not only percentiles). */
	samplesMs: number[];
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	throughputPerSec: number;
	resetVerified: boolean;
	warmupTransactions: number;
	/**
	 * A best-effort WAL-size delta count, retained only as a DIAGNOSTIC. It is NOT a
	 * truthful autocheckpoint boundary signal: SQLite may reset and reuse the WAL
	 * without shrinking the file, so this undercounts. `checkpointSignalTruthful`
	 * is false, which fails the checkpoint-truthful gate rather than fabricate.
	 */
	walDeltaDiagnostic: number;
	checkpointSignalTruthful: boolean;
};
type MacroObservation = {
	owner: Owner;
	metric: string;
	candidate: string;
	units: number;
	elapsedMs: number;
	throughputPerSec: number;
};
type CellObservation = {
	owner: Owner;
	candidate: string;
	buildId: string;
	oracleReproduced: boolean;
	integrityOk: boolean;
	candidateTableBytes: number;
	fileBytes: number;
};
type BoundaryObservation = {
	owner: Owner;
	metric: string;
	kind: string; // 'pair' or 'cycle'
	atOrdinal: number;
	idleMs: number;
	reopenMs: number;
	reopenedCandidates: number;
	reopenOk: boolean;
};
type SeedLifecycle = {
	/** Peak number of retained databases live at once (must be eight). */
	peakRetained: number;
	/** Retained databases live at the moment the seed committed. */
	liveAtCommit: number;
	/**
	 * True when all eight databases were still retained THROUGH the durable commit
	 * write. Deletion happens strictly after that write, so the durable record
	 * always witnesses them retained; a false value would mean a database was
	 * dropped before the completed boundary was durable.
	 */
	retainedThroughCommit: boolean;
};
type SeedRawObservations = {
	/** The seed-specific Williams letter-to-candidate mapping (both owners share it). */
	letterMapping: Record<string, string>;
	lifecycle: SeedLifecycle;
	probes: ProbeObservation[];
	calibrations: CalibrationObservation[];
	blocks: BlockObservation[];
	boundaries: BoundaryObservation[];
	reopens: ReopenObservation[];
	tails: TailObservation[];
	macros: MacroObservation[];
	cells: CellObservation[];
};

// --- Database build ----------------------------------------------------------

function walBytes(path: string): number {
	try {
		return statSync(`${path}-wal`).size;
	} catch {
		return 0;
	}
}
function fileBytesOf(path: string): number {
	try {
		return statSync(path).size + walBytes(path);
	} catch {
		return 0;
	}
}
function removeDatabase(path: string): void {
	for (const suffix of ['', '-wal', '-shm'])
		rmSync(`${path}${suffix}`, { force: true });
}

type OpenedDatabase = { db: Database; store: LayoutStore };

function initializationFailure(
	path: string,
	db: Database,
	originalError: unknown,
	removeOnFailure: boolean,
	removeOne: (path: string) => void,
): never {
	const cleanupErrors: unknown[] = [];
	let closed = false;
	try {
		db.close();
		closed = true;
	} catch (cause) {
		cleanupErrors.push(
			new Error(
				`Failed to close database '${path}' after initialization failed`,
				{ cause },
			),
		);
	}
	if (closed && removeOnFailure) {
		try {
			removeOne(path);
		} catch (cause) {
			cleanupErrors.push(
				new Error(
					`Failed to remove database '${path}' after initialization failed`,
					{ cause },
				),
			);
		}
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(
			[originalError, ...cleanupErrors],
			`Database '${path}' could not be initialized or cleaned up`,
		);
	}
	throw originalError;
}

function initializeAcquiredDatabase(
	path: string,
	db: Database,
	initialize: (db: Database) => LayoutStore,
	removeOnFailure: boolean,
	removeOne: (path: string) => void = removeDatabase,
): OpenedDatabase {
	try {
		return { db, store: initialize(db) };
	} catch (error) {
		return initializationFailure(path, db, error, removeOnFailure, removeOne);
	}
}

function cleanupOpenedDatabase(args: {
	opened: OpenedDatabase;
	path: string;
	remove: boolean;
	removeOne: (path: string) => void;
}): unknown[] {
	const cleanupErrors: unknown[] = [];
	try {
		args.opened.store.finalize();
	} catch (cause) {
		cleanupErrors.push(
			new Error(`Failed to finalize ephemeral database '${args.path}'`, {
				cause,
			}),
		);
	}
	let closed = false;
	try {
		args.opened.db.close();
		closed = true;
	} catch (cause) {
		cleanupErrors.push(
			new Error(`Failed to close ephemeral database '${args.path}'`, { cause }),
		);
	}
	if (closed && (args.remove || cleanupErrors.length > 0)) {
		try {
			args.removeOne(args.path);
		} catch (cause) {
			cleanupErrors.push(
				new Error(`Failed to remove ephemeral database '${args.path}'`, {
					cause,
				}),
			);
		}
	}
	return cleanupErrors;
}

/**
 * Run one operation against an owned ephemeral database, then finalize and close
 * it. A file retained for a later successful stage is still removed if the
 * operation or cleanup fails. Removal never precedes a successful close, and an
 * operation error stays first when cleanup also fails.
 */
export function withEphemeralDatabase<T>(args: {
	opened: OpenedDatabase;
	path: string;
	operation: (opened: OpenedDatabase) => T;
	retainOnSuccess?: boolean;
	removeOne?: (path: string) => void;
}): T {
	const removeOne = args.removeOne ?? removeDatabase;
	let outcome: { ok: true; value: T } | { ok: false; error: unknown };
	try {
		outcome = { ok: true, value: args.operation(args.opened) };
	} catch (error) {
		outcome = { ok: false, error };
	}

	const retain = args.retainOnSuccess === true && outcome.ok;
	const cleanupErrors = cleanupOpenedDatabase({
		opened: args.opened,
		path: args.path,
		remove: !retain,
		removeOne,
	});

	if (!outcome.ok) {
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[outcome.error, ...cleanupErrors],
				`Ephemeral database operation failed and cleanup was incomplete for '${args.path}'`,
			);
		}
		throw outcome.error;
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(
			cleanupErrors,
			`Ephemeral database cleanup was incomplete for '${args.path}'`,
		);
	}
	return outcome.value;
}

function maxSequence(db: Database, candidate: Candidate): number {
	const sql =
		candidate.relation === 'unified'
			? 'SELECT COALESCE(MAX(sequence), 0) AS m FROM facts'
			: 'SELECT MAX(m) AS m FROM (SELECT COALESCE(MAX(sequence),0) AS m FROM row_facts UNION ALL SELECT COALESCE(MAX(sequence),0) FROM value_facts)';
	return (db.prepare(sql).get() as { m: number }).m;
}

function openFresh(
	path: string,
	candidate: Candidate,
): { db: Database; store: LayoutStore } {
	const { db } = openOwnerFile(path);
	return initializeAcquiredDatabase(
		path,
		db,
		(acquired) => {
			configureNewDatabase(acquired);
			acquired.exec(ddlFor(candidate));
			return createLayoutStore(acquired, candidate);
		},
		true,
	);
}
/**
 * Acquire and initialize an existing database. Once acquisition succeeds, this
 * function owns the connection until it returns it: any initialization failure
 * closes the connection before rethrowing. Ephemeral callers may also request
 * removal after close. If cleanup fails, the initialization error remains first
 * in the aggregate.
 */
export function openExisting(
	path: string,
	candidate: Candidate,
	options: {
		acquire?: (path: string) => Database;
		initialize?: (db: Database, candidate: Candidate) => LayoutStore;
		removeOnFailure?: boolean;
		removeOne?: (path: string) => void;
	} = {},
): { db: Database; store: LayoutStore } {
	const acquire =
		options.acquire ?? ((databasePath: string) => new Database(databasePath));
	// Acquisition failure establishes no ownership of an existing path. Propagate
	// without removing a file that may still belong to another live connection.
	const db = acquire(path);
	return initializeAcquiredDatabase(
		path,
		db,
		(acquired) => {
			if (options.initialize !== undefined)
				return options.initialize(acquired, candidate);
			configureReopenedDatabase(acquired);
			return createLayoutStore(acquired, candidate);
		},
		options.removeOnFailure === true,
		options.removeOne,
	);
}

/**
 * Stage one of a two-stage build: open (create) the database FILE only. This is
 * the cheap step that yields a closeable, deletable handle; the retained set
 * registers it immediately, before any risky schema or population work, so a
 * later failure still owns the file and connection.
 */
function openOwnerFile(path: string): { db: Database } {
	removeDatabase(path);
	try {
		return { db: new Database(path) };
	} catch (error) {
		try {
			removeDatabase(path);
		} catch (cause) {
			throw new AggregateError(
				[
					error,
					new Error(
						`Failed to remove database '${path}' after acquisition failed`,
						{ cause },
					),
				],
				`Database '${path}' could not be acquired or cleaned up`,
			);
		}
		throw error;
	}
}

/**
 * Stage two of a two-stage build: the risky work (pragmas, schema, prepared
 * statements, fact install, auxiliary population, checkpoint) against an
 * already-open database. Any failure here rethrows to the caller, which owns the
 * open connection and file and can close and delete them.
 */
function initializeOwnerDatabase(
	db: Database,
	candidate: Candidate,
): LayoutStore {
	configureNewDatabase(db);
	db.exec(ddlFor(candidate));
	return createLayoutStore(db, candidate);
}

function populateOwnerStore(
	db: Database,
	store: LayoutStore,
	owner: Owner,
	facts: readonly Fact[],
	trace: Trace,
): void {
	if (owner === 'authority') {
		store.installFacts([...facts].sort((a, b) => a.sequence - b.sequence));
	} else {
		store.installFacts(facts);
	}
	const aux = makeAuxiliaryTraces(trace, pilotLimits());
	if (owner === 'authority') store.populateAuthorityAuxiliary(aux);
	else store.populateReplicaAuxiliary(aux);
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

function populateOwnerDatabase(
	db: Database,
	candidate: Candidate,
	owner: Owner,
	facts: readonly Fact[],
	trace: Trace,
): LayoutStore {
	const store = initializeOwnerDatabase(db, candidate);
	populateOwnerStore(db, store, owner, facts, trace);
	return store;
}

/** Build a fully populated candidate database for one owner (open then populate). */
function buildOwnerDatabase(
	path: string,
	candidate: Candidate,
	owner: Owner,
	facts: readonly Fact[],
	trace: Trace,
): { db: Database; store: LayoutStore } {
	const { db } = openOwnerFile(path);
	const opened = initializeAcquiredDatabase(
		path,
		db,
		(acquired) => initializeOwnerDatabase(acquired, candidate),
		true,
	);
	try {
		populateOwnerStore(opened.db, opened.store, owner, facts, trace);
		return opened;
	} catch (error) {
		const cleanupErrors = cleanupOpenedDatabase({
			opened,
			path,
			remove: true,
			removeOne: removeDatabase,
		});
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[error, ...cleanupErrors],
				`Database '${path}' population failed and cleanup was incomplete`,
			);
		}
		throw error;
	}
}

// --- Seed-level retained eight-database set (spec: retain all eight per seed) --

export type RetainedHandle = {
	owner: Owner;
	candidate: string;
	buildId: string;
	db: Database;
	store: LayoutStore;
	path: string;
	cleanup: {
		finalized: boolean;
		closed: boolean;
		removed: boolean;
	};
};
export type RetainedSet = {
	handles: Map<string, RetainedHandle>;
	/** The maximum number of retained databases live at once (must reach eight). */
	peakLive: number;
	cleanedUp: boolean;
};
export function retainedKey(owner: Owner, candidate: string): string {
	return `${owner}/${candidate}`;
}

/**
 * Build and retain ALL eight owner-by-candidate envelope databases for one seed.
 * They stay live through both owners' blocks, reopens, cells, and tails and the
 * atomic raw checkpoint commit. The success path deletes them only after that
 * commit; an aborted seed deletes its uncommitted temporary set. Each handle
 * carries a stable build id.
 */
export function buildRetainedSet(
	dir: string,
	seedIndex: number,
	configIdentity: string,
	seedId: number,
	facts: readonly Fact[],
	trace: Trace,
	openOne: (path: string) => { db: Database } = openOwnerFile,
	populateOne: (
		db: Database,
		candidate: Candidate,
		owner: Owner,
		facts: readonly Fact[],
		trace: Trace,
	) => LayoutStore = populateOwnerDatabase,
): RetainedSet {
	const handles = new Map<string, RetainedHandle>();
	// Every database whose file has been OPENED is registered here immediately,
	// before its risky populate stage. Rollback owns the in-progress handle too, so
	// a populate failure never leaves the just-opened connection or file behind.
	const registered: { db: Database; path: string; store?: LayoutStore }[] = [];
	try {
		for (const owner of OWNERS) {
			for (const candidate of CANDIDATES) {
				const path = join(dir, `s${seedIndex}-${owner}-${candidate.id}.sqlite`);
				const buildId = buildIdFor(configIdentity, seedId, owner, candidate.id);
				// Stage one: open the file and register the closeable handle FIRST.
				const { db } = openOne(path);
				const record: { db: Database; path: string; store?: LayoutStore } = {
					db,
					path,
				};
				registered.push(record);
				// Stage two: the risky populate. A throw here still leaves `record`
				// registered, so rollback closes and deletes it.
				const store = populateOne(db, candidate, owner, facts, trace);
				record.store = store;
				handles.set(retainedKey(owner, candidate.id), {
					owner,
					candidate: candidate.id,
					buildId,
					db,
					store,
					path,
					cleanup: { finalized: false, closed: false, removed: false },
				});
			}
		}
	} catch (buildError) {
		// Clean every registered handle (the in-progress one and every prior one).
		// Finalize and close are attempted independently. Removal requires a successful
		// close, so rollback never unlinks a database that may still be live. The
		// original population error is preserved first in the aggregate.
		const cleanupErrors: unknown[] = [];
		for (const record of registered) {
			try {
				record.store?.finalize();
			} catch (finalizeError) {
				cleanupErrors.push(finalizeError);
			}
			let closed = false;
			try {
				record.db.close();
				closed = true;
			} catch (cause) {
				cleanupErrors.push(
					new Error(
						`Failed to close rollback database '${record.path}'; the file was retained`,
						{ cause },
					),
				);
			}
			if (closed) {
				try {
					removeDatabase(record.path);
				} catch (removeError) {
					cleanupErrors.push(removeError);
				}
			}
		}
		handles.clear();
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[buildError, ...cleanupErrors],
				'buildRetainedSet failed and some opened retained databases could not be cleaned up',
			);
		}
		throw buildError;
	}
	return { handles, peakLive: handles.size, cleanedUp: false };
}

/**
 * Finalize, close, and delete every retained database. Finalization and close are
 * attempted independently, but a file is never removed before its close succeeds.
 * Close subsumes resource release when finalization reports an error. Handles with
 * a failed close or removal stay owned by the set with exact retry progress.
 */
export function cleanupRetainedSet(
	set: RetainedSet,
	removeOne: (path: string) => void = removeDatabase,
): void {
	const cleanupErrors: unknown[] = [];
	for (const [key, handle] of set.handles) {
		if (!handle.cleanup.finalized && !handle.cleanup.closed) {
			try {
				handle.store.finalize();
				handle.cleanup.finalized = true;
			} catch (cause) {
				cleanupErrors.push(
					new Error(`Failed to finalize retained database '${key}'`, {
						cause,
					}),
				);
			}
		}
		if (!handle.cleanup.closed) {
			try {
				handle.db.close();
				handle.cleanup.closed = true;
			} catch (cause) {
				cleanupErrors.push(
					new Error(`Failed to close retained database '${key}'`, { cause }),
				);
			}
		}
		if (handle.cleanup.closed && !handle.cleanup.removed) {
			try {
				removeOne(handle.path);
				handle.cleanup.removed = true;
			} catch (cause) {
				cleanupErrors.push(
					new Error(`Failed to remove retained database '${key}'`, { cause }),
				);
			}
		}
		if (handle.cleanup.closed && handle.cleanup.removed) {
			set.handles.delete(key);
		}
	}
	set.cleanedUp = set.handles.size === 0;
	if (cleanupErrors.length > 0) {
		throw new AggregateError(
			cleanupErrors,
			'One or more retained databases could not be fully cleaned up',
		);
	}
}

/**
 * Build and durably persist the next whole-seed checkpoint. Cleanup is a separate
 * caller-owned phase so the committed manifest becomes observable before cleanup
 * begins and cannot be hidden by a later resource-release failure. `persist` must
 * perform every durable write (the target manifest and any prior-generation
 * mirror); if it throws, no committed manifest is returned.
 */
export function persistSeedCheckpoint(args: {
	manifest: PilotManifest;
	record: SeedRecord;
	persist: (manifest: PilotManifest) => void;
}): PilotManifest {
	const next = commitSeed(args.manifest, args.record);
	args.persist(next);
	return next;
}

/**
 * Replace one retained handle in place with a freshly reopened connection to the
 * same file, keeping the retained set at eight live databases. Used at boundaries
 * and in the reopen series so a close/open never drops the retained count below
 * its peak permanently.
 */
export function reopenRetained(
	set: RetainedSet,
	owner: Owner,
	candidate: Candidate,
	openOne: (
		path: string,
		candidate: Candidate,
	) => { db: Database; store: LayoutStore } = openExisting,
): RetainedHandle {
	const key = retainedKey(owner, candidate.id);
	const prior = set.handles.get(key);
	if (prior === undefined) throw new Error(`retained handle missing: ${key}`);
	const cleanupErrors: unknown[] = [];
	if (!prior.cleanup.finalized && !prior.cleanup.closed) {
		try {
			prior.store.finalize();
			prior.cleanup.finalized = true;
		} catch (cause) {
			cleanupErrors.push(
				new Error(`Failed to finalize retained database '${key}' for reopen`, {
					cause,
				}),
			);
		}
	}
	if (!prior.cleanup.closed) {
		try {
			prior.db.close();
			prior.cleanup.closed = true;
		} catch (cause) {
			cleanupErrors.push(
				new Error(`Failed to close retained database '${key}' for reopen`, {
					cause,
				}),
			);
		}
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(
			cleanupErrors,
			`Retained database '${key}' could not be safely reopened`,
		);
	}
	const reopened = openOne(prior.path, candidate);
	const next: RetainedHandle = {
		...prior,
		db: reopened.db,
		store: reopened.store,
		cleanup: { finalized: false, closed: false, removed: false },
	};
	set.handles.set(key, next);
	return next;
}

// --- Read metric operations --------------------------------------------------

type ReadContext = {
	rows: readonly Address[];
	replicaIds: readonly string[];
	watermarks: readonly number[];
	traversalPages: readonly {
		afterSequence: number;
		throughSequence: number;
	}[];
};

/** One read operation for `ops` iterations over a store, distinct per metric. */
function readOp(
	metric: string,
	store: LayoutStore,
	ctx: ReadContext,
	ops: number,
	offset: number,
): void {
	const n = ctx.rows.length;
	switch (metric) {
		case 'confirmedPointRead':
		case 'foldPointRead':
			for (let i = 0; i < ops; i += 1)
				store.pointRead(ctx.rows[(offset + i) % n] as Address);
			return;
		case 'confirmedTraversal':
			for (let i = 0; i < ops; i += 1) {
				const page =
					ctx.traversalPages[(offset + i) % ctx.traversalPages.length];
				if (page === undefined) throw new Error('traversal probe page missing');
				store.traverse(page.afterSequence, page.throughSequence);
			}
			return;
		case 'confirmedPendingOverlayRead':
			for (let i = 0; i < ops; i += 1)
				store.overlayRead(ctx.rows[(offset + i) % n] as Address);
			return;
		case 'orderedResumeFeed': {
			const w = ctx.watermarks.length;
			for (let i = 0; i < ops; i += 1) {
				store.resumeFeed(ctx.watermarks[(offset + i) % w] as number, 64);
			}
			return;
		}
		case 'exactRetrySettlementRead': {
			const r = ctx.replicaIds.length;
			for (let i = 0; i < ops; i += 1) {
				store.retrySettlementRead(ctx.replicaIds[(offset + i) % r] as string);
			}
			return;
		}
		default:
			throw new Error(`unknown read metric: ${metric}`);
	}
}

// --- Per-seed, per-owner execution -------------------------------------------

type SeedContext = {
	dir: string;
	profile: Profile;
	trace: Trace;
	seedIndex: number;
	seedId: number;
	schedule: SeedSchedule;
	configIdentity: string;
	raw: SeedRawObservations;
};

export type OwnerRunResult =
	| { status: 'COMPLETE' }
	| {
			status: 'INCOMPLETE';
			reasonCode: 'CALIBRATION_OPS_UNSELECTED';
			selectedOps: null;
			reason: string;
			seedId: number;
			owner: Owner;
			metric: string;
			minBlockMs: number;
			maxBlockOps: number;
			trials: CalibrationObservation[];
	  };

function runOwner(
	ctx: SeedContext,
	owner: Owner,
	retained: RetainedSet,
): OwnerRunResult {
	const {
		dir,
		profile,
		trace,
		seedIndex,
		seedId,
		schedule,
		configIdentity,
		raw,
	} = ctx;
	const facts = finalFacts(trace);
	const oracle = trace.measure();
	const handleFor = (candidate: string): RetainedHandle => {
		const handle = retained.handles.get(retainedKey(owner, candidate));
		if (handle === undefined) {
			throw new Error(`retained handle missing for ${owner}/${candidate}`);
		}
		return handle;
	};

	// Macro: acquisition (replica) is install on a fresh empty database; ordered
	// fresh feed (authority) is a complete ordered READ of all current facts after
	// construction, both measured once per outer unit and candidate. A candidate
	// failure cleans its ephemeral path and aborts the owner run; later candidates
	// are not recorded into a partial macro series.
	for (const candidate of CANDIDATES) {
		let elapsedMs: number;
		let units: number;
		if (owner === 'replica') {
			const macroPath = join(
				dir,
				`s${seedIndex}-replica-${candidate.id}-macro.sqlite`,
			);
			const opened = openFresh(macroPath, candidate);
			elapsedMs = withEphemeralDatabase({
				opened,
				path: macroPath,
				operation: ({ store }) => timeMs(() => store.installFacts(facts)),
			});
			units = facts.length;
		} else {
			// A complete fresh feed reads every current fact in ascending sequence order
			// from the already-constructed authority database.
			const store = handleFor(candidate.id).store;
			let fed = 0;
			elapsedMs = timeMs(() => {
				fed = store.resumeFeed(0, oracle.currentCount + 1);
			});
			units = fed;
		}
		raw.macros.push({
			owner,
			metric: RAW_MACRO_METRIC[owner],
			candidate: candidate.id,
			units,
			elapsedMs,
			throughputPerSec: elapsedMs > 0 ? (units / elapsedMs) * 1000 : 0,
		});
	}

	// Disjoint deterministic probe sets: calibration, warmup, and timed use
	// non-overlapping address, watermark, retry-id, and traversal-page ranges. The
	// same layout-independent owner reconstructs these plans during checkpoint load.
	const probeSource = buildProbeSource(trace.options);
	for (const metric of RAW_READ_METRICS[owner]) {
		const probes = Object.fromEntries(
			PROBE_PHASES.map((phase) => {
				const planned = buildProbePlan(probeSource, {
					configIdentity,
					seedId,
					owner,
					metric,
					phase,
				});
				raw.probes.push(planned.plan);
				return [phase, planned];
			}),
		) as Record<ProbePhase, ReturnType<typeof buildProbePlan>>;

		// Balanced ACTUAL calibration on the calibration-only probe partition. Each
		// round executes all sixteen Williams trials, measures the next power of two,
		// and is
		// retained. There is no seconds-per-operation projection and no silent cap
		// fallback: if the cap is reached before all sixteen trials measure at least
		// the floor, this seed refuses before any timed block is recorded.
		const calibrationId = `${configIdentity}/${seedId}/${owner}/${metric}/calibration`;
		const calibration: CalibrationObservation[] = [];
		let roundIndex = 0;
		let ops = 1;
		while (ops <= profile.maxBlockOps) {
			const round: CalibrationObservation[] = [];
			for (const slot of buildCalibrationRound(
				schedule.letterMapping,
				roundIndex,
			)) {
				const candidateId = slot.candidate;
				const candidate = CANDIDATES.find((entry) => entry.id === candidateId);
				if (candidate === undefined) {
					throw new Error(`calibration candidate ${candidateId} missing`);
				}
				const elapsedMs = timeMs(() =>
					readOp(
						metric,
						handleFor(candidate.id).store,
						probes.calibration.items,
						ops,
						(roundIndex * 4 + slot.sequenceOrder) * ops,
					),
				);
				const observation: CalibrationObservation = {
					configIdentity,
					seedId,
					owner,
					metric,
					candidate: candidate.id,
					buildId: handleFor(candidate.id).buildId,
					roundIndex: slot.roundIndex,
					trialIndex: slot.trialIndex,
					sequenceOrder: slot.sequenceOrder,
					sequenceIndex: slot.sequenceIndex,
					position: slot.position,
					letter: slot.letter,
					ops,
					elapsedMs,
					minBlockMs: profile.minBlockMs,
					probeId: probes.calibration.plan.probeId,
					probeDigest: probes.calibration.plan.itemsDigest,
					calibrationId,
					temporalOrdinal: raw.calibrations.length + raw.blocks.length,
				};
				raw.calibrations.push(observation);
				calibration.push(observation);
				round.push(observation);
			}
			if (
				round.every(
					(observation) => observation.elapsedMs >= profile.minBlockMs,
				)
			) {
				break;
			}
			roundIndex += 1;
			ops *= 2;
		}
		const decision = evaluateCalibrationTrials(
			calibration,
			schedule.letterMapping,
			profile.minBlockMs,
			profile.maxBlockOps,
		);
		if (decision.status === 'INVALID') {
			throw new Error(
				`calibration invalid for ${owner}/${metric}: ${decision.reason}`,
			);
		}
		if (decision.status === 'INCOMPLETE') {
			return {
				status: 'INCOMPLETE',
				reasonCode: 'CALIBRATION_OPS_UNSELECTED',
				selectedOps: null,
				reason: decision.reason,
				seedId,
				owner,
				metric,
				minBlockMs: profile.minBlockMs,
				maxBlockOps: profile.maxBlockOps,
				trials: calibration,
			};
		}
		ops = decision.selectedOps;

		let blockCount = 0;
		for (const block of schedule.blocks) {
			if (blockCount >= MAX_READ_BLOCKS) break;
			// At a pair/cycle boundary, perform a fixed idle plus a real connection
			// close/reopen for THIS owner's four retained databases, and record it.
			if (
				block.precedingBoundary === 'pair' ||
				block.precedingBoundary === 'cycle'
			) {
				const idleMs = fixedIdle(BOUNDARY_IDLE_MS);
				let reopenOk = true;
				const reopenMs = timeMs(() => {
					for (const candidate of CANDIDATES) {
						const next = reopenRetained(retained, owner, candidate);
						if (next.store.scanWitness().digestHex !== oracle.digestHex) {
							reopenOk = false;
						}
					}
				});
				raw.boundaries.push({
					owner,
					metric,
					kind: block.precedingBoundary,
					atOrdinal: block.ordinal,
					idleMs,
					reopenMs,
					reopenedCandidates: CANDIDATES.length,
					reopenOk,
				});
			}
			const entry = handleFor(block.candidate);
			// Three immediate untimed warmup batches on the SAME metric path, disjoint
			// probes, right before the timed block.
			const warmupMs: [number, number, number] = [0, 0, 0];
			for (let w = 0; w < 3; w += 1) {
				warmupMs[w] = timeMs(() =>
					readOp(metric, entry.store, probes.warmup.items, ops, w * ops),
				);
			}
			const elapsedMs = timeMs(() =>
				readOp(metric, entry.store, probes.timed.items, ops, 0),
			);
			raw.blocks.push({
				owner,
				metric,
				candidate: block.candidate,
				buildId: entry.buildId,
				cycle: block.cycle,
				ordinal: block.ordinal,
				position: block.positionInSequence,
				letter: block.letter,
				sequenceLabel: block.sequence.join(''),
				predecessor: block.predecessor,
				boundary: block.precedingBoundary,
				ops,
				calibrationId,
				warmupProbeId: probes.warmup.plan.probeId,
				warmupProbeDigest: probes.warmup.plan.itemsDigest,
				timedProbeId: probes.timed.plan.probeId,
				timedProbeDigest: probes.timed.plan.itemsDigest,
				temporalOrdinal: raw.calibrations.length + raw.blocks.length,
				warmupMs,
				elapsedMs,
			});
			blockCount += 1;
		}
	}

	// Balanced reopen series: rotate the candidate order per observation so no
	// candidate is always first, and compare every retained witness to the oracle.
	for (let obs = 0; obs < profile.reopenObservations; obs += 1) {
		const rotation = obs % CANDIDATES.length;
		for (let k = 0; k < CANDIDATES.length; k += 1) {
			const candidate = CANDIDATES[
				(k + rotation) % CANDIDATES.length
			] as Candidate;
			let witnessDigest = '';
			const elapsedMs = timeMs(() => {
				const next = reopenRetained(retained, owner, candidate);
				witnessDigest = next.store.scanWitness().digestHex;
			});
			raw.reopens.push({
				owner,
				candidate: candidate.id,
				buildId: handleFor(candidate.id).buildId,
				index: obs,
				orderPosition: k,
				elapsedMs,
				witnessDigest,
				witnessMatchesOracle: witnessDigest === oracle.digestHex,
			});
		}
	}

	// Per-cell summaries from the retained databases (not deleted here).
	for (const candidate of CANDIDATES) {
		const entry = handleFor(candidate.id);
		const witness = entry.store.scanWitness();
		const check = entry.db.prepare('PRAGMA integrity_check').get() as {
			integrity_check?: string;
		} | null;
		raw.cells.push({
			owner,
			candidate: candidate.id,
			buildId: entry.buildId,
			oracleReproduced:
				witness.count === oracle.currentCount &&
				witness.bytes === oracle.currentProtocolFactBytes &&
				witness.digestHex === oracle.digestHex,
			integrityOk: check?.integrity_check === 'ok',
			candidateTableBytes: entry.store.candidateTableBytes(),
			fileBytes: fileBytesOf(entry.path),
		});
	}

	// Mutating checkpoint tails with the full reset protocol. Tails build their own
	// transient reset databases; the retained eight are untouched here.
	for (const metric of RAW_TAIL_METRICS[owner]) {
		for (const candidate of CANDIDATES) {
			raw.tails.push(
				runTail(
					dir,
					profile,
					trace,
					owner,
					metric,
					candidate,
					seedIndex,
					facts,
				),
			);
		}
	}
	return { status: 'COMPLETE' };
}

export function buildCalibrationIncompleteArtifact(args: {
	provenance: ProvenanceConfig;
	manifestIdentity: string;
	refusal: Extract<OwnerRunResult, { status: 'INCOMPLETE' }>;
	completedSeedIds: number[];
	resumedSeedIds: number[];
}) {
	const reason = `${args.refusal.reasonCode}: selectedOps is null for ${args.refusal.owner}/${args.refusal.metric}: ${args.refusal.reason}`;
	return {
		kind: 'scalar-facts-layout-calibration-refusal',
		status: 'INCOMPLETE' as const,
		refusedToContinue: true,
		reasonCode: args.refusal.reasonCode,
		selectedOps: null,
		reason,
		seedId: args.refusal.seedId,
		owner: args.refusal.owner,
		metric: args.refusal.metric,
		minBlockMs: args.refusal.minBlockMs,
		maxBlockOps: args.refusal.maxBlockOps,
		trials: args.refusal.trials,
		manifestIdentity: args.manifestIdentity,
		completedSeedIds: args.completedSeedIds,
		resumedSeedIds: args.resumedSeedIds,
		provenance: args.provenance,
		method: null,
	};
}

function persistJsonAtomically(path: string, value: unknown): string {
	const serialized = `${JSON.stringify(value, null, 2)}\n`;
	const tempPath = `${path}.tmp`;
	writeFileSync(tempPath, serialized);
	renameSync(tempPath, path);
	return new Sha256Stream().update(serialized).digestHex();
}

/** One mutating checkpoint tail with the full declared reset protocol. */
function runTail(
	dir: string,
	profile: Profile,
	trace: Trace,
	owner: Owner,
	metric: string,
	candidate: Candidate,
	seedIndex: number,
	facts: readonly Fact[],
): TailObservation {
	const path = join(
		dir,
		`s${seedIndex}-${owner}-${candidate.id}-${metric}.sqlite`,
	);
	// Prestate witness from a first byte-equivalent build (outside timing).
	const first = buildOwnerDatabase(path, candidate, owner, facts, trace);
	const preWitness = withEphemeralDatabase({
		opened: first,
		path,
		operation: ({ store }) => store.scanWitness().digestHex,
	});
	// Reconstruct the byte-equivalent prestate, ANALYZE, checkpoint/truncate,
	// close and reopen.
	const reset = buildOwnerDatabase(path, candidate, owner, facts, trace);
	const resetVerified = withEphemeralDatabase({
		opened: reset,
		path,
		retainOnSuccess: true,
		operation: ({ db, store }) => {
			db.exec('ANALYZE');
			db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
			return store.scanWitness().digestHex === preWitness;
		},
	});
	const reopened = openExisting(path, candidate, { removeOnFailure: true });
	withEphemeralDatabase({
		opened: reopened,
		path,
		operation: ({ db, store }) => {
			// Three untimed warmup transactions.
			let warmupSeq = maxSequence(db, candidate) + 1;
			for (let w = 0; w < 3; w += 1) {
				applyTailTransaction(
					store,
					metric,
					owner,
					warmupSeq,
					seedIndex,
					-1 - w,
					trace,
				);
				warmupSeq += tailSequenceStride(metric);
			}
		},
	});
	// Restore the byte-equivalent prestate AGAIN before timing.
	const timedBuild = buildOwnerDatabase(path, candidate, owner, facts, trace);
	withEphemeralDatabase({
		opened: timedBuild,
		path,
		retainOnSuccess: true,
		operation: ({ db }) => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'),
	});
	const timed = openExisting(path, candidate, { removeOnFailure: true });
	const txnMs: number[] = [];
	let checkpointBoundaries = 0;
	withEphemeralDatabase({
		opened: timed,
		path,
		operation: ({ db, store }) => {
			db.exec('PRAGMA wal_autocheckpoint=1000'); // production autocheckpoint
			let sequence = maxSequence(db, candidate) + 1;
			const walBefore = () => walBytes(path);
			let priorWal = walBefore();
			for (let t = 0; t < profile.tailTransactions; t += 1) {
				txnMs.push(
					timeMs(() =>
						applyTailTransaction(
							store,
							metric,
							owner,
							sequence,
							seedIndex,
							t,
							trace,
						),
					),
				);
				sequence += tailSequenceStride(metric);
				const nowWal = walBefore();
				if (nowWal < priorWal) checkpointBoundaries += 1;
				priorWal = nowWal;
			}
		},
	});
	const sorted = [...txnMs].sort((a, b) => a - b);
	const total = txnMs.reduce((s, x) => s + x, 0);
	return {
		owner,
		metric,
		candidate: candidate.id,
		transactions: profile.tailTransactions,
		samplesMs: txnMs,
		p50Ms: percentile(sorted, 0.5),
		p95Ms: percentile(sorted, 0.95),
		p99Ms: percentile(sorted, 0.99),
		throughputPerSec: total > 0 ? (profile.tailTransactions / total) * 1000 : 0,
		resetVerified,
		warmupTransactions: 3,
		walDeltaDiagnostic: checkpointBoundaries,
		// WAL shrink is not a truthful autocheckpoint boundary signal, and inserting
		// a measurement checkpoint would perturb the production workload, so we do
		// not claim a truthful boundary count. This fails the checkpoint-truthful gate.
		checkpointSignalTruthful: false,
	};
}

/** How many sequence numbers one tail transaction consumes. */
function tailSequenceStride(metric: string): number {
	return metric === 'submissionSettlementTail' ? 3 : 1;
}

/** Apply one production-sized transaction for a tail metric. */
function applyTailTransaction(
	store: LayoutStore,
	metric: string,
	owner: Owner,
	sequence: number,
	seedIndex: number,
	t: number,
	trace: Trace,
): void {
	const offset = 40_000_000 + seedIndex * 2_000_000 + (t + 8) * 16;
	const rowId = (n: number) => n.toString(36).padStart(24, '0');
	switch (metric) {
		case 'monotonicInstallTail':
			store.installMonotonic({
				address: {
					kind: 'row',
					namespace: 'so.epicenter.ns00',
					table: 'collection0001',
					rowId: rowId(offset),
				},
				sequence,
				presence: 'present',
				fields: { body: 'x'.repeat(64), t, owner },
			});
			return;
		case 'rowTombstoneDocumentCleanupTail': {
			// Delete an existing row (with its document) drawn from the live corpus.
			const idx =
				trace.options.facts - 1 - ((t + 1) % (trace.options.facts - 1));
			const fact = trace.finalFactAt(idx);
			const address: RowAddress =
				fact.address.kind === 'row'
					? fact.address
					: {
							kind: 'row',
							namespace: 'so.epicenter.ns00',
							table: 'collection0001',
							rowId: rowId(offset),
						};
			store.deleteRowWithDocument(address, sequence);
			return;
		}
		case 'submissionSettlementTail': {
			const intents: Fact[] = [0, 1, 2].map((k) => ({
				address: {
					kind: 'row',
					namespace: 'so.epicenter.ns00',
					table: 'collection0001',
					rowId: rowId(offset + k),
				},
				sequence: 0,
				presence: 'present',
				fields: { body: 'y'.repeat(48), t, k },
			}));
			store.settleSubmission(
				`replica${rowId(seedIndex).slice(0, 17)}`,
				intents,
				sequence,
				digestOf('req', seedIndex, t),
			);
			return;
		}
		default:
			throw new Error(`unknown tail metric: ${metric}`);
	}
}

// --- Headroom preflight (all candidates, both owners) ------------------------

type Headroom = {
	passed: boolean;
	livePageBytes: number;
	walHeadroomBytes: number;
	tempCopyHeadroomBytes: number;
	perDatabaseBytes: number;
	requiredBytes: number;
	availableBytes: number | null;
	wallTimeEstimateSeconds: number | null;
	reason: string;
};

/**
 * A conservative wall-time model for one profile from the measured per-fact
 * install time and the run's actual build/read/tail structure. Builds dominate at
 * the exact envelope; reads are calibration-bounded, so they scale with block
 * count, not corpus size.
 */
function estimateWallSeconds(
	profile: Profile,
	perFactInstallSeconds: number,
): number {
	const buildSeconds = perFactInstallSeconds * profile.facts;
	const tailRuns =
		OWNERS.reduce((n, o) => n + RAW_TAIL_METRICS[o].length, 0) *
		CANDIDATES.length;
	// 8 retained + 8 macro builds, plus three full builds per tail run.
	const buildsPerSeed = 16 + tailRuns * 3;
	const readRuns = OWNERS.reduce((n, o) => n + RAW_READ_METRICS[o].length, 0);
	const blocksPerRun = Math.min(MAX_READ_BLOCKS, profile.cycles * 16);
	const readSecondsPerSeed =
		readRuns * blocksPerRun * 4 * ((profile.minBlockMs * 1.5) / 1000);
	const boundarySecondsPerSeed =
		readRuns * profile.cycles * 2 * (BOUNDARY_IDLE_MS / 1000);
	const tailTxnSecondsPerSeed = tailRuns * profile.tailTransactions * 0.0002;
	const reopenSecondsPerSeed =
		OWNERS.length * profile.reopenObservations * CANDIDATES.length * 0.002;
	const perSeed =
		buildsPerSeed * buildSeconds +
		readSecondsPerSeed +
		boundarySecondsPerSeed +
		tailTxnSecondsPerSeed +
		reopenSecondsPerSeed;
	return Math.ceil(perSeed * profile.seedCount);
}

export type ExactEnvelopeEstimate = {
	probeFacts: number;
	exactFacts: number;
	exactPresent: number;
	perFactInstallSeconds: number;
	perFactPageBytes: number;
	exactPerDatabaseBytes: number;
	totalDiskBytes: number;
	wallSeconds: number;
	wallCapSeconds: number;
	withinWallCap: boolean;
	availableBytes: number | null;
	headroomOk: boolean;
	feasible: boolean;
	refusedToRun: boolean;
	method: string;
};

/**
 * Measure a bounded probe build and extrapolate linearly to the frozen exact
 * envelope, producing a disk and wall-time estimate. This never runs the
 * multi-hour exact envelope; it always refuses to run and reports whether the
 * exact run would be feasible under the eight-hour cap and available headroom.
 */
function estimateExactEnvelope(dir: string): ExactEnvelopeEstimate {
	const probeTrace = traceFor(SMOKE, 0);
	const facts = finalFacts(probeTrace);
	const path = join(dir, 'estimate-probe.sqlite');
	let bytes = 0;
	const ms = timeMs(() => {
		const opened = buildOwnerDatabase(
			path,
			CANDIDATES[0] as Candidate,
			'replica',
			facts,
			probeTrace,
		);
		bytes = withEphemeralDatabase({
			opened,
			path,
			retainOnSuccess: true,
			operation: ({ db }) =>
				(
					db
						.prepare('SELECT COALESCE(SUM(pgsize),0) AS b FROM dbstat')
						.get() as { b: number }
				).b,
		});
	});
	removeDatabase(path);
	const perFactInstallSeconds = ms / 1000 / Math.max(1, facts.length);
	const perFactPageBytes = bytes / Math.max(1, facts.length);
	const exact = exactPilotProfile();
	// Per DB: live pages plus WAL and temp/copy allowance (approximated as three
	// live-page copies), with the 25% margin.
	const exactPerDatabaseBytes = Math.ceil(
		perFactPageBytes * exact.facts * 3 * HEADROOM_MARGIN,
	);
	const totalDiskBytes = exactPerDatabaseBytes * 8;
	const wallSeconds = estimateWallSeconds(exact, perFactInstallSeconds);
	const withinWallCap = wallSeconds <= WALL_TIME_CAP_SECONDS;
	let availableBytes: number | null = null;
	try {
		const fs = statfsSync(dir);
		availableBytes = fs.bavail * fs.bsize;
	} catch {
		availableBytes = null;
	}
	const headroomOk =
		availableBytes !== null && totalDiskBytes <= availableBytes;
	return {
		probeFacts: facts.length,
		exactFacts: exact.facts,
		exactPresent: exact.present,
		perFactInstallSeconds,
		perFactPageBytes,
		exactPerDatabaseBytes,
		totalDiskBytes,
		wallSeconds,
		wallCapSeconds: WALL_TIME_CAP_SECONDS,
		withinWallCap,
		availableBytes,
		headroomOk,
		feasible: withinWallCap && headroomOk,
		refusedToRun: true,
		method:
			'bounded probe (one replica build at smoke scale) extrapolated linearly to 1,000,000 present addresses / 512 MiB; never executed here',
	};
}

function headroomPreflight(
	dir: string,
	trace: Trace,
	profile: Profile,
): Headroom {
	const facts = finalFacts(trace);
	// Conservative per-database bound across all four candidates and both owner
	// populations: measure each, take the maximum live-page + WAL footprint, and the
	// slowest per-fact install time for the wall-time model.
	let livePageBytes = 0;
	let walHeadroomBytes = 0;
	let perFactInstallSeconds = 0;
	// A failed candidate is cleaned before its error escapes. Abort the preflight
	// rather than continuing with an incomplete maximum across candidates.
	for (const owner of OWNERS) {
		for (const candidate of CANDIDATES) {
			const path = join(dir, `headroom-${owner}-${candidate.id}.sqlite`);
			const buildMs = timeMs(() => {
				const opened = buildOwnerDatabase(path, candidate, owner, facts, trace);
				const { pageBytes, wal } = withEphemeralDatabase({
					opened,
					path,
					retainOnSuccess: true,
					operation: ({ db }) => {
						const pageBytes = (
							db
								.prepare('SELECT COALESCE(SUM(pgsize),0) AS b FROM dbstat')
								.get() as { b: number }
						).b;
						db.exec('PRAGMA wal_checkpoint(PASSIVE)');
						return { pageBytes, wal: walBytes(path) };
					},
				});
				livePageBytes = Math.max(livePageBytes, pageBytes);
				walHeadroomBytes = Math.max(walHeadroomBytes, wal);
			});
			removeDatabase(path);
			perFactInstallSeconds = Math.max(
				perFactInstallSeconds,
				buildMs / 1000 / Math.max(1, facts.length),
			);
		}
	}
	// Bounded WAL plus a temp/copy allowance (one extra live-page copy for ANALYZE
	// and checkpoint temporaries), then the 25% margin, over eight retained DBs.
	const tempCopyHeadroomBytes = livePageBytes;
	const perDatabaseBytes = Math.ceil(
		(livePageBytes + walHeadroomBytes + tempCopyHeadroomBytes) *
			HEADROOM_MARGIN,
	);
	const requiredBytes = perDatabaseBytes * 8;
	let availableBytes: number | null = null;
	try {
		const fs = statfsSync(dir);
		availableBytes = fs.bavail * fs.bsize;
	} catch {
		availableBytes = null;
	}
	// Wall-time estimate derived from the MEASURED per-fact install time and the
	// run's actual build/read/tail structure, not an invented constant.
	const wallTimeEstimateSeconds = estimateWallSeconds(
		profile,
		perFactInstallSeconds,
	);
	if (availableBytes === null) {
		return {
			passed: false,
			livePageBytes,
			walHeadroomBytes,
			tempCopyHeadroomBytes,
			perDatabaseBytes,
			requiredBytes,
			availableBytes,
			wallTimeEstimateSeconds,
			reason:
				'available disk space could not be read; refusing to retain databases',
		};
	}
	const passed = requiredBytes <= availableBytes;
	return {
		passed,
		livePageBytes,
		walHeadroomBytes,
		tempCopyHeadroomBytes,
		perDatabaseBytes,
		requiredBytes,
		availableBytes,
		wallTimeEstimateSeconds,
		reason: passed
			? 'sufficient headroom for eight envelope databases with a 25% margin'
			: `insufficient headroom: need ${requiredBytes} bytes, have ${availableBytes}`,
	};
}

// --- Provenance --------------------------------------------------------------

function sqliteVersion(): string {
	const db = new Database(':memory:');
	let outcome: { ok: true; value: string } | { ok: false; error: unknown };
	try {
		outcome = {
			ok: true,
			value: (db.prepare('SELECT sqlite_version() AS v').get() as { v: string })
				.v,
		};
	} catch (error) {
		outcome = { ok: false, error };
	}
	try {
		db.close();
	} catch (cause) {
		const closeError = new Error('Failed to close SQLite version database', {
			cause,
		});
		if (!outcome.ok) {
			throw new AggregateError(
				[outcome.error, closeError],
				'SQLite version lookup failed and cleanup was incomplete',
			);
		}
		throw closeError;
	}
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}

function buildProvenance(
	profile: Profile,
	sourceVersion: string,
	seedIds: number[],
	ddlHashes: Record<string, string>,
): ProvenanceConfig {
	const limits = pilotLimits();
	return {
		sourceVersion,
		profile: profile.name,
		isPilot: true,
		candidates: CANDIDATE_IDS,
		owners: [...OWNERS],
		seedIds,
		traceOptions: seedIds.map((_, seedIndex) =>
			traceOptionsFor(profile, seedIndex),
		),
		cycles: profile.cycles,
		reopenObservations: profile.reopenObservations,
		tailTransactions: profile.tailTransactions,
		maxReadBlocks: MAX_READ_BLOCKS,
		minBlockMs: profile.minBlockMs,
		maxBlockOps: profile.maxBlockOps,
		ddlHashes,
		limitsDigest: digestOf(
			'limits',
			canonicalize({ ...(limits as unknown as Record<string, number>) }),
		),
		runtime: { bun: Bun.version, sqlite: sqliteVersion() },
		executionSettings: {
			journal_mode: 'WAL',
			synchronous: 'NORMAL',
			page_size: 4096,
			foreign_keys: 'ON',
			recursive_triggers: 'ON',
			wal_autocheckpoint: 1000,
		},
		workloadDigest: digestOf(
			'workload',
			profile.facts,
			NAMESPACE_COUNT,
			TABLE_COUNT,
			VALUE_RATIO,
			profile.targetLogicalStateBytes,
			profile.maxEncodedFactBytes,
		),
		auxiliaryDigest: digestOf(
			'auxiliary',
			DEFAULT_AUXILIARY_OPTIONS.pendingCount,
			DEFAULT_AUXILIARY_OPTIONS.sealedIntentCount,
			DEFAULT_AUXILIARY_OPTIONS.parkedCount,
			DEFAULT_AUXILIARY_OPTIONS.documentCount,
			DEFAULT_AUXILIARY_OPTIONS.replicaCount,
		),
	};
}

function traceOptionsFor(profile: Profile, seedIndex: number) {
	return {
		facts: profile.facts,
		namespaceCount: NAMESPACE_COUNT,
		tableCount: TABLE_COUNT,
		valueRatio: VALUE_RATIO,
		dataSeed: BASE_SEED + seedIndex,
		targetLogicalStateBytes: profile.targetLogicalStateBytes,
		maxEncodedFactBytes: profile.maxEncodedFactBytes,
	};
}

function traceFor(profile: Profile, seedIndex: number): Trace {
	return makeTrace(traceOptionsFor(profile, seedIndex));
}

function provenanceTraceAt(provenance: ProvenanceConfig, seedIndex: number) {
	const options = provenance.traceOptions[seedIndex];
	if (options === undefined) {
		throw new Error(`trace options missing for seed index ${seedIndex}`);
	}
	return makeTrace(options);
}

// --- Gate derivation from retained raw observations --------------------------

function main(): void {
	let options: CliOptions;
	try {
		options = parseCli(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\n`);
		process.exit(2);
	}

	const sourceVersion = resolveSourceVersion();
	const dir = mkdtempSync(join(tmpdir(), 'scalar-pilot-'));
	const manifestPath = join(dir, 'manifest.json');
	const startedMs = performance.now();
	let preserveRunDirectory = false;

	// The exact-envelope pilot is never run in-process: it is estimated and refused.
	if (options.profile === 'pilot') {
		try {
			const estimate = estimateExactEnvelope(dir);
			const report = {
				kind: 'exact-envelope-pilot-estimate',
				refusedToRun: true,
				reason: estimate.feasible
					? 'exact-envelope pilot is estimated feasible but is not run here; launch is a separate, deliberate step'
					: `exact-envelope pilot refused: ${estimate.withinWallCap ? '' : 'estimated wall time exceeds the 8h cap'}${!estimate.withinWallCap && !estimate.headroomOk ? '; ' : ''}${estimate.headroomOk ? '' : 'insufficient disk headroom'}`,
				sourceVersion,
				exactProfile: exactPilotProfile(),
				estimate,
			};
			const serialized = `${JSON.stringify(report, null, 2)}\n`;
			const outputPath = options.output ?? join(dir, 'estimate.json');
			writeFileSync(outputPath, serialized);
			process.stdout.write(
				[
					'scalar-facts-layout EXACT-ENVELOPE PILOT ESTIMATE (refused to run)',
					`  exact: present=${estimate.exactPresent} facts=${estimate.exactFacts} proxy=${EXACT_PROXY_BYTES}B seeds=${EXACT_SEEDS} cycles=${EXACT_CYCLES}`,
					`  measured perFactInstall=${(estimate.perFactInstallSeconds * 1e6).toFixed(2)}us perFactPage=${estimate.perFactPageBytes.toFixed(1)}B`,
					`  estimated disk=${(estimate.totalDiskBytes / 1024 / 1024 / 1024).toFixed(2)}GiB (8 DBs) wall=${(estimate.wallSeconds / 3600).toFixed(2)}h (cap ${WALL_TIME_CAP_SECONDS / 3600}h)`,
					`  feasible=${estimate.feasible} (withinWallCap=${estimate.withinWallCap} headroomOk=${estimate.headroomOk}) refusedToRun=true`,
					`  report: ${outputPath}`,
				]
					.map((line) => `${line}\n`)
					.join(''),
			);
		} finally {
			if (options.output !== null && !options.keepArtifacts) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		return;
	}

	const profile: Profile = { ...SMOKE, seedCount: options.seedCount };

	try {
		const limits = pilotLimits();
		const seedIds = Array.from(
			{ length: profile.seedCount },
			(_, s) => BASE_SEED + s,
		);
		const ddlHashes = Object.fromEntries(
			CANDIDATES.map((c) => [c.id, ddlHash(c)]),
		);
		const provenance = buildProvenance(
			profile,
			sourceVersion,
			seedIds,
			ddlHashes,
		);

		let manifest: PilotManifest = createManifest(provenance);
		let resumedSeedIds: number[] = [];
		const priorManifestPath = options.output
			? `${options.output}.manifest.json`
			: null;
		if (priorManifestPath !== null && existsSync(priorManifestPath)) {
			const prior = parseManifest(readFileSync(priorManifestPath, 'utf8'));
			if (prior !== null) {
				const decision = decideResume(prior, provenance);
				if (decision.canResume) {
					manifest = prior;
					resumedSeedIds = decision.completedSeedIds;
				}
			}
		}

		const headroom = headroomPreflight(
			dir,
			provenanceTraceAt(provenance, 0),
			profile,
		);
		// A failed headroom preflight aborts BEFORE any seed begins: no seed commits,
		// so every committed seed is always a complete seed.
		if (!headroom.passed) {
			const outputPath = options.output ?? join(dir, 'report.json');
			const refusal = {
				kind: 'scalar-facts-layout-headroom-refusal',
				refusedToRun: true,
				reason: headroom.reason,
				headroom,
				provenance,
			};
			writeFileSync(outputPath, `${JSON.stringify(refusal, null, 2)}\n`);
			process.stdout.write(
				`headroom preflight FAILED: ${headroom.reason}; refused before seed 1\n`,
			);
			return;
		}

		for (let s = 0; s < profile.seedCount; s += 1) {
			const seedId = seedIds[s] as number;
			if (resumedSeedIds.includes(seedId)) continue;
			const trace = provenanceTraceAt(provenance, s);
			const schedule = buildSeedSchedule({
				seedId,
				candidates: CANDIDATE_IDS,
				cycles: profile.cycles,
				rotation: s,
			});
			const raw: SeedRawObservations = {
				letterMapping: schedule.letterMapping,
				lifecycle: {
					peakRetained: 0,
					liveAtCommit: 0,
					retainedThroughCommit: false,
				},
				probes: [],
				calibrations: [],
				blocks: [],
				boundaries: [],
				reopens: [],
				tails: [],
				macros: [],
				cells: [],
			};
			// Build and retain all eight owner-by-candidate databases for this seed,
			// run both owners against them, then commit, then delete them. The success
			// path never deletes before commit; a refused or failed seed deletes its
			// uncommitted temporary set without committing partial data.
			let retained: RetainedSet | null = null;
			try {
				const facts = finalFacts(trace);
				retained = buildRetainedSet(
					dir,
					s,
					manifest.identity,
					seedId,
					facts,
					trace,
				);
				raw.lifecycle.peakRetained = retained.peakLive;
				const ctx: SeedContext = {
					dir,
					profile,
					trace,
					seedIndex: s,
					seedId,
					schedule,
					configIdentity: manifest.identity,
					raw,
				};
				let calibrationRefusal: Extract<
					OwnerRunResult,
					{ status: 'INCOMPLETE' }
				> | null = null;
				for (const owner of OWNERS) {
					const result = runOwner(ctx, owner, retained);
					if (result.status === 'INCOMPLETE') {
						calibrationRefusal = result;
						break;
					}
				}
				if (calibrationRefusal !== null) {
					const artifact = buildCalibrationIncompleteArtifact({
						provenance,
						manifestIdentity: manifest.identity,
						refusal: calibrationRefusal,
						completedSeedIds: manifest.completedSeeds.map(
							(seed) => seed.seedId,
						),
						resumedSeedIds,
					});
					const outputPath =
						options.output ?? join(dir, 'calibration-incomplete.json');
					const reportHash = persistJsonAtomically(outputPath, artifact);
					if (options.output === null) preserveRunDirectory = true;
					process.stdout.write(
						`calibration INCOMPLETE: ${artifact.reason}\n  report: ${outputPath}\n  report sha256: ${reportHash}\n`,
					);
					process.exitCode = 1;
					return;
				}
				raw.lifecycle.liveAtCommit = retained.handles.size;
				// The record is now prepared for a durable write while all eight handles
				// remain live. If validation or persistence fails, no seed commits and the
				// finally block removes the handles, so no manifest can retain this claim.
				raw.lifecycle.retainedThroughCommit = true;

				// Validate the raw against its closed schema AND profile-aware
				// completeness BEFORE committing; an incomplete or malformed seed throws
				// and the finally block cleans up without committing partial data.
				if (!validateSeedRawClosed(raw).valid) {
					throw new Error(`seed ${seedId} raw failed closed validation`);
				}
				// Exact per-seed expectations: the schedule depends on this seed's index.
				const expectations = completenessExpectations(provenance, s);
				const completeness = validateSeedCompleteness(raw, expectations);
				if (!completeness.complete) {
					throw new Error(
						`seed ${seedId} raw incomplete: ${completeness.reasons.slice(0, 3).join('; ')}`,
					);
				}

				const traceBound =
					trace.calibration.traceAdmissible &&
					verifyTraceV1Binding(trace, limits).bound;
				const auxiliaryBound = allAuxiliaryBound(
					makeAuxiliaryTraces(trace, limits),
				);
				const estimators = buildSeedEstimators(raw, manifest.identity, seedId);
				const record = {
					seedId,
					estimators,
					hashes: {
						trace: trace.measure().digestHex,
						traceBound: traceBound ? '1' : '0',
						auxiliaryBound: auxiliaryBound ? '1' : '0',
					},
					raw,
				} satisfies SeedRecord;
				// Persist every durable manifest FIRST, then delete the retained set. A
				// write failure leaves all eight databases retained and the seed
				// uncommitted (the finally block cleans them up on abort).
				manifest = persistSeedCheckpoint({
					manifest,
					record,
					persist: (m) => {
						persistManifest(manifestPath, m);
						if (priorManifestPath !== null)
							persistManifest(priorManifestPath, m);
					},
				});
				cleanupRetainedSet(retained);
			} finally {
				// Retry any unfinished cleanup. A successful persist already updated
				// `manifest`, so a cleanup failure cannot hide or revert that commit.
				if (retained !== null && !retained.cleanedUp) {
					cleanupRetainedSet(retained);
				}
			}
		}

		// Derive everything from the committed manifest, so gates cover resumed AND
		// fresh seeds identically.
		const committed = manifest.completedSeeds;
		const allProbes = committed.flatMap(
			(s) => (s.raw.probes as ProbeObservation[]) ?? [],
		);
		const allCalibrations = committed.flatMap(
			(s) => (s.raw.calibrations as CalibrationObservation[]) ?? [],
		);
		const allBlocks = committed.flatMap(
			(s) => (s.raw.blocks as BlockObservation[]) ?? [],
		);
		const allReopens = committed.flatMap(
			(s) => (s.raw.reopens as ReopenObservation[]) ?? [],
		);
		const allTails = committed.flatMap(
			(s) => (s.raw.tails as TailObservation[]) ?? [],
		);
		const allCells = committed.flatMap(
			(s) => (s.raw.cells as CellObservation[]) ?? [],
		);
		const allMacros = committed.flatMap(
			(s) => (s.raw.macros as MacroObservation[]) ?? [],
		);
		const allBoundaries = committed.flatMap(
			(s) => (s.raw.boundaries as BoundaryObservation[]) ?? [],
		);

		const committedComplete =
			committed.length === profile.seedCount &&
			committed.every((seed, seedIndex) => {
				if (seed.seedId !== seedIds[seedIndex]) return false;
				return validateSeedCompleteness(
					seed.raw,
					completenessExpectations(provenance, seedIndex),
				).complete;
			});
		const estimatorsComplete =
			committedComplete &&
			committed.every((seed) =>
				estimatorsMatchRaw(
					seed.estimators,
					seed.raw,
					manifest.identity,
					seed.seedId,
				),
			);

		// Gates derived from retained observation completeness and content.
		const executed =
			allCells.length > 0 && allBlocks.length > 0 && allTails.length > 0;
		const oracleReproduced =
			executed && allCells.every((c) => c.oracleReproduced);
		const integrityOk = executed && allCells.every((c) => c.integrityOk);
		const calibrationMet =
			committedComplete &&
			allCalibrations.length > 0 &&
			allBlocks.every((b) => b.elapsedMs >= profile.minBlockMs);
		const warmupsRun =
			executed &&
			allBlocks.every(
				(b) => b.warmupMs.length === 3 && b.warmupMs.every((w) => w > 0),
			);
		// Whole-seed completeness compares every block against the single exact
		// Williams schedule owner, including position, predecessor, and boundary.
		const balanced = committedComplete;
		const reopenPerCell = new Map<string, number>();
		for (const r of allReopens) {
			const key = `${r.owner}/${r.candidate}/reopen`;
			reopenPerCell.set(key, (reopenPerCell.get(key) ?? 0) + 1);
		}
		const reopenSufficient =
			committedComplete &&
			allReopens.length ===
				profile.seedCount *
					OWNERS.length *
					CANDIDATES.length *
					profile.reopenObservations &&
			allReopens.every((r) => r.witnessMatchesOracle) &&
			[...reopenPerCell.values()].every(
				(count) => count === profile.reopenObservations * committed.length,
			);
		const resetProven =
			committedComplete &&
			allTails.length > 0 &&
			allTails.every(
				(t) =>
					t.resetVerified &&
					t.warmupTransactions === 3 &&
					t.transactions === profile.tailTransactions &&
					t.samplesMs.length === profile.tailTransactions,
			);
		const ownerWorkloadsExecuted = committedComplete;
		const rawObservationsRetained = committedComplete;
		const expectedCounts = seedIds.reduce(
			(total, _seedId, seedIndex) => {
				const perSeed = expectedObservationCounts(
					completenessExpectations(provenance, seedIndex),
				);
				for (const key of Object.keys(perSeed) as Array<keyof typeof perSeed>) {
					total[key] += perSeed[key];
				}
				return total;
			},
			{
				probes: 0,
				blocks: 0,
				boundaries: 0,
				reopens: 0,
				tails: 0,
				macros: 0,
				cells: 0,
			},
		);
		const actualCounts = {
			probes: allProbes.length,
			blocks: allBlocks.length,
			boundaries: allBoundaries.length,
			reopens: allReopens.length,
			tails: allTails.length,
			macros: allMacros.length,
			cells: allCells.length,
		};
		const observationCountsExact =
			committedComplete &&
			(Object.keys(expectedCounts) as Array<keyof typeof expectedCounts>).every(
				(key) => actualCounts[key] === expectedCounts[key],
			) &&
			allBlocks.reduce((count, block) => count + block.warmupMs.length, 0) ===
				expectedCounts.blocks * 3 &&
			allTails.reduce((count, tail) => count + tail.samplesMs.length, 0) ===
				expectedCounts.tails * profile.tailTransactions;
		// The frozen exact-envelope gate: a bounded smoke can never pass it, so it can
		// never be method-validated even when every other gate is green.
		const exactEnvelopeConformant =
			executed && oracleReproduced && isExactEnvelope(profile);
		// The checkpoint-boundary signal is not truthful (WAL shrink under-counts and a
		// measurement checkpoint would perturb the workload), so this gate fails.
		const checkpointBoundariesTruthful =
			allTails.length > 0 && allTails.every((t) => t.checkpointSignalTruthful);

		const proofInputs: ProofGateInputs = {
			oracleWitnessReproduced: oracleReproduced,
			crossCandidateConsistent: oracleReproduced,
			provenanceMatches: verifyProvenanceRoundTrip(manifestPath, provenance),
			estimatorsComplete,
			balanced,
			calibrationMet,
			warmupsRun,
			integrityOk,
			reopenObservationsSufficient: reopenSufficient,
			deterministicResetProven: resetProven,
			headroomPreflightPassed: headroom.passed,
			ownerWorkloadsExecuted,
			rawObservationsRetained,
			observationCountsExact,
			exactEnvelopeConformant,
			checkpointBoundariesTruthful,
		};
		const method = validateMethod(proofInputs);

		const durationMs = performance.now() - startedMs;
		const rawObservationCounts = {
			probes: allProbes.length,
			calibrations: allCalibrations.length,
			blocks: allBlocks.length,
			boundaries: allBoundaries.length,
			reopens: allReopens.length,
			tails: allTails.length,
			tailSamples: allTails.reduce(
				(count, tail) => count + tail.samplesMs.length,
				0,
			),
			warmups: allBlocks.reduce(
				(count, block) => count + block.warmupMs.length,
				0,
			),
			macros: allMacros.length,
			cells: allCells.length,
			expected: {
				...expectedCounts,
				warmups: expectedCounts.blocks * 3,
				tailSamples: expectedCounts.tails * profile.tailTransactions,
			},
			byOwnerMetric: countByOwnerMetric(
				allBlocks,
				allTails,
				allMacros,
				allReopens,
			),
		};
		const report = {
			kind: profile.exact
				? 'scalar-facts-layout-measurement-pilot'
				: 'scalar-facts-layout-complete-method-smoke',
			instrumentRole: 'measurement-method-pilot',
			isPilot: true,
			methodValidated: method.methodValidated,
			note: profile.exact
				? 'exact-envelope pilot'
				: 'complete-method smoke: exercises the method but can never be method-validated (exact-envelope gate fails)',
			profile,
			provenance,
			manifestIdentity: manifest.identity,
			environment: {
				bun: Bun.version,
				sqlite: sqliteVersion(),
				cpus: cpus().length,
			},
			durationMs,
			headroom,
			rawObservationCounts,
			gates: method.gates,
			method,
			completedSeedIds: committed.map((s) => s.seedId),
			resumedSeedIds,
			raw: committed.map((s) => ({ seedId: s.seedId, ...(s.raw as object) })),
		};
		const serialized = `${JSON.stringify(report, null, 2)}\n`;
		const reportHash = new Sha256Stream().update(serialized).digestHex();
		const outputPath = options.output ?? join(dir, 'report.json');
		writeFileSync(outputPath, serialized);

		process.stdout.write(
			[
				`scalar-facts-layout ${profile.exact ? 'EXACT-ENVELOPE PILOT' : 'COMPLETE-METHOD SMOKE'} (${profile.name})`,
				`  seeds=${profile.seedCount} candidates=${CANDIDATES.length} owners=${OWNERS.length} cycles=${profile.cycles} present~=${profile.present}`,
				`  duration=${(durationMs / 1000).toFixed(1)}s  resumed=${resumedSeedIds.length}`,
				`  raw: probes=${allProbes.length} calibrations=${allCalibrations.length} blocks=${allBlocks.length} boundaries=${allBoundaries.length} reopens=${allReopens.length} tails=${allTails.length} tailSamples=${rawObservationCounts.tailSamples} macros=${allMacros.length} cells=${allCells.length}`,
				`  headroom: ${headroom.passed} (perDB=${headroom.perDatabaseBytes}B, need=${headroom.requiredBytes}B, wallEst=${headroom.wallTimeEstimateSeconds ?? '?'}s)`,
				`  method validated: ${method.methodValidated}${profile.exact ? '' : ' (UNREACHABLE for a smoke: exact-envelope gate fails)'}`,
				`  failing gates: ${method.proofRefusals.map((r) => r.split(':')[0]).join(', ') || 'none'}`,
				`  report: ${outputPath}`,
				`  report sha256: ${reportHash}`,
			]
				.map((line) => `${line}\n`)
				.join(''),
		);
	} finally {
		if (!options.keepArtifacts && !preserveRunDirectory) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

function countByOwnerMetric(
	blocks: BlockObservation[],
	tails: TailObservation[],
	macros: MacroObservation[],
	reopens: ReopenObservation[],
): Record<string, number> {
	const counts: Record<string, number> = {};
	const bump = (key: string) => {
		counts[key] = (counts[key] ?? 0) + 1;
	};
	for (const b of blocks) bump(`${b.owner}/${b.metric}`);
	for (const t of tails) bump(`${t.owner}/${t.metric}`);
	for (const m of macros) bump(`${m.owner}/${m.metric}`);
	for (const r of reopens) bump(`${r.owner}/warmReopen`);
	return counts;
}

function verifyProvenanceRoundTrip(
	manifestPath: string,
	provenance: ProvenanceConfig,
): boolean {
	if (!existsSync(manifestPath)) return false;
	const reloaded = parseManifest(readFileSync(manifestPath, 'utf8'));
	return (
		reloaded !== null &&
		reloaded.identity === createManifest(provenance).identity
	);
}

// Only run when invoked as the CLI entry point, so tests can import the retained
// set and lifecycle helpers without executing a run.
if (import.meta.main) main();
