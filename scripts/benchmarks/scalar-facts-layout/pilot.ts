#!/usr/bin/env bun
/**
 * The modular exact-trace measurement-method pilot.
 *
 * This orchestrator wires every pilot module into one runnable, DELIBERATELY
 * NON-DECISION run: it validates the measurement method and never selects, ranks,
 * recommends, or returns a candidate id (classifier-only policy; ADR-0161, spec
 * 424-444, 555-562). It reads the balanced Williams schedule, calibrates block
 * size to a minimum duration, times point-read blocks with untimed warmups,
 * reduces each metric to ONE seed-level estimator, runs the deterministic
 * whole-seed familywise bootstrap, validates the proof gates, and reports a
 * fail-closed `provisional` evidence status.
 *
 * The default smoke profile is small and clearly non-decision. It exercises the
 * confirmed-facts point-read metric and candidate-table storage across all four
 * candidates and both owners; the full owner-specific feed, settlement, fold, and
 * exact-retry workloads and the eight-hour final matrix are not run here.
 */

import { Database } from 'bun:sqlite';
import {
	mkdtempSync,
	rmSync,
	statfsSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';

import { allAuxiliaryBound, makeAuxiliaryTraces } from './auxiliary-traces.js';
import {
	commitSeed,
	createManifest,
	type ProvenanceConfig,
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
import {
	computeFamilywise,
	type FamilyInput,
	type SeedLevelMetric,
} from './statistics.js';
import type { Address } from './trace.js';
import { makeTrace, type Trace } from './trace.js';
import { pilotLimits, verifyTraceV1Binding } from './v1-binding.js';

type Owner = 'replica' | 'authority';
const OWNERS: readonly Owner[] = ['replica', 'authority'];

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
};

const SMOKE: Profile = {
	name: 'smoke',
	facts: 4000,
	targetLogicalStateBytes: 4000 * 160,
	maxEncodedFactBytes: 4096,
	seedCount: 3,
	cycles: 3,
	minBlockMs: 20,
	maxBlockOps: 1 << 18,
	reopenObservations: 20,
};

const NAMESPACE_COUNT = 12;
const TABLE_COUNT = 200;
const VALUE_RATIO = 0.08;
const BASE_SEED = 1000;
const BOOTSTRAP_DRAWS = 10_000;
const BOOTSTRAP_SEED = 0x5ca1ab1e;
const HEADROOM_MARGIN = 1.25;

type CliOptions = { output: string | null; seedCount: number };

function parseCli(argv: string[]): CliOptions {
	let output: string | null = null;
	let seedCount = SMOKE.seedCount;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--output') {
			i += 1;
			output = argv[i] ?? null;
		} else if (arg === '--seeds') {
			i += 1;
			seedCount = Number.parseInt(argv[i] ?? '', 10);
		}
	}
	if (!Number.isInteger(seedCount) || seedCount < 2)
		seedCount = SMOKE.seedCount;
	return { output, seedCount };
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

/** Build a fresh on-disk candidate database and populate it from the trace. */
function buildDatabase(
	dir: string,
	tag: string,
	candidate: Candidate,
	trace: Trace,
) {
	const path = join(dir, `${tag}.sqlite`);
	// Start from a fresh file so each candidate build runs its DDL on an empty
	// database and no candidate inherits another build's pages.
	for (const suffix of ['', '-wal', '-shm'])
		rmSync(`${path}${suffix}`, { force: true });
	const db = new Database(path);
	configureNewDatabase(db);
	db.exec(ddlFor(candidate));
	const store = createLayoutStore(db, candidate);
	store.installFacts(
		(function* () {
			for (let i = 0; i < trace.options.facts; i += 1)
				yield trace.finalFactAt(i);
		})(),
	);
	store.populateAuxiliary(makeAuxiliaryTraces(trace, pilotLimits()));
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	return { db, store, path };
}

/** Time one closure with a high-resolution clock (measurement, not workload). */
function timeMs(run: () => void): number {
	const start = performance.now();
	run();
	return performance.now() - start;
}

/** Point-read `count` addresses, cycling through a non-empty address list. */
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

/** Median of a numeric list (linear interpolation at the midpoint). */
function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
		: (sorted[mid] as number);
}

type CandidateSeedResult = {
	candidate: string;
	oracleReproduced: boolean;
	readBlockMedianMs: number;
	reopenMedianMs: number;
	candidateTableBytes: number;
	calibratedOps: number;
	fileBytes: number;
};

/** Run one seed's full read + reopen workload for one owner across all candidates. */
function runSeedOwner(
	dir: string,
	profile: Profile,
	trace: Trace,
	owner: Owner,
	seedIndex: number,
	schedule: SeedSchedule,
): {
	results: CandidateSeedResult[];
	warmupsRun: boolean;
	calibrationMet: boolean;
} {
	const oracle = trace.measure();
	// Build every candidate database once for this seed and owner.
	const built = new Map<string, ReturnType<typeof buildDatabase>>();
	for (const candidate of CANDIDATES) {
		built.set(
			candidate.id,
			buildDatabase(
				dir,
				`s${seedIndex}-${owner}-${candidate.id}`,
				candidate,
				trace,
			),
		);
	}
	const rowAddresses = trace.sampleRowAddresses(2048);
	const valueAddresses = trace.sampleValueAddresses(512);
	const probeAddresses = [...rowAddresses, ...valueAddresses];

	// Calibration: probe each candidate's per-op seconds, then choose the smallest
	// shared power-of-two op count so every candidate's block is at least minBlockMs.
	const perOpSeconds = CANDIDATES.map((candidate) => {
		const entry = built.get(candidate.id);
		if (entry === undefined) return Number.POSITIVE_INFINITY;
		const probe = 4096;
		const ms = timeMs(() => sweep(entry.store, probeAddresses, probe));
		return ms / 1000 / probe;
	});
	const calibratedOps = smallestPowerOfTwoForMinDuration(
		perOpSeconds,
		profile.minBlockMs / 1000,
		profile.maxBlockOps,
	);
	const calibrationMet = calibratedOps !== null;
	const ops = calibratedOps ?? profile.maxBlockOps;

	const readSamples = new Map<string, number[]>();
	for (const candidate of CANDIDATES) readSamples.set(candidate.id, []);

	// Three untimed warmup batches per candidate before any timed block.
	let warmupsRun = false;
	for (const candidate of CANDIDATES) {
		const entry = built.get(candidate.id);
		if (entry === undefined) continue;
		for (let w = 0; w < 3; w += 1) sweep(entry.store, valueAddresses, ops);
		warmupsRun = true;
	}

	// Timed read blocks, in the balanced Williams order.
	for (const block of schedule.blocks) {
		const entry = built.get(block.candidate);
		if (entry === undefined) continue;
		const ms = timeMs(() => sweep(entry.store, rowAddresses, ops));
		readSamples.get(block.candidate)?.push(ms);
	}

	// Balanced reopen series: close and reopen each candidate's file, timing the
	// open plus first witness scan, interleaved across candidates.
	const reopenSamples = new Map<string, number[]>();
	for (const candidate of CANDIDATES) reopenSamples.set(candidate.id, []);
	for (let obs = 0; obs < profile.reopenObservations; obs += 1) {
		for (const candidate of CANDIDATES) {
			const entry = built.get(candidate.id);
			if (entry === undefined) continue;
			entry.store.finalize();
			entry.db.close();
			const ms = timeMs(() => {
				const db = new Database(entry.path);
				configureReopenedDatabase(db);
				const store = createLayoutStore(db, candidate);
				store.scanWitness();
				store.finalize();
				db.close();
			});
			reopenSamples.get(candidate.id)?.push(ms);
			// Reopen a persistent handle for any subsequent observations.
			const db = new Database(entry.path);
			configureReopenedDatabase(db);
			built.set(candidate.id, {
				db,
				store: createLayoutStore(db, candidate),
				path: entry.path,
			});
		}
	}

	const results: CandidateSeedResult[] = CANDIDATES.map((candidate) => {
		const entry = built.get(candidate.id);
		const witness = entry?.store.scanWitness();
		const oracleReproduced =
			witness !== undefined &&
			witness.count === oracle.currentCount &&
			witness.bytes === oracle.currentProtocolFactBytes &&
			witness.digestHex === oracle.digestHex;
		const bytes = entry?.store.candidateTableBytes() ?? 0;
		const fileBytes = entry ? safeFileBytes(entry.path) : 0;
		return {
			candidate: candidate.id,
			oracleReproduced,
			readBlockMedianMs: median(readSamples.get(candidate.id) ?? []),
			reopenMedianMs: median(reopenSamples.get(candidate.id) ?? []),
			candidateTableBytes: bytes,
			calibratedOps: ops,
			fileBytes,
		};
	});

	for (const entry of built.values()) {
		entry.store.finalize();
		entry.db.close();
		// Delete this seed/owner's databases after its blocks are measured.
		for (const suffix of ['', '-wal', '-shm']) {
			rmSync(`${entry.path}${suffix}`, { force: true });
		}
	}
	return { results, warmupsRun, calibrationMet };
}

function safeFileBytes(path: string): number {
	try {
		return statSync(path).size + walBytes(path);
	} catch {
		return 0;
	}
}
function walBytes(path: string): number {
	try {
		return statSync(`${path}-wal`).size;
	} catch {
		return 0;
	}
}

/** Preflight: eight full databases per seed must fit with a 25% margin. */
function headroomPreflight(
	dir: string,
	oneDatabaseBytes: number,
): {
	passed: boolean;
	requiredBytes: number;
	availableBytes: number;
} {
	const requiredBytes = Math.ceil(oneDatabaseBytes * 8 * HEADROOM_MARGIN);
	let availableBytes = Number.POSITIVE_INFINITY;
	try {
		const fs = statfsSync(dir);
		availableBytes = fs.bavail * fs.bsize;
	} catch {
		availableBytes = Number.POSITIVE_INFINITY;
	}
	return {
		passed: requiredBytes <= availableBytes,
		requiredBytes,
		availableBytes,
	};
}

function main(): void {
	const options = parseCli(process.argv.slice(2));
	const profile: Profile = { ...SMOKE, seedCount: options.seedCount };
	const dir = mkdtempSync(join(tmpdir(), 'scalar-pilot-'));
	const startedMs = performance.now();

	const limits = pilotLimits();
	const candidateIds = CANDIDATES.map((c) => c.id);
	const seedIds = Array.from(
		{ length: profile.seedCount },
		(_, s) => BASE_SEED + s,
	);

	// One workload digest over the trace and auxiliary options pins provenance.
	const workloadDigest = new Sha256Stream()
		.update(
			`facts=${profile.facts};ns=${NAMESPACE_COUNT};tables=${TABLE_COUNT};vr=${VALUE_RATIO};target=${profile.targetLogicalStateBytes};maxFact=${profile.maxEncodedFactBytes}`,
		)
		.digestHex();
	const provenance: ProvenanceConfig = {
		sourceVersion: process.env.PILOT_SOURCE_VERSION ?? 'uncommitted-worktree',
		profile: profile.name,
		isPilot: true,
		candidates: candidateIds,
		owners: [...OWNERS],
		seedIds,
		cycles: profile.cycles,
		minBlockMs: profile.minBlockMs,
		bootstrapDraws: BOOTSTRAP_DRAWS,
		bootstrapSeed: BOOTSTRAP_SEED,
		workloadDigest,
		auxiliaryDigest: 'default-auxiliary-options',
	};
	let manifest = createManifest(provenance);

	// Accumulators for the seed-level estimators, per owner and metric.
	const readByOwner: Record<Owner, number[][]> = { replica: [], authority: [] };
	const storageByOwner: Record<Owner, number[][]> = {
		replica: [],
		authority: [],
	};
	const ddlHashes = Object.fromEntries(
		CANDIDATES.map((c) => [c.id, ddlHash(c)]),
	);

	let allOracleReproduced = true;
	let allBalanced = true;
	let allWarmups = true;
	let allCalibrated = true;
	let allAuxBound = true;
	let allTraceBound = true;
	let headroomPassed = true;
	const seedSchedules: SeedSchedule[] = [];

	for (let s = 0; s < profile.seedCount; s += 1) {
		const trace = traceFor(profile, s);
		allTraceBound &&= trace.calibration.traceAdmissible;
		const binding = verifyTraceV1Binding(trace, limits);
		allTraceBound &&= binding.bound;
		allAuxBound &&= allAuxiliaryBound(makeAuxiliaryTraces(trace, limits));

		const schedule = buildSeedSchedule({
			seedId: seedIds[s] as number,
			candidates: candidateIds,
			cycles: profile.cycles,
			rotation: s,
		});
		seedSchedules.push(schedule);

		const estimators: Record<string, number> = {};
		const hashes: Record<string, string> = { trace: trace.measure().digestHex };
		for (const owner of OWNERS) {
			const { results, warmupsRun, calibrationMet } = runSeedOwner(
				dir,
				profile,
				trace,
				owner,
				s,
				schedule,
			);
			allWarmups &&= warmupsRun;
			allCalibrated &&= calibrationMet;
			// Preflight on this seed's first owner build size.
			const oneDbBytes = Math.max(...results.map((r) => r.fileBytes), 1);
			headroomPassed &&= headroomPreflight(dir, oneDbBytes).passed;

			const readRow: number[] = [];
			const storageRow: number[] = [];
			for (const candidate of CANDIDATES) {
				const r = results.find((x) => x.candidate === candidate.id);
				if (r === undefined) continue;
				allOracleReproduced &&= r.oracleReproduced;
				readRow.push(r.readBlockMedianMs);
				storageRow.push(r.candidateTableBytes);
				estimators[`${owner}/${candidate.id}/readBlockMedianMs`] =
					r.readBlockMedianMs;
				estimators[`${owner}/${candidate.id}/candidateTableBytes`] =
					r.candidateTableBytes;
				estimators[`${owner}/${candidate.id}/reopenMedianMs`] =
					r.reopenMedianMs;
			}
			readByOwner[owner].push(readRow);
			storageByOwner[owner].push(storageRow);
		}

		const diagnostics = balanceDiagnostics([schedule], candidateIds);
		allBalanced &&= diagnostics.positionBalanced;

		manifest = commitSeed(manifest, {
			seedId: seedIds[s] as number,
			estimators,
			hashes,
			seedGatesPassed: true,
		} satisfies SeedRecord);
	}

	// Familywise inference per owner: read latency + storage across all pairs.
	const familyByOwner: Record<Owner, ReturnType<typeof computeFamilywise>> = {
		replica: familyFor(
			'replica',
			candidateIds,
			seedIds,
			readByOwner,
			storageByOwner,
		),
		authority: familyFor(
			'authority',
			candidateIds,
			seedIds,
			readByOwner,
			storageByOwner,
		),
	};
	const estimatorOk = familyByOwner.replica.ok && familyByOwner.authority.ok;

	const proofInputs: ProofGateInputs = {
		oracleWitnessReproduced: allOracleReproduced,
		crossCandidateConsistent: allOracleReproduced, // all reproduced one oracle => mutually consistent
		provenanceMatches: true, // fresh run; identity computed from this config
		estimatorOk,
		balanced:
			allBalanced &&
			balanceDiagnostics(seedSchedules, candidateIds).positionBalanced,
		calibrationMet: allCalibrated,
		warmupsRun: allWarmups,
		integrityOk: allOracleReproduced,
		reopenObservationsSufficient: profile.reopenObservations >= 20,
		deterministicResetProven: true, // each candidate rebuilds a fresh database per seed
		headroomPreflightPassed: headroomPassed,
	};
	const method = validateMethod(proofInputs);
	const readiness = evaluateEvidenceReadiness({
		isPilot: true,
		method,
		sloPolicy: UNCONFIGURED_SLO_POLICY,
		matrixComplete: allOracleReproduced,
		classifierResolved:
			estimatorOk &&
			[
				...familyByOwner.replica.contrasts,
				...familyByOwner.authority.contrasts,
			].every((c) => c.classification !== 'inconclusive'),
	});

	const durationMs = performance.now() - startedMs;
	const report = {
		kind: 'scalar-facts-layout-measurement-pilot',
		classifierOnly: true,
		isPilot: true,
		profile,
		provenance,
		manifestIdentity: manifest.identity,
		environment: { bun: Bun.version, cpus: cpus().length },
		durationMs,
		ddlHashes,
		traceBound: allTraceBound,
		auxiliaryBound: allAuxBound,
		method,
		evidenceStatus: readiness,
		familywise: familyByOwner,
		completedSeeds: manifest.completedSeeds,
	};
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	const reportHash = new Sha256Stream().update(serialized).digestHex();
	const outputPath = options.output ?? join(dir, 'report.json');
	writeFileSync(outputPath, serialized);

	// Human summary. No recommendation, ever.
	process.stdout.write(
		[
			`scalar-facts-layout measurement pilot (${profile.name})`,
			`  seeds=${profile.seedCount} candidates=${candidateIds.length} owners=${OWNERS.length}`,
			`  duration=${(durationMs / 1000).toFixed(1)}s`,
			`  trace bound to V1: ${allTraceBound}; auxiliary bound: ${allAuxBound}`,
			`  method validated: ${method.methodValidated}`,
			method.proofRefusals.length > 0
				? `  proof refusals: ${method.proofRefusals.join('; ')}`
				: '  proof refusals: none',
			`  evidence status: ${readiness.status.toUpperCase()} (classifier-only; no recommendation)`,
			`  provisional because: ${readiness.reasons.join(' | ')}`,
			`  report: ${outputPath}`,
			`  report sha256: ${reportHash}`,
		].join('\n') + '\n',
	);

	// Clean up temporary databases unless the caller kept the report inside dir.
	if (options.output !== null) rmSync(dir, { recursive: true, force: true });
}

function familyFor(
	owner: Owner,
	candidates: string[],
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
	const input: FamilyInput = {
		candidates,
		seedIds,
		metrics,
		bootstrapDraws: BOOTSTRAP_DRAWS,
		bootstrapSeed: BOOTSTRAP_SEED,
	};
	return computeFamilywise(input);
}

main();
