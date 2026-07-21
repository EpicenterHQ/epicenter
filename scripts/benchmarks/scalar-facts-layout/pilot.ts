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
 * before timing at least 400 production-autocheckpoint transactions. Headroom is
 * a conservative bound across all four candidates and both owner populations.
 * Every proof gate is DERIVED from retained observations, and the full raw
 * per-seed observations are persisted so a resumed run's gates cover committed
 * and fresh seeds identically.
 *
 * Method validation is not evidence readiness. This is a pilot: `isPilot` stays
 * true and evidence status stays provisional/incomplete because browser OPFS,
 * Cloudflare Durable Object, full-envelope final data, and a configured observed
 * SLO policy are all absent. Classifier-only (ADR-0161): nothing selects, ranks,
 * recommends, or returns a candidate id.
 */

import { Database } from 'bun:sqlite';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
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
import {
	commitSeed,
	createManifest,
	decideResume,
	type PilotManifest,
	type ProvenanceConfig,
	parseManifest,
	persistManifest,
	type SeedRecord,
} from './checkpoint.js';
import {
	evaluateEvidenceReadiness,
	type ProofGateInputs,
	UNCONFIGURED_SLO_POLICY,
	validateMethod,
} from './evidence-status.js';
import {
	CANDIDATES,
	type Candidate,
	configureNewDatabase,
	configureReopenedDatabase,
	createLayoutStore,
	ddlFor,
	ddlHash,
	type LayoutStore,
} from './layouts.js';
import { Sha256Stream } from './portable-hash.js';
import {
	balanceDiagnostics,
	buildSeedSchedule,
	type SeedSchedule,
	smallestPowerOfTwoForMinDuration,
} from './schedule.js';
import { computeFamilywise, type SeedLevelMetric } from './statistics.js';
import type { Address, Fact, RowAddress } from './trace.js';
import { factsForPresentTarget, makeTrace, type Trace } from './trace.js';
import { pilotLimits, verifyTraceV1Binding } from './v1-binding.js';

type Owner = 'replica' | 'authority';
const OWNERS: readonly Owner[] = ['replica', 'authority'];
const CANDIDATE_IDS = CANDIDATES.map((c) => c.id);

// --- Declared metrics --------------------------------------------------------

/** Read metrics interleaved across candidates in the Williams design, per owner. */
const READ_METRICS: Record<Owner, readonly string[]> = {
	replica: [
		'confirmedPointRead',
		'confirmedTraversal',
		'confirmedPendingOverlayRead',
	],
	authority: ['orderedResumeFeed', 'foldPointRead', 'exactRetrySettlementRead'],
};
/** Macro metrics measured once per outer unit and candidate on a fresh empty DB. */
const MACRO_METRIC: Record<Owner, string> = {
	replica: 'acquisitionInstall',
	authority: 'orderedFreshFeed',
};
/** Mutating checkpoint-tail metrics, per owner. */
const TAIL_METRICS: Record<Owner, readonly string[]> = {
	replica: ['monotonicInstallTail', 'rowTombstoneDocumentCleanupTail'],
	authority: ['submissionSettlementTail'],
};
/** Every declared metric per owner (reads + macro + tails + reopen). */
function declaredMetrics(owner: Owner): string[] {
	return [
		MACRO_METRIC[owner],
		...READ_METRICS[owner],
		...TAIL_METRICS[owner],
		'warmReopen',
	];
}

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
const EXACT_MIN_REOPENS = 20;
const EXACT_MIN_TAIL_TRANSACTIONS = 400;
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
		reopenObservations: EXACT_MIN_REOPENS,
		tailTransactions: EXACT_MIN_TAIL_TRANSACTIONS,
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
	reopenObservations: EXACT_MIN_REOPENS,
	tailTransactions: EXACT_MIN_TAIL_TRANSACTIONS,
};

const NAMESPACE_COUNT = 12;
const TABLE_COUNT = 200;
const BASE_SEED = 1000;
const BOOTSTRAP_DRAWS = 10_000;
const BOOTSTRAP_SEED = 0x5ca1ab1e;
const HEADROOM_MARGIN = 1.25;
const MIN_TIMED_BLOCK_MS = 20;
const MAX_READ_BLOCKS = 64; // spec cap per seed/candidate/owner/metric

/** Whether a run's dimensions match the frozen exact-envelope pilot exactly. */
function isExactEnvelope(profile: Profile): boolean {
	return (
		profile.exact &&
		profile.present === EXACT_PRESENT_ADDRESSES &&
		profile.targetLogicalStateBytes === EXACT_PROXY_BYTES &&
		profile.seedCount === EXACT_SEEDS &&
		profile.cycles === EXACT_CYCLES &&
		profile.reopenObservations >= EXACT_MIN_REOPENS &&
		profile.tailTransactions >= EXACT_MIN_TAIL_TRANSACTIONS
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

function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
		: (sorted[mid] as number);
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
	cycle: number;
	ordinal: number;
	position: number;
	predecessor: string | null;
	boundary: string;
	ops: number;
	warmupMs: [number, number, number];
	elapsedMs: number;
};
type ReopenObservation = {
	owner: Owner;
	candidate: string;
	index: number;
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
	elapsedMs: number;
	throughputPerSec: number;
};
type CellObservation = {
	owner: Owner;
	candidate: string;
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
type SeedRawObservations = {
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
	removeDatabase(path);
	const db = new Database(path);
	configureNewDatabase(db);
	db.exec(ddlFor(candidate));
	return { db, store: createLayoutStore(db, candidate) };
}
function openExisting(
	path: string,
	candidate: Candidate,
): { db: Database; store: LayoutStore } {
	const db = new Database(path);
	configureReopenedDatabase(db);
	return { db, store: createLayoutStore(db, candidate) };
}

/** Build a fully populated candidate database for one owner. */
function buildOwnerDatabase(
	path: string,
	candidate: Candidate,
	owner: Owner,
	facts: readonly Fact[],
	trace: Trace,
): { db: Database; store: LayoutStore } {
	const opened = openFresh(path, candidate);
	if (owner === 'authority') {
		opened.store.installFacts(
			[...facts].sort((a, b) => a.sequence - b.sequence),
		);
	} else {
		opened.store.installFacts(facts);
	}
	const aux = makeAuxiliaryTraces(trace, pilotLimits());
	if (owner === 'authority') opened.store.populateAuthorityAuxiliary(aux);
	else opened.store.populateReplicaAuxiliary(aux);
	opened.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	return opened;
}

// --- Read metric operations --------------------------------------------------

type ReadContext = {
	rows: readonly Address[];
	replicaIds: readonly string[];
	watermarks: readonly number[];
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
			for (let i = 0; i < ops; i += 1) store.traverse();
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
	raw: SeedRawObservations;
};

function runOwner(ctx: SeedContext, owner: Owner): void {
	const { dir, profile, trace, seedIndex, schedule, raw } = ctx;
	const facts = finalFacts(trace);
	const oracle = trace.measure();
	const tag = (candidate: string, suffix = '') =>
		join(dir, `s${seedIndex}-${owner}-${candidate}${suffix}.sqlite`);

	// Macro: acquisition/fresh-feed on a fresh empty database per candidate.
	for (const candidate of CANDIDATES) {
		const opened = openFresh(tag(candidate.id, '-macro'), candidate);
		const ordered =
			owner === 'authority'
				? [...facts].sort((a, b) => a.sequence - b.sequence)
				: facts;
		const elapsedMs = timeMs(() => opened.store.installFacts(ordered));
		opened.store.finalize();
		opened.db.close();
		removeDatabase(tag(candidate.id, '-macro'));
		raw.macros.push({
			owner,
			metric: MACRO_METRIC[owner],
			candidate: candidate.id,
			elapsedMs,
			throughputPerSec: elapsedMs > 0 ? (ordered.length / elapsedMs) * 1000 : 0,
		});
	}

	// Retained per-candidate databases for reads and reopen.
	const built = new Map<
		string,
		{ db: Database; store: LayoutStore; path: string }
	>();
	for (const candidate of CANDIDATES) {
		const path = tag(candidate.id);
		const opened = buildOwnerDatabase(path, candidate, owner, facts, trace);
		built.set(candidate.id, { ...opened, path });
	}

	// Disjoint deterministic probe sets: calibration, warmup, and timed use
	// non-overlapping address/watermark slices.
	const rows = trace.sampleRowAddresses(3072);
	const calibRows = rows.slice(0, 1024);
	const warmupRows = rows.slice(1024, 2048);
	const timedRows = rows.slice(2048, 3072);
	const replicaAux = makeAuxiliaryTraces(trace, pilotLimits());
	const replicaIds = replicaAux.retry.entries.map((r) => r.replicaId);
	const maxSeqFor = (candidate: Candidate) =>
		maxSequence(built.get(candidate.id)!.db, candidate);
	const watermarks = Array.from({ length: 256 }, (_, i) =>
		Math.floor((maxSeqFor(CANDIDATES[0] as Candidate) * i) / 256),
	);
	const ctxCalib: ReadContext = { rows: calibRows, replicaIds, watermarks };
	const ctxWarm: ReadContext = { rows: warmupRows, replicaIds, watermarks };
	const ctxTimed: ReadContext = { rows: timedRows, replicaIds, watermarks };

	for (const metric of READ_METRICS[owner]) {
		// Balanced calibration pass on disjoint probes: warm the metric path, probe
		// warm per-op seconds, target 1.5x the floor so a warm block stays over 20 ms.
		const perOpSeconds = CANDIDATES.map((candidate) => {
			const store = built.get(candidate.id)!.store;
			readOp(metric, store, ctxCalib, 2048, 0); // warm
			const probe = 2048;
			const ms = timeMs(() => readOp(metric, store, ctxCalib, probe, probe));
			return ms / 1000 / probe;
		});
		const ops =
			smallestPowerOfTwoForMinDuration(
				perOpSeconds,
				(profile.minBlockMs * 1.5) / 1000,
				profile.maxBlockOps,
			) ?? profile.maxBlockOps;

		let blockCount = 0;
		for (const block of schedule.blocks) {
			if (blockCount >= MAX_READ_BLOCKS) break;
			// At a pair/cycle boundary, perform a fixed idle plus a real connection
			// close/reopen for every candidate, and record the reopen work.
			if (
				block.precedingBoundary === 'pair' ||
				block.precedingBoundary === 'cycle'
			) {
				const idleMs = fixedIdle(BOUNDARY_IDLE_MS);
				let reopenOk = true;
				const reopenMs = timeMs(() => {
					for (const candidate of CANDIDATES) {
						const entry = built.get(candidate.id)!;
						entry.store.finalize();
						entry.db.close();
						const reopened = openExisting(entry.path, candidate);
						if (reopened.store.scanWitness().digestHex !== oracle.digestHex) {
							reopenOk = false;
						}
						built.set(candidate.id, { ...reopened, path: entry.path });
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
			const entry = built.get(block.candidate)!;
			// Three immediate untimed warmup batches on the SAME metric path, disjoint
			// probes, right before the timed block.
			const warmupMs: [number, number, number] = [0, 0, 0];
			for (let w = 0; w < 3; w += 1) {
				warmupMs[w] = timeMs(() =>
					readOp(metric, entry.store, ctxWarm, ops, w * ops),
				);
			}
			const elapsedMs = timeMs(() =>
				readOp(metric, entry.store, ctxTimed, ops, 0),
			);
			raw.blocks.push({
				owner,
				metric,
				candidate: block.candidate,
				cycle: block.cycle,
				ordinal: block.ordinal,
				position: block.positionInSequence,
				predecessor: block.predecessor,
				boundary: block.precedingBoundary,
				ops,
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
			const entry = built.get(candidate.id)!;
			entry.store.finalize();
			entry.db.close();
			let witnessDigest = '';
			const elapsedMs = timeMs(() => {
				const reopened = openExisting(entry.path, candidate);
				witnessDigest = reopened.store.scanWitness().digestHex;
				reopened.store.finalize();
				reopened.db.close();
			});
			raw.reopens.push({
				owner,
				candidate: candidate.id,
				index: obs,
				elapsedMs,
				witnessDigest,
				witnessMatchesOracle: witnessDigest === oracle.digestHex,
			});
			const reopened = openExisting(entry.path, candidate);
			built.set(candidate.id, { ...reopened, path: entry.path });
		}
	}

	// Per-cell summaries from the retained databases.
	for (const candidate of CANDIDATES) {
		const entry = built.get(candidate.id)!;
		const witness = entry.store.scanWitness();
		const check = entry.db.prepare('PRAGMA integrity_check').get() as {
			integrity_check?: string;
		} | null;
		raw.cells.push({
			owner,
			candidate: candidate.id,
			oracleReproduced:
				witness.count === oracle.currentCount &&
				witness.bytes === oracle.currentProtocolFactBytes &&
				witness.digestHex === oracle.digestHex,
			integrityOk: check?.integrity_check === 'ok',
			candidateTableBytes: entry.store.candidateTableBytes(),
			fileBytes: fileBytesOf(entry.path),
		});
	}
	for (const entry of built.values()) {
		entry.store.finalize();
		entry.db.close();
		removeDatabase(entry.path);
	}

	// Mutating checkpoint tails with the full reset protocol.
	for (const metric of TAIL_METRICS[owner]) {
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
	const preWitness = first.store.scanWitness().digestHex;
	first.store.finalize();
	first.db.close();
	removeDatabase(path);
	// Reconstruct the byte-equivalent prestate, ANALYZE, checkpoint/truncate,
	// close and reopen.
	const reset = buildOwnerDatabase(path, candidate, owner, facts, trace);
	reset.db.exec('ANALYZE');
	reset.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	const resetVerified = reset.store.scanWitness().digestHex === preWitness;
	reset.store.finalize();
	reset.db.close();
	const reopened = openExisting(path, candidate);
	// Three untimed warmup transactions.
	let warmupSeq = maxSequence(reopened.db, candidate) + 1;
	for (let w = 0; w < 3; w += 1) {
		applyTailTransaction(
			reopened.store,
			metric,
			owner,
			warmupSeq,
			seedIndex,
			-1 - w,
			trace,
		);
		warmupSeq += tailSequenceStride(metric);
	}
	reopened.store.finalize();
	reopened.db.close();
	// Restore the byte-equivalent prestate AGAIN before timing.
	removeDatabase(path);
	const timedBuild = buildOwnerDatabase(path, candidate, owner, facts, trace);
	timedBuild.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	timedBuild.store.finalize();
	timedBuild.db.close();
	const timed = openExisting(path, candidate);
	timed.db.exec('PRAGMA wal_autocheckpoint=1000'); // production autocheckpoint
	let sequence = maxSequence(timed.db, candidate) + 1;
	const txnMs: number[] = [];
	let checkpointBoundaries = 0;
	const walBefore = () => walBytes(path);
	let priorWal = walBefore();
	for (let t = 0; t < profile.tailTransactions; t += 1) {
		txnMs.push(
			timeMs(() =>
				applyTailTransaction(
					timed.store,
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
		if (nowWal < priorWal) checkpointBoundaries += 1; // autocheckpoint truncated the WAL
		priorWal = nowWal;
	}
	timed.store.finalize();
	timed.db.close();
	removeDatabase(path);
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
		OWNERS.reduce((n, o) => n + TAIL_METRICS[o].length, 0) * CANDIDATES.length;
	// 8 retained + 8 macro builds, plus three full builds per tail run.
	const buildsPerSeed = 16 + tailRuns * 3;
	const readRuns = OWNERS.reduce((n, o) => n + READ_METRICS[o].length, 0);
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
		bytes = (
			opened.db
				.prepare('SELECT COALESCE(SUM(pgsize),0) AS b FROM dbstat')
				.get() as { b: number }
		).b;
		opened.store.finalize();
		opened.db.close();
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
	for (const owner of OWNERS) {
		for (const candidate of CANDIDATES) {
			const path = join(dir, `headroom-${owner}-${candidate.id}.sqlite`);
			const buildMs = timeMs(() => {
				const opened = buildOwnerDatabase(path, candidate, owner, facts, trace);
				const pageBytes = (
					opened.db
						.prepare('SELECT COALESCE(SUM(pgsize),0) AS b FROM dbstat')
						.get() as { b: number }
				).b;
				opened.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
				const wal = walBytes(path);
				opened.store.finalize();
				opened.db.close();
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
	const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
	db.close();
	return row.v;
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
		cycles: profile.cycles,
		minBlockMs: profile.minBlockMs,
		bootstrapDraws: BOOTSTRAP_DRAWS,
		bootstrapSeed: BOOTSTRAP_SEED,
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

function traceFor(profile: Profile, seedIndex: number): Trace {
	return makeTrace({
		facts: profile.facts,
		namespaceCount: NAMESPACE_COUNT,
		tableCount: TABLE_COUNT,
		valueRatio: VALUE_RATIO,
		dataSeed: BASE_SEED + seedIndex,
		targetLogicalStateBytes: profile.targetLogicalStateBytes,
		maxEncodedFactBytes: profile.maxEncodedFactBytes,
	});
}

// --- Gate derivation from retained raw observations --------------------------

function familyFor(
	owner: Owner,
	seedIds: number[],
	readByOwner: Record<Owner, number[][]>,
	storageByOwner: Record<Owner, number[][]>,
): ReturnType<typeof computeFamilywise> {
	const metrics: SeedLevelMetric[] = [
		{
			key: `${owner}/readBlockMedianMs`,
			kind: 'latency',
			estimates: readByOwner[owner],
		},
		{
			key: `${owner}/candidateTableBytes`,
			kind: 'storage',
			estimates: storageByOwner[owner],
		},
	];
	return computeFamilywise({
		candidates: CANDIDATE_IDS,
		seedIds: seedIds.slice(0, readByOwner[owner].length),
		metrics,
		bootstrapDraws: BOOTSTRAP_DRAWS,
		bootstrapSeed: BOOTSTRAP_SEED,
	});
}

/** Every candidate shares one position profile within an owner+metric group. */
function executedReadBalance(blocks: BlockObservation[]): boolean {
	if (blocks.length === 0) return false;
	const groups = new Map<string, Map<string, number[]>>();
	for (const b of blocks) {
		const key = `${b.owner}/${b.metric}`;
		const byCandidate = groups.get(key) ?? new Map<string, number[]>();
		const pos = byCandidate.get(b.candidate) ?? [0, 0, 0, 0];
		pos[b.position] = (pos[b.position] ?? 0) + 1;
		byCandidate.set(b.candidate, pos);
		groups.set(key, byCandidate);
	}
	for (const byCandidate of groups.values()) {
		const profiles = [...byCandidate.values()].map((p) => JSON.stringify(p));
		if (new Set(profiles).size !== 1) return false;
		if (byCandidate.size !== CANDIDATES.length) return false;
	}
	return true;
}

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
				].join('\n') + '\n',
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

		const headroom = headroomPreflight(dir, traceFor(profile, 0), profile);

		for (let s = 0; s < profile.seedCount; s += 1) {
			const seedId = seedIds[s] as number;
			if (resumedSeedIds.includes(seedId)) continue;
			const trace = traceFor(profile, s);
			const schedule = buildSeedSchedule({
				seedId,
				candidates: CANDIDATE_IDS,
				cycles: profile.cycles,
				rotation: s,
			});
			const raw: SeedRawObservations = {
				blocks: [],
				boundaries: [],
				reopens: [],
				tails: [],
				macros: [],
				cells: [],
			};
			if (headroom.passed) {
				const ctx: SeedContext = {
					dir,
					profile,
					trace,
					seedIndex: s,
					seedId,
					schedule,
					raw,
				};
				for (const owner of OWNERS) runOwner(ctx, owner);
			}

			const traceBound =
				trace.calibration.traceAdmissible &&
				verifyTraceV1Binding(trace, limits).bound;
			const auxiliaryBound = allAuxiliaryBound(
				makeAuxiliaryTraces(trace, limits),
			);
			const estimators: Record<string, number> = {};
			for (const cell of raw.cells) {
				const reads = raw.blocks.filter(
					(b) => b.owner === cell.owner && b.candidate === cell.candidate,
				);
				estimators[`${cell.owner}/${cell.candidate}/readBlockMedianMs`] =
					median(reads.map((b) => b.elapsedMs));
				estimators[`${cell.owner}/${cell.candidate}/candidateTableBytes`] =
					cell.candidateTableBytes;
			}
			if (Object.keys(estimators).length === 0) {
				estimators['no-op/headroom-refused'] = 1; // keep a whole-seed record even if refused
			}
			manifest = commitSeed(manifest, {
				seedId,
				estimators,
				hashes: {
					trace: trace.measure().digestHex,
					traceBound: traceBound ? '1' : '0',
					auxiliaryBound: auxiliaryBound ? '1' : '0',
				},
				raw,
				seedGatesPassed: raw.cells.every(
					(c) => c.oracleReproduced && c.integrityOk,
				),
			} satisfies SeedRecord);
			persistManifest(manifestPath, manifest);
			if (priorManifestPath !== null)
				persistManifest(priorManifestPath, manifest);
		}

		// Derive everything from the committed manifest, so gates cover resumed AND
		// fresh seeds identically.
		const committed = manifest.completedSeeds;
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

		const readByOwner: Record<Owner, number[][]> = {
			replica: [],
			authority: [],
		};
		const storageByOwner: Record<Owner, number[][]> = {
			replica: [],
			authority: [],
		};
		for (const seed of committed) {
			for (const owner of OWNERS) {
				readByOwner[owner].push(
					CANDIDATE_IDS.map(
						(c) =>
							seed.estimators[`${owner}/${c}/readBlockMedianMs`] ?? Number.NaN,
					),
				);
				storageByOwner[owner].push(
					CANDIDATE_IDS.map(
						(c) =>
							seed.estimators[`${owner}/${c}/candidateTableBytes`] ??
							Number.NaN,
					),
				);
			}
		}
		const familyByOwner = {
			replica: familyFor('replica', seedIds, readByOwner, storageByOwner),
			authority: familyFor('authority', seedIds, readByOwner, storageByOwner),
		};
		const estimatorOk = familyByOwner.replica.ok && familyByOwner.authority.ok;

		// Gates derived from retained observation completeness and content.
		const executed =
			allCells.length > 0 && allBlocks.length > 0 && allTails.length > 0;
		const oracleReproduced =
			executed && allCells.every((c) => c.oracleReproduced);
		const integrityOk = executed && allCells.every((c) => c.integrityOk);
		const calibrationMet =
			executed && allBlocks.every((b) => b.elapsedMs >= MIN_TIMED_BLOCK_MS);
		const warmupsRun =
			executed &&
			allBlocks.every(
				(b) => b.warmupMs.length === 3 && b.warmupMs.every((w) => w > 0),
			);
		const balanced =
			executed &&
			committed.every(
				(s) =>
					balanceDiagnostics(
						[
							buildSeedSchedule({
								seedId: s.seedId,
								candidates: CANDIDATE_IDS,
								cycles: profile.cycles,
								rotation: s.seedId - BASE_SEED,
							}),
						],
						CANDIDATE_IDS,
					).positionBalanced,
			) &&
			executedReadBalance(allBlocks) &&
			allBlocks.some((b) => b.boundary === 'pair' || b.boundary === 'cycle');
		const reopenPerCell = new Map<string, number>();
		for (const r of allReopens) {
			const key = `${r.owner}/${r.candidate}/reopen`;
			reopenPerCell.set(key, (reopenPerCell.get(key) ?? 0) + 1);
		}
		const reopenSufficient =
			executed &&
			allReopens.length > 0 &&
			allReopens.every((r) => r.witnessMatchesOracle) &&
			[...reopenPerCell.values()].every(
				(count) => count >= profile.reopenObservations * committed.length,
			);
		const resetProven =
			allTails.length > 0 &&
			allTails.every(
				(t) =>
					t.resetVerified &&
					t.warmupTransactions === 3 &&
					t.transactions >= 400,
			);
		// Owner-workloads gate: every declared metric per owner appears in the
		// retained observations for every committed seed.
		const ownerWorkloadsExecuted =
			executed &&
			committed.every((s) => {
				const raw = s.raw as unknown as SeedRawObservations;
				const present = new Set<string>();
				for (const m of raw.macros) present.add(`${m.owner}/${m.metric}`);
				for (const b of raw.blocks) present.add(`${b.owner}/${b.metric}`);
				for (const t of raw.tails) present.add(`${t.owner}/${t.metric}`);
				if (raw.reopens.length > 0) {
					for (const owner of OWNERS) present.add(`${owner}/warmReopen`);
				}
				return OWNERS.every((owner) =>
					declaredMetrics(owner).every((metric) =>
						present.has(`${owner}/${metric}`),
					),
				);
			});
		const rawObservationsRetained =
			committed.length > 0 &&
			committed.every((s) => (s.raw.cells as unknown[]).length > 0);
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
			estimatorOk,
			balanced,
			calibrationMet,
			warmupsRun,
			integrityOk,
			reopenObservationsSufficient: reopenSufficient,
			deterministicResetProven: resetProven,
			headroomPreflightPassed: headroom.passed,
			ownerWorkloadsExecuted,
			rawObservationsRetained,
			exactEnvelopeConformant,
			checkpointBoundariesTruthful,
		};
		const method = validateMethod(proofInputs);
		// Feasibility only, not selection: every contrast interval must be finite (the
		// estimator produced a usable bound). No candidate classification is read here
		// or emitted in the report.
		const classifierResolved =
			estimatorOk &&
			[
				...familyByOwner.replica.contrasts,
				...familyByOwner.authority.contrasts,
			].every(
				(c) =>
					Number.isFinite(c.interval.lower) &&
					Number.isFinite(c.interval.upper),
			);
		const readiness = evaluateEvidenceReadiness({
			isPilot: true,
			method,
			sloPolicy: UNCONFIGURED_SLO_POLICY,
			sloObservations: null,
			expectedCells: [],
			matrixComplete: oracleReproduced,
			classifierResolved,
		});

		const durationMs = performance.now() - startedMs;
		const rawObservationCounts = {
			blocks: allBlocks.length,
			reopens: allReopens.length,
			tails: allTails.length,
			macros: allMacros.length,
			cells: allCells.length,
			byOwnerMetric: countByOwnerMetric(
				allBlocks,
				allTails,
				allMacros,
				allReopens,
			),
		};
		// Non-selecting feasibility ONLY: owner-and-kind interval half-widths and the
		// projected seed count to reach the target. No candidate identity, ranking, or
		// pairwise classification is emitted (spec: the pilot reports only an evidence
		// status). Per-candidate/per-metric diagnostics stay inside the raw arrays.
		const feasibility = OWNERS.map((owner) => ({
			owner,
			ok: familyByOwner[owner].ok,
			byKind: familyByOwner[owner].feasibility.map((f) => ({
				kind: f.kind,
				maxHalfWidth: f.maxHalfWidth,
				targetHalfWidth: f.targetHalfWidth,
				withinTarget: f.withinTarget,
				projectedSeeds: f.projectedSeeds,
			})),
		}));
		const report = {
			kind: profile.exact
				? 'scalar-facts-layout-measurement-pilot'
				: 'scalar-facts-layout-complete-method-smoke',
			classifierOnly: true,
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
			evidenceStatus: readiness,
			feasibility,
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
				`  raw: blocks=${allBlocks.length} boundaries=${committed.flatMap((s) => s.raw.boundaries as unknown[]).length} reopens=${allReopens.length} tails=${allTails.length} macros=${allMacros.length} cells=${allCells.length}`,
				`  headroom: ${headroom.passed} (perDB=${headroom.perDatabaseBytes}B, need=${headroom.requiredBytes}B, wallEst=${headroom.wallTimeEstimateSeconds ?? '?'}s)`,
				`  method validated: ${method.methodValidated}${profile.exact ? '' : ' (UNREACHABLE for a smoke: exact-envelope gate fails)'}`,
				`  failing gates: ${method.proofRefusals.map((r) => r.split(':')[0]).join(', ') || 'none'}`,
				`  evidence status: ${readiness.status.toUpperCase()} (isPilot; not ADR-ready)`,
				`  report: ${outputPath}`,
				`  report sha256: ${reportHash}`,
			].join('\n') + '\n',
		);
	} finally {
		if (!options.keepArtifacts) rmSync(dir, { recursive: true, force: true });
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

main();
