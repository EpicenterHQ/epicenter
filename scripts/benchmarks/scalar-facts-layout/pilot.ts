#!/usr/bin/env bun
/**
 * The modular exact-trace measurement-method SMOKE runner.
 *
 * This is deliberately named a smoke, not a validated measurement pilot. Its
 * proof gates are DERIVED FROM RECORDED OPERATIONS, never hardcoded, and because
 * the full declared owner-specific workload matrix (overlay, resume-feed,
 * exact-retry, row-tombstone document cleanup, and all three mutating checkpoint
 * tails for both owners) is not yet implemented, the `owner-workloads` gate fails
 * by construction, so `methodValidated` is UNREACHABLE here. The smoke exists to
 * exercise the real method wiring end to end (distinct replica and authority
 * workloads, calibration, immediate warmups, balanced Williams read blocks,
 * balanced reopen with retained witnesses, a real >= 400-transaction mutating tail
 * after a true reset, headroom preflight before retaining databases, per-seed
 * atomic checkpointing, and the seed-level familywise estimator) and to retain
 * raw observations so a reviewer can audit every derived gate.
 *
 * Classifier-only (ADR-0161): nothing selects, ranks, recommends, or returns a
 * candidate id. Evidence status is fail-closed and a pilot is never ADR-ready.
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
import type { Address, Fact } from './trace.js';
import { makeTrace, type Trace } from './trace.js';
import { pilotLimits, verifyTraceV1Binding } from './v1-binding.js';

// --- Owners ------------------------------------------------------------------

type Owner = 'replica' | 'authority';
const OWNERS: readonly Owner[] = ['replica', 'authority'];

/**
 * Distinct owner workloads. The read metric and mutating-tail differ per owner so
 * a run is not filename-only: the replica installs then point-reads and runs a
 * monotonic-install tail; the authority feeds facts in sequence order, fold-reads,
 * and runs a settlement tail. The full metric set (overlay, resume-feed, fold,
 * exact-retry, tombstone cleanup, all three tails each) is declared but not all
 * executed here, which is why the owner-workloads gate fails.
 */
const OWNER_DECLARED_METRICS: Record<Owner, readonly string[]> = {
	replica: [
		'acquisitionInstall',
		'confirmedPointRead',
		'confirmedTraversal',
		'confirmedPendingOverlayRead',
		'monotonicInstallTail',
		'rowTombstoneDocumentCleanupTail',
		'warmReopen',
	],
	authority: [
		'orderedFreshFeed',
		'orderedResumeFeed',
		'foldPointRead',
		'exactRetrySettlementRead',
		'submissionSettlementTail',
		'warmReopen',
	],
};
const OWNER_EXECUTED_METRICS: Record<Owner, readonly string[]> = {
	replica: [
		'acquisitionInstall',
		'confirmedPointRead',
		'monotonicInstallTail',
		'warmReopen',
	],
	authority: [
		'orderedFreshFeed',
		'foldPointRead',
		'submissionSettlementTail',
		'warmReopen',
	],
};

// --- Profiles ----------------------------------------------------------------

type Profile = {
	name: string;
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

const SMOKE: Profile = {
	name: 'smoke',
	facts: 4000,
	targetLogicalStateBytes: 4000 * 160,
	maxEncodedFactBytes: 4096,
	seedCount: 4,
	cycles: 3,
	minBlockMs: 20,
	maxBlockOps: 1 << 18,
	reopenObservations: 20,
	tailTransactions: 400,
};

const NAMESPACE_COUNT = 12;
const TABLE_COUNT = 200;
const VALUE_RATIO = 0.08;
const BASE_SEED = 1000;
const BOOTSTRAP_DRAWS = 10_000;
const BOOTSTRAP_SEED = 0x5ca1ab1e;
const HEADROOM_MARGIN = 1.25;
const MIN_TIMED_BLOCK_MS = 20;

// --- Strict CLI --------------------------------------------------------------

type CliOptions = {
	output: string | null;
	seedCount: number;
	keepArtifacts: boolean;
};

const USAGE = `scalar-facts-layout measurement smoke

Usage: bun scripts/benchmarks/scalar-facts-layout/pilot.ts [options]
  --output <path>   Write the JSON report to <path> (default: a temp file).
  --seeds <n>       Number of fresh seeds, >= 4 (default: ${SMOKE.seedCount}).
  --keep-artifacts  Keep the temporary database/manifest directory.
`;

class CliError extends Error {}

function parseCli(argv: readonly string[]): CliOptions {
	const options: CliOptions = {
		output: null,
		seedCount: SMOKE.seedCount,
		keepArtifacts: false,
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

// --- Source provenance (no generic placeholder) ------------------------------

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

// --- Timing and small helpers ------------------------------------------------

function timeMs(run: () => void): number {
	const start = performance.now();
	run();
	return performance.now() - start;
}

function sweep(
	store: LayoutStore,
	addresses: readonly Address[],
	count: number,
): void {
	const n = addresses.length;
	if (n === 0) return;
	for (let i = 0; i < count; i += 1) {
		const address = addresses[i % n];
		if (address !== undefined) store.pointRead(address);
	}
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
	const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
	return sortedAsc[index] as number;
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

// --- Raw observation model ---------------------------------------------------

type BlockObservation = {
	owner: Owner;
	candidate: string;
	seedId: number;
	cycle: number;
	ordinal: number;
	position: number;
	predecessor: string | null;
	boundary: string;
	ops: number;
	warmupMs: number;
	elapsedMs: number;
};

type ReopenObservation = {
	owner: Owner;
	candidate: string;
	seedId: number;
	index: number;
	elapsedMs: number;
	witnessDigest: string;
};

type MutatingTailObservation = {
	owner: Owner;
	candidate: string;
	seedId: number;
	transactions: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	resetVerified: boolean;
};

type CellSummary = {
	owner: Owner;
	candidate: string;
	seedId: number;
	oracleReproduced: boolean;
	integrityOk: boolean;
	readBlockMedianMs: number;
	reopenMedianMs: number;
	candidateTableBytes: number;
	fileBytes: number;
	calibratedOps: number;
	minBlockMs: number;
};

type SeedRaw = {
	seedId: number;
	blocks: BlockObservation[];
	reopens: ReopenObservation[];
	tails: MutatingTailObservation[];
	cells: CellSummary[];
	traceDigest: string;
	auxiliaryBound: boolean;
	traceBound: boolean;
	balancedPositions: boolean;
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

/** The highest sequence stored across the candidate's confirmed-fact table(s). */
function maxSequence(db: Database, candidate: Candidate): number {
	const sql =
		candidate.relation === 'unified'
			? 'SELECT COALESCE(MAX(sequence), 0) AS m FROM facts'
			: 'SELECT MAX(m) AS m FROM (SELECT COALESCE(MAX(sequence),0) AS m FROM row_facts UNION ALL SELECT COALESCE(MAX(sequence),0) FROM value_facts)';
	return (db.prepare(sql).get() as { m: number }).m;
}

function buildDatabase(
	dir: string,
	tag: string,
	candidate: Candidate,
	facts: readonly Fact[],
	owner: Owner,
	trace: Trace,
): { db: Database; store: LayoutStore; path: string } {
	const path = join(dir, `${tag}.sqlite`);
	removeDatabase(path);
	const db = new Database(path);
	configureNewDatabase(db);
	db.exec(ddlFor(candidate));
	const store = createLayoutStore(db, candidate);
	if (owner === 'authority') {
		// The authority feeds facts in ascending sequence order (ordered fresh feed).
		store.installFacts([...facts].sort((a, b) => a.sequence - b.sequence));
	} else {
		// The replica installs in address (index) order (acquisition/install).
		store.installFacts(facts);
	}
	store.populateAuxiliary(makeAuxiliaryTraces(trace, pilotLimits()));
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	return { db, store, path };
}

// --- Headroom preflight (before retaining the envelope databases) ------------

type Headroom = {
	passed: boolean;
	oneDatabaseBytes: number;
	requiredBytes: number;
	availableBytes: number | null;
	reason: string;
};

function headroomPreflight(dir: string, trace: Trace): Headroom {
	// Build ONE representative database, measure it, then delete it, so the estimate
	// precedes retaining any of the eight envelope databases. Fail closed if the
	// available space cannot be read.
	const facts = finalFacts(trace);
	const probe = buildDatabase(
		dir,
		'headroom-probe',
		CANDIDATES[0] as Candidate,
		facts,
		'replica',
		trace,
	);
	probe.store.finalize();
	probe.db.close();
	const oneDatabaseBytes = Math.max(fileBytesOf(probe.path), 1);
	removeDatabase(probe.path);
	const requiredBytes = Math.ceil(oneDatabaseBytes * 8 * HEADROOM_MARGIN);
	let availableBytes: number | null = null;
	try {
		const fs = statfsSync(dir);
		availableBytes = fs.bavail * fs.bsize;
	} catch {
		availableBytes = null;
	}
	if (availableBytes === null) {
		return {
			passed: false,
			oneDatabaseBytes,
			requiredBytes,
			availableBytes,
			reason:
				'available disk space could not be read; refusing to retain databases',
		};
	}
	const passed = requiredBytes <= availableBytes;
	return {
		passed,
		oneDatabaseBytes,
		requiredBytes,
		availableBytes,
		reason: passed
			? 'sufficient headroom for eight envelope databases with a 25% margin'
			: `insufficient headroom: need ${requiredBytes} bytes, have ${availableBytes}`,
	};
}

// --- One seed's distinct-owner workload --------------------------------------

function runSeedOwner(
	dir: string,
	profile: Profile,
	trace: Trace,
	owner: Owner,
	seedIndex: number,
	seedId: number,
	schedule: SeedSchedule,
	raw: SeedRaw,
): void {
	const oracle = trace.measure();
	const facts = finalFacts(trace);
	const built = new Map<string, ReturnType<typeof buildDatabase>>();
	for (const candidate of CANDIDATES) {
		built.set(
			candidate.id,
			buildDatabase(
				dir,
				`s${seedIndex}-${owner}-${candidate.id}`,
				candidate,
				facts,
				owner,
				trace,
			),
		);
	}
	const rowAddresses = trace.sampleRowAddresses(2048);
	const valueAddresses = trace.sampleValueAddresses(512);

	// Calibration: warm each candidate on the exact timed path (a rowAddresses
	// sweep), then probe its warm per-op seconds. Target 1.5x the minimum so that
	// even a warm, faster block stays above the 20 ms floor; the calibration gate
	// still checks the ACTUAL recorded block times against the floor, so this only
	// reduces flakiness, it does not weaken the proof.
	const perOpSeconds = CANDIDATES.map((candidate) => {
		const entry = built.get(candidate.id);
		if (entry === undefined) return Number.POSITIVE_INFINITY;
		sweep(entry.store, rowAddresses, 8192); // warm the timed path
		const probe = 8192;
		const ms = timeMs(() => sweep(entry.store, rowAddresses, probe));
		return ms / 1000 / probe;
	});
	const calibratedOps =
		smallestPowerOfTwoForMinDuration(
			perOpSeconds,
			(profile.minBlockMs * 1.5) / 1000,
			profile.maxBlockOps,
		) ?? profile.maxBlockOps;

	// Timed read blocks in balanced Williams order, each preceded by its OWN
	// immediate untimed warmup so warmup adjacency is a recorded fact.
	const readSamples = new Map<string, number[]>();
	for (const candidate of CANDIDATES) readSamples.set(candidate.id, []);
	for (const block of schedule.blocks) {
		const entry = built.get(block.candidate);
		if (entry === undefined) continue;
		const warmupMs = timeMs(() =>
			sweep(entry.store, valueAddresses, calibratedOps),
		);
		const elapsedMs = timeMs(() =>
			sweep(entry.store, rowAddresses, calibratedOps),
		);
		readSamples.get(block.candidate)?.push(elapsedMs);
		raw.blocks.push({
			owner,
			candidate: block.candidate,
			seedId,
			cycle: block.cycle,
			ordinal: block.ordinal,
			position: block.positionInSequence,
			predecessor: block.predecessor,
			boundary: block.precedingBoundary,
			ops: calibratedOps,
			warmupMs,
			elapsedMs,
		});
	}

	// Balanced reopen series with retained witnesses.
	const reopenSamples = new Map<string, number[]>();
	for (const candidate of CANDIDATES) reopenSamples.set(candidate.id, []);
	for (let obs = 0; obs < profile.reopenObservations; obs += 1) {
		for (const candidate of CANDIDATES) {
			const entry = built.get(candidate.id);
			if (entry === undefined) continue;
			entry.store.finalize();
			entry.db.close();
			let witnessDigest = '';
			const elapsedMs = timeMs(() => {
				const db = new Database(entry.path);
				configureReopenedDatabase(db);
				const store = createLayoutStore(db, candidate);
				witnessDigest = store.scanWitness().digestHex;
				store.finalize();
				db.close();
			});
			reopenSamples.get(candidate.id)?.push(elapsedMs);
			raw.reopens.push({
				owner,
				candidate: candidate.id,
				seedId,
				index: obs,
				elapsedMs,
				witnessDigest,
			});
			const db = new Database(entry.path);
			configureReopenedDatabase(db);
			built.set(candidate.id, {
				db,
				store: createLayoutStore(db, candidate),
				path: entry.path,
			});
		}
	}

	// A real >= 400-transaction mutating tail after a TRUE reset (rebuild the
	// byte-equivalent pre-state from the canonical trace, ANALYZE, checkpoint and
	// truncate the WAL, close and reopen), with reset verified by pre-state witness
	// equality. Replica: monotonic install. Authority: settlement install.
	for (const candidate of CANDIDATES) {
		// Build a separate tail database so the retained per-cell databases above
		// stay intact for the oracle, integrity, and storage summaries below.
		const first = buildDatabase(
			dir,
			`s${seedIndex}-${owner}-${candidate.id}-tail`,
			candidate,
			facts,
			owner,
			trace,
		);
		const preWitness = first.store.scanWitness().digestHex;
		first.store.finalize();
		first.db.close();
		removeDatabase(first.path);
		// True reset: reconstruct byte-equivalent pre-state from the same trace.
		const reset = buildDatabase(
			dir,
			`s${seedIndex}-${owner}-${candidate.id}-tail`,
			candidate,
			facts,
			owner,
			trace,
		);
		reset.db.exec('ANALYZE');
		reset.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		const resetVerified = reset.store.scanWitness().digestHex === preWitness;
		// Protocol-sized mutating transactions installing genuinely new rows at
		// sequences strictly above every existing one, so they neither collide with a
		// trace address nor reuse a sequence. Row ids are offset well past the trace
		// index range to stay outside its address space.
		const baseSeq = maxSequence(reset.db, candidate) + 1;
		const txnMs: number[] = [];
		for (let t = 0; t < profile.tailTransactions; t += 1) {
			const rowId = (20_000_000 + seedIndex * 1_000_000 + t)
				.toString(36)
				.padStart(24, '0');
			const fact: Fact = {
				address: {
					kind: 'row',
					namespace: 'so.epicenter.ns00',
					table: 'collection0001',
					rowId,
				},
				sequence: baseSeq + t,
				presence: 'present',
				fields: { body: 'x'.repeat(64), ordinal: t, owner },
			};
			txnMs.push(timeMs(() => reset.store.installFacts([fact])));
		}
		reset.store.finalize();
		reset.db.close();
		removeDatabase(reset.path);
		const sorted = [...txnMs].sort((a, b) => a - b);
		raw.tails.push({
			owner,
			candidate: candidate.id,
			seedId,
			transactions: profile.tailTransactions,
			p50Ms: percentile(sorted, 0.5),
			p95Ms: percentile(sorted, 0.95),
			p99Ms: percentile(sorted, 0.99),
			resetVerified,
		});
	}

	// Per-cell summaries: oracle witness (independent correctness), integrity_check,
	// reduced estimators, candidate-table storage.
	for (const candidate of CANDIDATES) {
		const entry = built.get(candidate.id);
		const witness = entry?.store.scanWitness();
		const oracleReproduced =
			witness !== undefined &&
			witness.count === oracle.currentCount &&
			witness.bytes === oracle.currentProtocolFactBytes &&
			witness.digestHex === oracle.digestHex;
		let integrityOk = false;
		if (entry !== undefined) {
			const check = entry.db.prepare('PRAGMA integrity_check').get() as {
				integrity_check?: string;
			} | null;
			integrityOk = check?.integrity_check === 'ok';
		}
		raw.cells.push({
			owner,
			candidate: candidate.id,
			seedId,
			oracleReproduced,
			integrityOk,
			readBlockMedianMs: median(readSamples.get(candidate.id) ?? []),
			reopenMedianMs: median(reopenSamples.get(candidate.id) ?? []),
			candidateTableBytes: entry?.store.candidateTableBytes() ?? 0,
			fileBytes: entry ? fileBytesOf(entry.path) : 0,
			calibratedOps,
			minBlockMs: Math.min(...(readSamples.get(candidate.id) ?? [Number.NaN])),
		});
	}

	for (const entry of built.values()) {
		entry.store.finalize();
		entry.db.close();
		removeDatabase(entry.path);
	}
}

// --- Orchestration -----------------------------------------------------------

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
		candidates: CANDIDATES.map((c) => c.id),
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

function sqliteVersion(): string {
	const db = new Database(':memory:');
	const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
	db.close();
	return row.v;
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

function main(): void {
	let options: CliOptions;
	try {
		options = parseCli(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\n`);
		process.exit(2);
	}

	const profile: Profile = { ...SMOKE, seedCount: options.seedCount };
	const sourceVersion = resolveSourceVersion();
	const dir = mkdtempSync(join(tmpdir(), 'scalar-smoke-'));
	const manifestPath = join(dir, 'manifest.json');
	const startedMs = performance.now();

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

		// Resume support: reload a prior manifest for the same identity from --output's
		// directory if present, else start fresh.
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

		// Headroom preflight BEFORE retaining any envelope databases.
		const headroom = headroomPreflight(dir, traceFor(profile, 0));

		const rawSeeds: SeedRaw[] = [];
		const readByOwner: Record<Owner, number[][]> = {
			replica: [],
			authority: [],
		};
		const storageByOwner: Record<Owner, number[][]> = {
			replica: [],
			authority: [],
		};

		for (let s = 0; s < profile.seedCount; s += 1) {
			const seedId = seedIds[s] as number;
			if (resumedSeedIds.includes(seedId)) continue; // already committed by a prior run
			const trace = traceFor(profile, s);
			const schedule = buildSeedSchedule({
				seedId,
				candidates: CANDIDATES.map((c) => c.id),
				cycles: profile.cycles,
				rotation: s,
			});
			const raw: SeedRaw = {
				seedId,
				blocks: [],
				reopens: [],
				tails: [],
				cells: [],
				traceDigest: trace.measure().digestHex,
				auxiliaryBound: allAuxiliaryBound(makeAuxiliaryTraces(trace, limits)),
				traceBound:
					trace.calibration.traceAdmissible &&
					verifyTraceV1Binding(trace, limits).bound,
				balancedPositions: balanceDiagnostics(
					[schedule],
					CANDIDATES.map((c) => c.id),
				).positionBalanced,
			};
			if (headroom.passed) {
				for (const owner of OWNERS) {
					runSeedOwner(dir, profile, trace, owner, s, seedId, schedule, raw);
				}
			}
			rawSeeds.push(raw);

			// Commit this whole seed to the persisted manifest before moving on.
			const estimators: Record<string, number> = {};
			for (const cell of raw.cells) {
				estimators[`${cell.owner}/${cell.candidate}/readBlockMedianMs`] =
					cell.readBlockMedianMs;
				estimators[`${cell.owner}/${cell.candidate}/candidateTableBytes`] =
					cell.candidateTableBytes;
			}
			if (Object.keys(estimators).length > 0) {
				manifest = commitSeed(manifest, {
					seedId,
					estimators,
					hashes: { trace: raw.traceDigest },
					seedGatesPassed: raw.cells.every(
						(c) => c.oracleReproduced && c.integrityOk,
					),
				} satisfies SeedRecord);
				persistManifest(manifestPath, manifest);
				if (priorManifestPath !== null)
					persistManifest(priorManifestPath, manifest);
			}
		}

		// Assemble seed-level matrices for the estimator from committed seeds.
		for (const seed of manifest.completedSeeds) {
			for (const owner of OWNERS) {
				const readRow = CANDIDATES.map(
					(c) =>
						seed.estimators[`${owner}/${c.id}/readBlockMedianMs`] ?? Number.NaN,
				);
				const storageRow = CANDIDATES.map(
					(c) =>
						seed.estimators[`${owner}/${c.id}/candidateTableBytes`] ??
						Number.NaN,
				);
				readByOwner[owner].push(readRow);
				storageByOwner[owner].push(storageRow);
			}
		}

		const familyByOwner = {
			replica: familyFor('replica', seedIds, readByOwner, storageByOwner),
			authority: familyFor('authority', seedIds, readByOwner, storageByOwner),
		};

		// Derive proof gates FROM RECORDED OBSERVATIONS. Nothing here is hardcoded.
		const allBlocks = rawSeeds.flatMap((r) => r.blocks);
		const allCells = rawSeeds.flatMap((r) => r.cells);
		const allTails = rawSeeds.flatMap((r) => r.tails);
		const executedCells = allCells.length > 0;
		const calibrationMet =
			executedCells &&
			allBlocks.length > 0 &&
			allBlocks.every((b) => b.elapsedMs >= MIN_TIMED_BLOCK_MS);
		const warmupsRun = executedCells && allBlocks.every((b) => b.warmupMs > 0);
		const balanced =
			rawSeeds.length > 0 &&
			rawSeeds.every((r) => r.balancedPositions) &&
			executedBalance(allBlocks);
		const reopenCounts = countReopens(rawSeeds);
		const reopenSufficient =
			executedCells &&
			reopenCounts.every((count) => count >= profile.reopenObservations);
		const oracleReproduced =
			executedCells && allCells.every((c) => c.oracleReproduced);
		const integrityOk = executedCells && allCells.every((c) => c.integrityOk);
		const resetProven =
			allTails.length > 0 && allTails.every((t) => t.resetVerified);
		const estimatorOk = familyByOwner.replica.ok && familyByOwner.authority.ok;
		// The full declared owner workload matrix is not implemented; this gate fails
		// by construction so methodValidated is unreachable in the smoke.
		const ownerWorkloadsExecuted = OWNERS.every(
			(owner) =>
				OWNER_EXECUTED_METRICS[owner].length ===
				OWNER_DECLARED_METRICS[owner].length,
		);

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
			rawObservationsRetained: rawSeeds.length > 0,
		};
		const method = validateMethod(proofInputs);
		const classifierResolved =
			estimatorOk &&
			[
				...familyByOwner.replica.contrasts,
				...familyByOwner.authority.contrasts,
			].every((c) => c.classification !== 'inconclusive');
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
		const report = {
			kind: 'scalar-facts-layout-measurement-smoke',
			classifierOnly: true,
			isPilot: true,
			methodValidated: method.methodValidated,
			note: 'a smoke that derives gates from recorded operations; not a validated pilot',
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
			ownerMetrics: {
				declared: OWNER_DECLARED_METRICS,
				executed: OWNER_EXECUTED_METRICS,
			},
			gates: method.gates,
			method,
			evidenceStatus: readiness,
			familywise: familyByOwner,
			raw: rawSeeds,
			resumedSeedIds,
		};
		const serialized = `${JSON.stringify(report, null, 2)}\n`;
		const reportHash = new Sha256Stream().update(serialized).digestHex();
		const outputPath = options.output ?? join(dir, 'report.json');
		writeFileSync(outputPath, serialized);

		process.stdout.write(
			[
				`scalar-facts-layout measurement SMOKE (${profile.name})`,
				`  seeds=${profile.seedCount} candidates=${CANDIDATES.length} owners=${OWNERS.length}`,
				`  duration=${(durationMs / 1000).toFixed(1)}s  resumed=${resumedSeedIds.length}`,
				`  headroom preflight: ${headroom.passed} (${headroom.reason})`,
				`  method validated: ${method.methodValidated} (UNREACHABLE by design: owner-workloads gate fails)`,
				`  failing gates: ${method.proofRefusals.map((r) => r.split(':')[0]).join(', ') || 'none'}`,
				`  evidence status: ${readiness.status.toUpperCase()} (classifier-only; no recommendation)`,
				`  report: ${outputPath}`,
				`  report sha256: ${reportHash}`,
			].join('\n') + '\n',
		);
	} finally {
		if (!options.keepArtifacts) rmSync(dir, { recursive: true, force: true });
	}
}

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
		candidates: CANDIDATES.map((c) => c.id),
		seedIds: seedIds.slice(0, readByOwner[owner].length),
		metrics,
		bootstrapDraws: BOOTSTRAP_DRAWS,
		bootstrapSeed: BOOTSTRAP_SEED,
	});
}

/** Every candidate appears equally at each Williams position in the executed order. */
function executedBalance(blocks: BlockObservation[]): boolean {
	if (blocks.length === 0) return false;
	const perOwner = new Map<string, Map<string, number[]>>();
	for (const block of blocks) {
		const ownerMap = perOwner.get(block.owner) ?? new Map<string, number[]>();
		const positions = ownerMap.get(block.candidate) ?? [0, 0, 0, 0];
		positions[block.position] = (positions[block.position] ?? 0) + 1;
		ownerMap.set(block.candidate, positions);
		perOwner.set(block.owner, ownerMap);
	}
	for (const ownerMap of perOwner.values()) {
		const profiles = [...ownerMap.values()].map((p) => JSON.stringify(p));
		if (new Set(profiles).size !== 1) return false;
	}
	return true;
}

function countReopens(rawSeeds: SeedRaw[]): number[] {
	const counts = new Map<string, number>();
	for (const seed of rawSeeds) {
		for (const r of seed.reopens) {
			const key = `${r.owner}/${r.candidate}/${r.seedId}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return [...counts.values()];
}

/** Persist and reload the manifest, confirming the identity round-trips (provenance gate). */
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
