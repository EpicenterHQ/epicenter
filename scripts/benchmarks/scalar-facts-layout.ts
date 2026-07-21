#!/usr/bin/env bun
/**
 * scalar-facts-layout: a decision instrument for the Wave 2b confirmed-facts
 * layout question. See scripts/benchmarks/scalar-facts-layout/README.md for the
 * scope, the ADR-0167 logical/protocol byte split, the four measured storage
 * quantities, and the no-winner policy.
 *
 * This is a provisional Bun-only stress profile, never a frozen conformance run:
 * ADR-0167 leaves the canonical logical-state container unfrozen, so the present
 * logical-state figure is a labeled proxy, and Bun cannot qualify OPFS, quota,
 * WebKit, mobile, or Durable Object SQLite.
 */
import { classifyEvidence } from './scalar-facts-layout/decision.js';
import { CANDIDATES } from './scalar-facts-layout/layouts.js';
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

const FULL_LOGICAL_TARGET = 536_870_912; // 512 MiB, exact
const FULL_LIVE_ADDRESSES = 1_000_000;
const SMOKE_LOGICAL_TARGET = 5 * 1024 * 1024; // 5 MiB, exact
const SMOKE_LIVE_ADDRESSES = 10_000;
const FULL_VALUE_RATIO = 0.08;
const REQUIRED_REPETITIONS = 5; // the declared evidence policy: at least five seeds

const KNOWN_FLAGS = new Set([
	'--profile',
	'--seed',
	'--repetitions',
	'--facts',
	'--namespaces',
	'--tables',
	'--value-ratio',
	'--iterations',
	'--run-full-matrix',
	'--help',
	'-h',
]);

const HELP = `scalar-facts-layout: confirmed-facts layout decision instrument (Wave 2b)

  bun scripts/benchmarks/scalar-facts-layout.ts [--profile smoke|full] [options]

Scope: compares four confirmed-facts layouts (unified/split relation x
inline/normalized coordinate) for the replica and authority owners. It measures
ONLY the confirmed-facts table and refuses to freeze the schema-wide coordinate
encoding or any non-facts store. Every result is provisional (Bun cannot qualify
OPFS, quota, WebKit, mobile, or Durable Object SQLite) and the present
logical-state bytes are a labeled ADR-0167 proxy, not a frozen conformance
figure.

Profiles:
  smoke   tiny; exercises every path; the default; explicitly non-qualifying.
  full    1,000,000 live addresses / 512 MiB present logical state (exact); the
          1M candidate matrix is GATED and requires --run-full-matrix.

Options:
  --profile <smoke|full>   default: smoke
  --seed <int>             base data seed (default 1)
  --repetitions <int>      independent builds; <5 cannot qualify (default 3)
  --facts <int>            override total addresses (smoke)
  --namespaces <int>       namespace cardinality (default 25)
  --tables <int>           table cardinality (default 1000)
  --value-ratio <float>    fraction of addresses that are values (default 0.08)
  --iterations <int>       timed-op iteration count (default 25)
  --run-full-matrix        actually run the gated 1M full matrix
  --help                   this help
`;

type Args = {
	profile: 'smoke' | 'full';
	seed: number;
	repetitions: number;
	facts?: number;
	namespaces: number;
	tables: number;
	valueRatio: number;
	iterations: number;
	runFullMatrix: boolean;
};

function parseArgs(argv: string[]): Args {
	const args: Args = {
		profile: 'smoke',
		seed: 1,
		repetitions: 3,
		namespaces: 25,
		tables: 1000,
		valueRatio: FULL_VALUE_RATIO,
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
	const ratioArg = (raw: string, flag: string): number => {
		const value = Number(raw);
		if (!Number.isFinite(value) || value <= 0 || value >= 1)
			throw new Error(
				`${flag} must be a number in (0, 1), got ${JSON.stringify(raw)}`,
			);
		return value;
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? '';
		if (!KNOWN_FLAGS.has(arg)) throw new Error(`unknown argument: ${arg}`);
		if (arg === '--help' || arg === '-h')
			throw new Error(`${arg} cannot be combined with other arguments`);
		const next = (): string => {
			i += 1;
			return argv[i] ?? '';
		};
		if (arg === '--profile') {
			const p = next();
			if (p !== 'smoke' && p !== 'full')
				throw new Error(
					`--profile must be smoke or full, got ${JSON.stringify(p)}`,
				);
			args.profile = p;
		} else if (arg === '--seed') args.seed = integer(next(), '--seed', 0);
		else if (arg === '--repetitions')
			args.repetitions = integer(next(), '--repetitions', 1);
		else if (arg === '--facts') args.facts = integer(next(), '--facts', 1);
		else if (arg === '--namespaces')
			args.namespaces = integer(next(), '--namespaces', 1);
		else if (arg === '--tables') args.tables = integer(next(), '--tables', 1);
		else if (arg === '--value-ratio')
			args.valueRatio = ratioArg(next(), '--value-ratio');
		else if (arg === '--iterations')
			args.iterations = integer(next(), '--iterations', 1);
		else if (arg === '--run-full-matrix') args.runFullMatrix = true;
	}
	return args;
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

function main(): number {
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
	console.log(
		`profile: ${args.profile}   provisional: true (Bun cannot qualify OPFS/quota/WebKit/mobile/DO)`,
	);
	console.log(
		`present logical-state bytes are a LABELED ADR-0167 PROXY; the canonical container is unfrozen.`,
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

	// Run the matrix: paired per seed (all candidates share a repetition's seed).
	const owners: Owner[] = ['replica', 'authority'];
	const results: RunResult[] = [];
	for (let rep = 0; rep < args.repetitions; rep += 1) {
		const dataSeed = hash32(args.seed, rep);
		for (const owner of owners) {
			for (const candidate of shuffledCandidates(dataSeed)) {
				results.push(
					runCandidate(candidate, {
						trace: { ...base, dataSeed },
						owner,
						repetition: rep,
						iterations: args.iterations,
						installBatch: 1024,
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

	// Correctness and feed-plan summary.
	const failed = results.filter((r) => !r.correct);
	console.log('## correctness');
	console.log(`cells: ${results.length}   failed: ${failed.length}`);
	for (const r of failed.slice(0, 8))
		console.log(
			`  FAIL ${r.candidateId}/${r.owner}/rep${r.repetition}: ${r.reason}`,
		);
	for (const candidate of CANDIDATES) {
		const sample = results.find((r) => r.candidateId === candidate.id);
		const feed = (sample?.plans.feed ?? '').toUpperCase();
		const merges = !feed.includes('TEMP B-TREE');
		console.log(
			`  ${candidate.id.padEnd(20)} feed avoids temp b-tree: ${merges}   value point plan: ${(sample?.plans.valuePoint ?? '').length > 0}`,
		);
	}
	console.log('');

	// Evidence status: this instrument records evidence; it NEVER names, ranks, or
	// ties a winner. The ADR owns the layout choice.
	// Full evidence requires five repetitions; smoke is a fast illustrative run
	// held only to its own repetitions and is never more than provisional.
	const report = classifyEvidence(results, {
		profile: args.profile,
		expectedOwners: owners,
		expectedCandidateIds: CANDIDATES.map((c) => c.id),
		requiredRepetitions:
			args.profile === 'full' ? REQUIRED_REPETITIONS : args.repetitions,
	});
	console.log('## evidence status (no winner is ever named; the ADR chooses)');
	if (args.profile === 'smoke')
		console.log(
			'[SMOKE: fast illustrative run; non-qualifying by construction.]',
		);
	console.log(`status: ${report.status}   provisional: ${report.provisional}`);
	console.log(
		`matrix: ${report.presentCorrectCells}/${report.expectedCells} correct cells; ${report.repetitions} repetitions (need ${report.requiredRepetitions})`,
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
		`evidence status: ${report.status} (this Bun instrument never reaches ready-for-ADR-review; the ADR owns the choice)`,
	);
	return 0;
}

process.exit(main());
