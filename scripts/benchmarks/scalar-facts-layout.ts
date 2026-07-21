#!/usr/bin/env bun
/**
 * scalar-facts-layout: pre-pilot confirmed-facts correctness/storage evidence for
 * the Wave 2b layout question. See scripts/benchmarks/scalar-facts-layout/README.md
 * for the scope, the four measured storage quantities, the per-cell outcome vs
 * run-level status, the provisional gates, and the no-winner policy.
 *
 * This is a pre-pilot Bun-only stress profile, never admissible full evidence and
 * never a frozen conformance run: it exercises no real replica/authority workflow,
 * the present logical-state figure is a labeled proxy for ADR-0161's final-present
 * scalar-fields-and-values proxy, and Bun cannot qualify OPFS, quota, WebKit,
 * mobile, or Durable Object SQLite.
 */
import { writeFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
	describeBunRuntime,
	makeInMemoryBunDb,
	makeInMemoryBunDbWith,
	openTempDatabase,
} from './scalar-facts-layout/bun-runtime.js';
import { classifyEvidence } from './scalar-facts-layout/decision.js';
import {
	attackMatrixProof,
	CANDIDATES,
	type Candidate,
	type ConstraintProofRecord,
	ddlStatements,
	shapeProofs,
	storeTransactionProofs,
} from './scalar-facts-layout/layouts.js';
import {
	type Owner,
	type RunResult,
	runCandidate,
} from './scalar-facts-layout/runner.js';
import {
	factsForPresentTarget,
	hash32,
	makeTrace,
	type TraceOptions,
} from './scalar-facts-layout/trace.js';

/** The artifact schema and its version; bump when the artifact shape changes. */
const ARTIFACT_VERSION = 2;
const SCHEMA_VERSION = 2;
const INSTALL_BATCH = 1024;
const INSTRUMENT_LABEL =
	'pre-pilot confirmed-facts correctness/storage evidence';

const FULL_LOGICAL_TARGET = 536_870_912; // 512 MiB, exact
const FULL_LIVE_ADDRESSES = 1_000_000;
const SMOKE_LOGICAL_TARGET = 5 * 1024 * 1024; // 5 MiB, exact
const SMOKE_LIVE_ADDRESSES = 10_000;
const FULL_VALUE_RATIO = 0.08;
// A LOCAL pre-pilot default only. The future measurement pilot freezes the real
// seed/block counts (the spec names four fresh paired outer seeds); this is not a
// qualification policy and five is never claimed as one.
const PREPILOT_DEFAULT_REPETITIONS = 4;

const KNOWN_FLAGS = new Set([
	'--profile',
	'--seed',
	'--repetitions',
	'--namespaces',
	'--tables',
	'--iterations',
	'--run-full-matrix',
	'--output',
	'--help',
	'-h',
]);

const HELP = `scalar-facts-layout: pre-pilot confirmed-facts correctness/storage evidence (Wave 2b)

  bun scripts/benchmarks/scalar-facts-layout.ts [--profile smoke|full] [options]

Scope: compares four confirmed-facts layouts (unified/split relation x
inline/normalized coordinate) for the replica and authority owners. It measures
ONLY the confirmed-facts table and refuses to freeze the schema-wide coordinate
encoding or any non-facts store. This is a pre-pilot instrument: NOT admissible
full evidence (it exercises no real replica/authority workflow and no qualifying
runtime). Every result is provisional (Bun cannot qualify OPFS, quota, WebKit,
mobile, or Durable Object SQLite) and the present logical-state bytes are a
labeled proxy for the ADR-0161 final-present scalar-fields-and-values proxy, not
a frozen conformance figure.

The corpus shape (live-address count, byte target, value ratio) is fixed per
profile and cannot be overridden, so the exact 10k/5 MiB and 1M/512 MiB shapes
never drift.

Profiles:
  smoke   10,000 live addresses / 5 MiB; the default; 1 repetition; illustrative.
  full    1,000,000 live addresses / 512 MiB (exact); 5 repetitions; the 1M
          candidate matrix is GATED and requires --run-full-matrix.

Options:
  --profile <smoke|full>   default: smoke
  --seed <int>             base data seed (default 1)
  --repetitions <int>      override the profile default (smoke 1, full 5)
  --namespaces <int>       namespace cardinality (default 25)
  --tables <int>           table cardinality (default 1000)
  --iterations <int>       timed-op iteration count (default 25)
  --run-full-matrix        run the gated 1M full matrix (full only)
  --output <path>          write one JSON evidence artifact (raw results + report)
  --help                   this help
`;

type Args = {
	profile: 'smoke' | 'full';
	seed: number;
	/** The effective repetition count (profile default unless overridden). */
	repetitions: number;
	namespaces: number;
	tables: number;
	iterations: number;
	runFullMatrix: boolean;
	output?: string;
};

function parseArgs(argv: string[]): Args {
	let profile: 'smoke' | 'full' = 'smoke';
	let repetitions: number | undefined;
	const args: Omit<Args, 'profile' | 'repetitions'> = {
		seed: 1,
		namespaces: 25,
		tables: 1000,
		iterations: 25,
		runFullMatrix: false,
	};
	const integer = (raw: string, flag: string, min: number): number => {
		const value = Number(raw);
		if (!Number.isInteger(value) || value < min)
			throw new Error(
				`${flag} must be an integer >= ${min}, got ${JSON.stringify(raw)}`,
			);
		return value;
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? '';
		if (!KNOWN_FLAGS.has(arg)) throw new Error(`unknown argument: ${arg}`);
		if (arg === '--help' || arg === '-h')
			throw new Error(`${arg} cannot be combined with other arguments`);
		// A value-taking flag must be followed by a real value, never end-of-args
		// or another flag (so `--output --help` is an error, not a filename).
		const next = (flag: string): string => {
			i += 1;
			const value = argv[i];
			if (value === undefined || KNOWN_FLAGS.has(value))
				throw new Error(`${flag} requires a value`);
			return value;
		};
		if (arg === '--profile') {
			const p = next('--profile');
			if (p !== 'smoke' && p !== 'full')
				throw new Error(
					`--profile must be smoke or full, got ${JSON.stringify(p)}`,
				);
			profile = p;
		} else if (arg === '--seed')
			args.seed = integer(next('--seed'), '--seed', 0);
		else if (arg === '--repetitions')
			repetitions = integer(next('--repetitions'), '--repetitions', 1);
		else if (arg === '--namespaces')
			args.namespaces = integer(next('--namespaces'), '--namespaces', 1);
		else if (arg === '--tables')
			args.tables = integer(next('--tables'), '--tables', 1);
		else if (arg === '--iterations')
			args.iterations = integer(next('--iterations'), '--iterations', 1);
		else if (arg === '--run-full-matrix') args.runFullMatrix = true;
		else if (arg === '--output') args.output = next('--output');
	}
	if (args.runFullMatrix && profile === 'smoke')
		throw new Error('--run-full-matrix is only valid with --profile full');
	// Profile-default repetitions: smoke 1 (illustrative), full 5.
	return {
		...args,
		profile,
		repetitions:
			repetitions ?? (profile === 'full' ? PREPILOT_DEFAULT_REPETITIONS : 1),
	};
}

/** Deterministic per-repetition candidate order, to avoid fixed-order bias. */
function shuffledCandidates(seed: number): typeof CANDIDATES {
	const order = [...CANDIDATES];
	for (let i = order.length - 1; i > 0; i -= 1) {
		const j = hash32(seed, i) % (i + 1);
		const a = order[i] as (typeof CANDIDATES)[number];
		const b = order[j] as (typeof CANDIDATES)[number];
		order[i] = b;
		order[j] = a;
	}
	return order;
}

const MiB = 1024 * 1024;
function fmtBytes(bytes: number): string {
	return `${(bytes / MiB).toFixed(2)} MiB`;
}
function ratio(numerator: number, denominator: number): string {
	return denominator > 0 ? `${(numerator / denominator).toFixed(3)}x` : 'n/a';
}

/**
 * Resolve the trace shape for a profile. Both profiles pin an EXACT live-address
 * count and an EXACT present-logical-state byte target as a corpus precondition
 * (smoke: 10,000 / 5 MiB; full: 1,000,000 / 512 MiB). It refuses when no integer
 * corpus is exact. These are corpus preconditions, never a qualification claim.
 */
function resolveTrace(args: Args): {
	base: Omit<TraceOptions, 'dataSeed'>;
	liveTarget: number;
	logicalTarget: number;
} {
	const liveTarget =
		args.profile === 'full' ? FULL_LIVE_ADDRESSES : SMOKE_LIVE_ADDRESSES;
	const logicalTarget =
		args.profile === 'full' ? FULL_LOGICAL_TARGET : SMOKE_LOGICAL_TARGET;
	const facts = factsForPresentTarget(liveTarget, FULL_VALUE_RATIO);
	if (facts === null) {
		throw new Error(
			`no integer corpus yields exactly ${liveTarget} live addresses at ratio ${FULL_VALUE_RATIO}`,
		);
	}
	return {
		base: {
			facts,
			namespaceCount: args.namespaces,
			tableCount: args.tables,
			valueRatio: FULL_VALUE_RATIO,
			targetLogicalStateBytes: logicalTarget,
			maxEncodedFactBytes: 65_536,
		},
		liveTarget,
		logicalTarget,
	};
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
		process.stdout.write(HELP);
		return 0;
	}
	let args: Args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		process.stderr.write(
			`error: ${error instanceof Error ? error.message : String(error)}\n\n`,
		);
		process.stderr.write(HELP);
		return 2;
	}
	const { base, liveTarget, logicalTarget } = resolveTrace(args);

	// One reference trace to report cardinalities and assert the qualification gate.
	const reference = makeTrace({ ...base, dataSeed: args.seed });
	const observed = reference.observed();
	const measured = reference.measure();

	console.log('# scalar-facts-layout');
	console.log(`(${INSTRUMENT_LABEL})`);
	console.log(
		`profile: ${args.profile}   qualifyingRuntime: false (Bun cannot qualify OPFS/quota/WebKit/mobile/DO)`,
	);
	console.log(
		'This is NOT admissible full evidence: it exercises no real replica/authority',
	);
	console.log(
		'workflow and no qualifying runtime. Present logical-state bytes are a LABELED',
	);
	console.log(
		'proxy for the ADR-0161 final-present scalar-fields-and-values benchmark proxy.',
	);
	console.log('');
	console.log('## corpus');
	console.log(
		`total addresses: ${observed.facts}   final-present (live): ${observed.finalPresent}   final-absent: ${observed.finalAbsent}`,
	);
	console.log(
		`namespaces: ${observed.namespaces}   tables: ${observed.tables}   values: ${observed.values}   rows: ${observed.rows}`,
	);
	console.log(
		`lifecycle: rewrites ${observed.rewrites}, row tombstones ${observed.rowTombstones}, value unsets ${observed.valueUnsets}, resurrections ${observed.valueResurrections}, initial-absent-then-present ${observed.initialAbsentThenPresent}`,
	);
	console.log(
		`present logical-state proxy: ${fmtBytes(measured.presentLogicalStateBytes)} (${measured.presentLogicalStateBytes} bytes)`,
	);
	console.log(
		`current protocol facts: ${fmtBytes(measured.currentProtocolFactBytes)} over ${measured.currentCount} facts; max fact ${measured.maxProtocolFactBytes} bytes`,
	);
	console.log(
		`calibration qualifying: ${reference.calibration.qualifying} (${reference.calibration.disqualifiedBy})`,
	);
	console.log('');

	// Corpus precondition (both profiles): the corpus must hit EXACTLY the live
	// address count and the present-logical byte target, and every fact must fit
	// the ceiling. This is a corpus precondition, not a qualification claim: the
	// evidence STATUS is decided later by the classifier, never from the corpus.
	console.log('## corpus precondition');
	const liveOk = measured.presentCount === liveTarget;
	const bytesOk = measured.presentLogicalStateBytes === logicalTarget;
	const gateOk = reference.calibration.qualifying;
	console.log(
		`live addresses == ${liveTarget}: ${liveOk} (${measured.presentCount})`,
	);
	console.log(
		`present proxy == ${logicalTarget}: ${bytesOk} (${measured.presentLogicalStateBytes})`,
	);
	console.log(`per-fact ceiling gate: ${gateOk}`);
	console.log('');
	if (!liveOk || !bytesOk || !gateOk) {
		console.error('CORPUS PRECONDITION FAILED. Aborting.');
		return 1;
	}
	if (args.profile === 'full' && !args.runFullMatrix) {
		console.log(
			'The 1,000,000-address candidate matrix is GATED pending review.',
		);
		console.log('Re-run with --run-full-matrix to execute it (expensive).');
		return 0;
	}

	// One DDL constraint proof per candidate: the full attack matrix across the
	// pragma matrix (recursive_triggers OFF/ON; normalized also foreign_keys
	// OFF/ON), plus the shape and install proofs. The typed per-pragma records
	// (baseline witness, integrity, and each attack's rejection/witness/integrity)
	// are retained in the artifact; each cell carries the derived {ok, failures}.
	const pragmaCombos = (
		candidate: Candidate,
	): { recursiveTriggers: boolean; foreignKeys: boolean }[] => {
		const foreignKeyModes =
			candidate.coordinates === 'normalized' ? [false, true] : [true];
		const combos: { recursiveTriggers: boolean; foreignKeys: boolean }[] = [];
		for (const recursiveTriggers of [false, true])
			for (const foreignKeys of foreignKeyModes)
				combos.push({ recursiveTriggers, foreignKeys });
		return combos;
	};
	const constraintEvidence = CANDIDATES.map((candidate) => {
		const records: ConstraintProofRecord[] = pragmaCombos(candidate).map(
			(combo) => attackMatrixProof(candidate, makeInMemoryBunDbWith(combo)),
		);
		const otherFailures = [
			...shapeProofs(candidate, makeInMemoryBunDb),
			...storeTransactionProofs(candidate, makeInMemoryBunDb),
		];
		const failures = [
			...records.flatMap((r) =>
				r.failures.map(
					(f) =>
						`[rt=${r.pragmas.recursiveTriggers ? 'on' : 'off'} fk=${r.pragmas.foreignKeys ? 'on' : 'off'}] ${f}`,
				),
			),
			...otherFailures,
		];
		return {
			candidateId: candidate.id,
			records,
			otherFailures,
			ok: failures.length === 0,
			failures,
		};
	});
	const constraintByCandidate = new Map(
		constraintEvidence.map((e) => [
			e.candidateId,
			{ ok: e.ok, failures: e.failures },
		]),
	);

	// Run the matrix: paired per seed (all candidates share a repetition's seed).
	const owners: Owner[] = ['replica', 'authority'];
	const results: RunResult[] = [];
	const candidateOrderByRep: { repetition: number; order: string[] }[] = [];
	for (let rep = 0; rep < args.repetitions; rep += 1) {
		const dataSeed = hash32(args.seed, rep);
		const order = shuffledCandidates(dataSeed);
		candidateOrderByRep.push({
			repetition: rep,
			order: order.map((c) => c.id),
		});
		for (const owner of owners) {
			for (const candidate of order) {
				results.push(
					await runCandidate(candidate, {
						trace: { ...base, dataSeed },
						owner,
						repetition: rep,
						iterations: args.iterations,
						installBatch: INSTALL_BATCH,
						openRuntime: openTempDatabase,
						runtimeName: 'bun',
						profile: args.profile,
						constraintProof: constraintByCandidate.get(candidate.id) ?? {
							ok: false,
							failures: ['constraint proof missing for candidate'],
						},
					}),
				);
			}
		}
	}

	console.log('## storage (candidate-varying tables only)');
	const oneRep = results.filter(
		(r) => r.owner === 'replica' && r.repetition === 0,
	);
	for (const r of oneRep) {
		const s = r.storage;
		console.log(
			`${r.candidateId.padEnd(20)} allocated pages ${fmtBytes(s.allocatedPageBytes)}  non-freelist pages ${fmtBytes(s.nonFreelistPageBytes)}  allocated/logical ${ratio(s.allocatedPageBytes, s.presentLogicalStateBytes)}  non-freelist/logical ${ratio(s.nonFreelistPageBytes, s.presentLogicalStateBytes)}`,
		);
	}
	console.log(
		'protocol/logical overhead (data-level, same for all candidates):',
		ratio(measured.currentProtocolFactBytes, measured.presentLogicalStateBytes),
	);
	console.log('');

	// Correctness, plan, and constraint-proof summary.
	const failed = results.filter((r) => r.outcome === 'failed');
	console.log('## correctness');
	console.log(`cells: ${results.length}   failed: ${failed.length}`);
	for (const r of failed.slice(0, 8))
		console.log(
			`  FAIL ${r.candidateId}/${r.owner}/rep${r.repetition}: ${r.reason}`,
		);
	for (const candidate of CANDIDATES) {
		const sample = results.find((r) => r.candidateId === candidate.id);
		console.log(
			`  ${candidate.id.padEnd(20)} plan proof: ${sample?.planProof.ok ?? false}   constraint proof: ${sample?.constraintProof.ok ?? false}`,
		);
	}
	console.log('');

	// Evidence status: this instrument records evidence; it NEVER names, ranks, or
	// ties a winner. The ADR owns the layout choice. The required repetition count
	// is this run's own pre-pilot default (or an explicit override); it is a local
	// completeness bar, never a qualification policy.
	const report = classifyEvidence(results, {
		profile: args.profile,
		expectedRuntime: 'bun',
		expectedProfile: args.profile,
		expectedOwners: owners,
		expectedCandidateIds: CANDIDATES.map((c) => c.id),
		requiredRepetitions: args.repetitions,
	});
	console.log('## evidence status (no winner is ever named; the ADR chooses)');
	if (args.profile === 'smoke')
		console.log(
			'[SMOKE: fast illustrative run; non-qualifying by construction.]',
		);
	console.log(
		`status: ${report.status}   qualifyingRuntime: ${report.qualifyingRuntime}`,
	);
	console.log(
		`matrix: ${report.passedCells}/${report.expectedCells} passing cells; ${report.repetitions} repetitions (need ${report.requiredRepetitions})`,
	);
	for (const reason of report.reasons) console.log(`  - ${reason}`);
	console.log(
		`unsupported workflows: ${report.unsupportedWorkflows.join('; ')}`,
	);
	console.log(
		`unsupported platforms: ${report.unsupportedPlatforms.join('; ')}`,
	);
	console.log('');
	console.log(
		`evidence status: ${report.status} (${INSTRUMENT_LABEL}; never reaches ready-for-ADR-review; the ADR owns the choice)`,
	);

	// One versioned JSON artifact: complete reproduction metadata (runtime
	// identity, pragmas, parsed args, install batch, candidate order, command,
	// source commit, DDL/schema digest) plus full raw results (timing arrays,
	// storage, plans, plan/constraint proofs, before/after witnesses, integrity)
	// and the classifier report. The classifier summarizes; the raw arrays are the
	// evidence, and medians are never the artifact.
	if (args.output !== undefined) {
		const ddlDigest = bytesToHex(
			sha256(
				new TextEncoder().encode(
					JSON.stringify(CANDIDATES.map((c) => ddlStatements(c))),
				),
			),
		);
		const sourceCommit =
			process.env.SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? null;
		const artifact = {
			artifactVersion: ARTIFACT_VERSION,
			label: INSTRUMENT_LABEL,
			admissibleFullEvidence: false,
			runtime: describeBunRuntime(),
			profile: args.profile,
			schema: { version: SCHEMA_VERSION, ddlDigest },
			repro: {
				command: process.argv,
				args,
				installBatch: INSTALL_BATCH,
				sourceCommit,
				candidateOrderByRep,
			},
			corpus: {
				liveTarget,
				logicalTarget,
				facts: base.facts,
				valueRatio: base.valueRatio,
				observed,
				measured,
			},
			// The full typed attack-matrix records across the pragma matrix, with
			// each combo's baseline witness/integrity and every attack's result.
			constraintEvidence,
			results,
			report,
		};
		writeFileSync(args.output, `${JSON.stringify(artifact, null, 2)}\n`);
		console.log(`wrote evidence artifact: ${args.output}`);
	}

	// Nonzero exit on invalid evidence; provisional/incomplete are honest states.
	return report.status === 'invalid' ? 1 : 0;
}

process.exit(await main());
