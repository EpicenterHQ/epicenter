/**
 * Closed schema and completeness validation. These prove a resumed or tampered
 * seed cannot pass: wrong enums, missing/extra fields, non-finite numbers,
 * duplicate identities, and wrong counts/cycles/metrics are all refused, while a
 * genuinely complete seed validates.
 */

import { describe, expect, test } from 'bun:test';

import { CANDIDATE_IDS } from './candidates.js';
import { type ProbePlan, probeIdFor } from './probe-plan.js';
import {
	type CompletenessExpectations,
	expectedObservationCounts,
	isValidBlock,
	isValidCalibration,
	isValidCell,
	isValidReopen,
	isValidTail,
	validateSeedCompleteness,
	validateSeedRawClosed,
} from './raw-schema.js';
import { buildCompleteRaw } from './raw-schema.test-support.js';
import { buildSeedSchedule } from './schedule.js';

/** First element, asserting presence without a non-null bang. */
function head<T>(arr: readonly T[]): T {
	const [first] = arr;
	if (first === undefined) throw new Error('expected a non-empty array');
	return first;
}

const SEED_INDEX = 0;
const CYCLES = 1;
const MAX_READ_BLOCKS = 64;
const SCHEDULE = buildSeedSchedule({
	seedId: 1000,
	candidates: [...CANDIDATE_IDS],
	cycles: CYCLES,
	rotation: SEED_INDEX,
});
const EXP: CompletenessExpectations = {
	owners: ['replica', 'authority'],
	candidates: [...CANDIDATE_IDS],
	reopenObservations: 2,
	tailTransactions: 2,
	minBlockMs: 20,
	maxBlockOps: 16,
	seedId: 1000,
	configIdentity: 'config-a',
	traceOptions: {
		facts: 240,
		namespaceCount: 6,
		tableCount: 20,
		valueRatio: 0.08,
		dataSeed: 1000,
		targetLogicalStateBytes: 24_000,
		maxEncodedFactBytes: 4096,
	},
	seedIndex: SEED_INDEX,
	schedule: SCHEDULE.blocks.slice(0, Math.min(MAX_READ_BLOCKS, CYCLES * 16)),
	letterMapping: SCHEDULE.letterMapping,
};

function validBlock() {
	return {
		owner: 'replica',
		metric: 'confirmedPointRead',
		candidate: 'unified-inline',
		buildId: 'b',
		cycle: 0,
		ordinal: 0,
		position: 0,
		letter: 'A',
		sequenceLabel: 'ABDC',
		predecessor: null,
		boundary: 'none',
		ops: 1024,
		calibrationId: 'config-a/1000/replica/confirmedPointRead/calibration',
		warmupProbeId: 'config-a/1000/replica/confirmedPointRead/probe/warmup',
		warmupProbeDigest: '2'.repeat(64),
		timedProbeId: 'config-a/1000/replica/confirmedPointRead/probe/timed',
		timedProbeDigest: '3'.repeat(64),
		temporalOrdinal: 4,
		warmupMs: [1, 1, 1],
		elapsedMs: 25,
	};
}

describe('closed per-observation validators', () => {
	test('a well-formed block/reopen/tail/cell validate', () => {
		expect(isValidBlock(validBlock())).toBe(true);
		expect(
			isValidCalibration({
				configIdentity: 'config-a',
				seedId: 1000,
				owner: 'replica',
				metric: 'confirmedPointRead',
				candidate: 'unified-inline',
				buildId: 'config-a/1000/replica/unified-inline/build',
				roundIndex: 0,
				trialIndex: 0,
				sequenceOrder: 0,
				sequenceIndex: 0,
				position: 0,
				letter: 'A',
				ops: 1,
				elapsedMs: 1,
				minBlockMs: 20,
				probeId: 'config-a/1000/replica/confirmedPointRead/probe/calibration',
				probeDigest: '1'.repeat(64),
				calibrationId: 'config-a/1000/replica/confirmedPointRead/calibration',
				temporalOrdinal: 0,
			}),
		).toBe(true);
		expect(
			isValidReopen({
				owner: 'replica',
				candidate: 'unified-inline',
				buildId: 'b',
				index: 0,
				orderPosition: 0,
				elapsedMs: 1,
				witnessDigest: 'w',
				witnessMatchesOracle: true,
			}),
		).toBe(true);
		expect(
			isValidCell({
				owner: 'authority',
				candidate: 'split-inline',
				buildId: 'b',
				oracleReproduced: true,
				integrityOk: true,
				candidateTableBytes: 1,
				fileBytes: 1,
			}),
		).toBe(true);
	});

	test('a wrong-enum owner is rejected', () => {
		expect(isValidBlock({ ...validBlock(), owner: 'bogus' })).toBe(false);
	});
	test('a wrong-enum boundary is rejected', () => {
		expect(isValidBlock({ ...validBlock(), boundary: 'weird' })).toBe(false);
	});
	test('a missing field is rejected', () => {
		const b = validBlock() as Record<string, unknown>;
		delete b.elapsedMs;
		expect(isValidBlock(b)).toBe(false);
	});
	test('an extra field is rejected', () => {
		expect(isValidBlock({ ...validBlock(), extra: 1 })).toBe(false);
	});
	test('a non-finite number is rejected', () => {
		expect(
			isValidBlock({ ...validBlock(), elapsedMs: Number.POSITIVE_INFINITY }),
		).toBe(false);
	});
	test('warmupMs must be exactly three positive-shaped finite numbers', () => {
		expect(isValidBlock({ ...validBlock(), warmupMs: [1, 1] })).toBe(false);
	});
	test('a tail must carry a finite samples array', () => {
		expect(
			isValidTail({
				owner: 'replica',
				metric: 'monotonicInstallTail',
				candidate: 'unified-inline',
				transactions: 2,
				samplesMs: [0.1, Number.NaN],
				p50Ms: 0,
				p95Ms: 0,
				p99Ms: 0,
				throughputPerSec: 1,
				resetVerified: true,
				warmupTransactions: 3,
				walDeltaDiagnostic: 0,
				checkpointSignalTruthful: false,
			}),
		).toBe(false);
	});
});

describe('whole-seed closed validation', () => {
	test('a complete raw validates', () => {
		expect(validateSeedRawClosed(buildCompleteRaw(EXP)).valid).toBe(true);
	});
	test('missing top-level keys are rejected', () => {
		const raw = buildCompleteRaw(EXP) as Record<string, unknown>;
		delete raw.tails;
		expect(validateSeedRawClosed(raw).valid).toBe(false);
	});
});

describe('profile-aware completeness', () => {
	test('a complete raw is complete', () => {
		expect(validateSeedCompleteness(buildCompleteRaw(EXP), EXP).complete).toBe(
			true,
		);
	});
	test('a removed reopen breaks the per-cell count', () => {
		const raw = buildCompleteRaw(EXP) as { reopens: unknown[] };
		raw.reopens.pop();
		const result = validateSeedCompleteness(raw, EXP);
		expect(result.complete).toBe(false);
		expect(result.reasons.join(' ')).toContain('reopens');
	});
	test('a removed block breaks the balanced per-metric count', () => {
		const raw = buildCompleteRaw(EXP) as { blocks: unknown[] };
		raw.blocks.pop();
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});
	test('a duplicate cell is rejected', () => {
		const raw = buildCompleteRaw(EXP) as { cells: unknown[] };
		raw.cells.push(structuredClone(raw.cells[0]));
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});
	test('a wrong peakRetained is rejected', () => {
		const raw = buildCompleteRaw(EXP) as {
			lifecycle: { peakRetained: number };
		};
		raw.lifecycle.peakRetained = 7;
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});
	test('a tail with too few samples is rejected', () => {
		const raw = buildCompleteRaw(EXP) as { tails: { samplesMs: number[] }[] };
		head(raw.tails).samplesMs = [0.1];
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});
	test('an extra tail is rejected even when every required tail remains', () => {
		const raw = buildCompleteRaw(EXP) as { tails: unknown[] };
		raw.tails.push(structuredClone(raw.tails[0]));
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});
	test('negative and fractional count identities are rejected by the closed shape', () => {
		const negative = buildCompleteRaw(EXP) as {
			tails: { transactions: number }[];
		};
		head(negative.tails).transactions = -2;
		expect(validateSeedRawClosed(negative).valid).toBe(false);

		const fractional = buildCompleteRaw(EXP) as {
			reopens: { index: number }[];
		};
		head(fractional.reopens).index = 0.5;
		expect(validateSeedRawClosed(fractional).valid).toBe(false);
	});
	test('negative physical measurements and storage values are rejected', () => {
		const mutations: Array<(raw: ReturnType<typeof buildCompleteRaw>) => void> =
			[
				(raw) => {
					head((raw as { blocks: { elapsedMs: number }[] }).blocks).elapsedMs =
						-1;
				},
				(raw) => {
					head(
						(raw as { blocks: { warmupMs: number[] }[] }).blocks,
					).warmupMs[0] = -1;
				},
				(raw) => {
					head(
						(raw as { calibrations: { elapsedMs: number }[] }).calibrations,
					).elapsedMs = -1;
				},
				(raw) => {
					head(
						(raw as { boundaries: { idleMs: number }[] }).boundaries,
					).idleMs = -1;
				},
				(raw) => {
					head(
						(raw as { boundaries: { reopenMs: number }[] }).boundaries,
					).reopenMs = -1;
				},
				(raw) => {
					head(
						(raw as { reopens: { elapsedMs: number }[] }).reopens,
					).elapsedMs = -1;
				},
				(raw) => {
					head(
						(raw as { tails: { samplesMs: number[] }[] }).tails,
					).samplesMs[0] = -1;
				},
				(raw) => {
					head(
						(raw as { tails: { throughputPerSec: number }[] }).tails,
					).throughputPerSec = -1;
				},
				(raw) => {
					head((raw as { macros: { elapsedMs: number }[] }).macros).elapsedMs =
						-1;
				},
				(raw) => {
					head(
						(raw as { cells: { candidateTableBytes: number }[] }).cells,
					).candidateTableBytes = -1;
				},
				(raw) => {
					head((raw as { cells: { fileBytes: number }[] }).cells).fileBytes =
						-1;
				},
			];
		for (const mutate of mutations) {
			const raw = buildCompleteRaw(EXP);
			mutate(raw);
			expect(validateSeedRawClosed(raw).valid).toBe(false);
		}
	});

	test('fractional identities and negative lifecycle counts are rejected', () => {
		const mutations: Array<(raw: ReturnType<typeof buildCompleteRaw>) => void> =
			[
				(raw) => {
					head((raw as { blocks: { cycle: number }[] }).blocks).cycle = 0.5;
				},
				(raw) => {
					head((raw as { blocks: { ordinal: number }[] }).blocks).ordinal = 0.5;
				},
				(raw) => {
					head((raw as { blocks: { position: number }[] }).blocks).position =
						0.5;
				},
				(raw) => {
					head(
						(raw as { boundaries: { atOrdinal: number }[] }).boundaries,
					).atOrdinal = 0.5;
				},
				(raw) => {
					(
						raw as { lifecycle: { peakRetained: number } }
					).lifecycle.peakRetained = -1;
				},
				(raw) => {
					(
						raw as { lifecycle: { liveAtCommit: number } }
					).lifecycle.liveAtCommit = -1;
				},
			];
		for (const mutate of mutations) {
			const raw = buildCompleteRaw(EXP);
			mutate(raw);
			expect(validateSeedRawClosed(raw).valid).toBe(false);
		}
	});
	test('a missing owner metric is rejected', () => {
		const raw = buildCompleteRaw(EXP) as { blocks: { metric: string }[] };
		// Drop every confirmedPointRead block for the replica.
		const filtered = raw.blocks.filter(
			(b) => b.metric !== 'confirmedPointRead',
		);
		expect(
			validateSeedCompleteness({ ...raw, blocks: filtered }, EXP).complete,
		).toBe(false);
	});
	test('the frozen three-cycle owners derive exact per-seed counts', () => {
		const schedule = buildSeedSchedule({
			seedId: 1000,
			candidates: [...CANDIDATE_IDS],
			cycles: 3,
			rotation: 0,
		});
		const counts = expectedObservationCounts({
			...EXP,
			reopenObservations: 20,
			tailTransactions: 400,
			schedule: schedule.blocks,
		});
		expect(counts).toEqual({
			probes: 18,
			blocks: 288,
			boundaries: 30,
			reopens: 160,
			tails: 12,
			macros: 8,
			cells: 8,
		});
		expect(counts.blocks * 3).toBe(864);
		expect(counts.tails * 400).toBe(4800);
	});
});

// Every escape below is one the independent audit demonstrated against the
// previous, non-closed validator: each mutates a genuinely complete seed by a
// single hostile field and must now be refused.
describe('hostile audit escapes are refused', () => {
	function complete() {
		return buildCompleteRaw(EXP) as Record<string, unknown>;
	}

	test('an invented read metric is rejected even when every real group is full', () => {
		const raw = complete() as { blocks: Record<string, unknown>[] };
		raw.blocks.push({ ...structuredClone(raw.blocks[0]), metric: 'invented' });
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('an extra letterMapping key is rejected by the closed shape', () => {
		const raw = complete() as { letterMapping: Record<string, string> };
		raw.letterMapping.E = raw.letterMapping.A as string;
		expect(validateSeedRawClosed(raw).valid).toBe(false);
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('a non-bijective letterMapping is rejected', () => {
		const raw = complete() as { letterMapping: Record<string, string> };
		raw.letterMapping.B = raw.letterMapping.A as string; // collapse two letters
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('zero boundaries are rejected', () => {
		const raw = complete() as { boundaries: unknown[] };
		raw.boundaries = [];
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('an inconsistent buildId for one cell is rejected', () => {
		const raw = complete() as { blocks: { buildId: string }[] };
		head(raw.blocks).buildId = 's0/replica/split-normalized';
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('a buildId that does not encode its owner/candidate is rejected', () => {
		const raw = complete() as { cells: { buildId: string }[] };
		for (const c of raw.cells) c.buildId = 'garbage';
		const blocks = (raw as unknown as { blocks: { buildId: string }[] }).blocks;
		for (const b of blocks) b.buildId = 'garbage';
		const reopens = (raw as unknown as { reopens: { buildId: string }[] })
			.reopens;
		for (const x of reopens) x.buildId = 'garbage';
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('a garbage sequence label is rejected', () => {
		const raw = complete() as { blocks: { sequenceLabel: string }[] };
		head(raw.blocks).sequenceLabel = 'ZZZZ';
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('position = 99 is rejected', () => {
		const raw = complete() as { blocks: { position: number }[] };
		head(raw.blocks).position = 99;
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('a block boundary marker that contradicts its ordinal is rejected', () => {
		const raw = complete() as {
			blocks: { ordinal: number; boundary: string }[];
		};
		const first = raw.blocks.find((b) => b.ordinal === 0);
		expect(first).toBeDefined();
		if (first) first.boundary = 'none'; // ordinal 0 must be 'start'
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('retainedThroughCommit = false is rejected', () => {
		const raw = complete() as {
			lifecycle: { retainedThroughCommit: boolean };
		};
		raw.lifecycle.retainedThroughCommit = false;
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('a wrong liveAtCommit is rejected', () => {
		const raw = complete() as { lifecycle: { liveAtCommit: number } };
		raw.lifecycle.liveAtCommit = 7;
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	// The auditor's forge: swap Williams groups 0 and 1, consistently adjust
	// letters/candidates/sequence labels/build ids, and rewrite every predecessor.
	// A membership/permutation check passes it; an exact in-order schedule
	// comparison does not.
	test('a consistently forged group swap with rewritten predecessors is rejected', () => {
		type Block = {
			owner: string;
			metric: string;
			ordinal: number;
			candidate: string;
			letter: string;
			sequenceLabel: string;
			buildId: string;
			predecessor: string | null;
		};
		const raw = complete() as { blocks: Block[] };
		const owners = ['replica', 'authority'];
		for (const owner of owners) {
			const metrics = new Set(
				raw.blocks.filter((b) => b.owner === owner).map((b) => b.metric),
			);
			for (const metric of metrics) {
				const group = raw.blocks.filter(
					(b) => b.owner === owner && b.metric === metric,
				);
				for (let p = 0; p < 4; p += 1) {
					const a = group.find((b) => b.ordinal === p);
					const b = group.find((x) => x.ordinal === p + 4);
					if (!a || !b) continue;
					// Swap the whole identity bundle between the two groups, keeping build
					// ids consistent with the swapped candidate.
					const tmp = {
						candidate: a.candidate,
						letter: a.letter,
						sequenceLabel: a.sequenceLabel,
					};
					a.candidate = b.candidate;
					a.letter = b.letter;
					a.sequenceLabel = b.sequenceLabel;
					b.candidate = tmp.candidate;
					b.letter = tmp.letter;
					b.sequenceLabel = tmp.sequenceLabel;
					a.buildId = `s${SEED_INDEX}/${owner}/${a.candidate}`;
					b.buildId = `s${SEED_INDEX}/${owner}/${b.candidate}`;
				}
			}
		}
		for (const b of raw.blocks) b.predecessor = 'forged';
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('a wrong-seed build id (right owner/candidate, wrong seed) is rejected', () => {
		const raw = complete() as Record<string, unknown>;
		for (const key of ['blocks', 'cells', 'reopens'] as const) {
			for (const rec of raw[key] as { buildId: string }[]) {
				rec.buildId = rec.buildId.replace('/1000/', '/9999/');
			}
		}
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('a forged calibration config identity or probe phase is rejected', () => {
		const wrongConfig = complete() as {
			calibrations: { calibrationId: string; probeId: string }[];
		};
		head(wrongConfig.calibrations).calibrationId =
			'other/1000/replica/confirmedPointRead/calibration';
		expect(validateSeedCompleteness(wrongConfig, EXP).complete).toBe(false);

		const wrongProbe = complete() as {
			blocks: { warmupProbeId: string }[];
		};
		head(wrongProbe.blocks).warmupProbeId =
			'config-a/1000/replica/confirmedPointRead/probe/timed';
		expect(validateSeedCompleteness(wrongProbe, EXP).complete).toBe(false);
	});

	test('calibration must finish before its timed blocks', () => {
		const raw = complete() as {
			calibrations: {
				owner: string;
				metric: string;
				temporalOrdinal: number;
			}[];
			blocks: { owner: string; metric: string; temporalOrdinal: number }[];
		};
		const calibration = raw.calibrations.find(
			(c) => c.owner === 'replica' && c.metric === 'confirmedPointRead',
		);
		const timed = raw.blocks.find(
			(b) => b.owner === 'replica' && b.metric === 'confirmedPointRead',
		);
		expect(calibration).toBeDefined();
		expect(timed).toBeDefined();
		if (calibration && timed) {
			const ordinal = calibration.temporalOrdinal;
			calibration.temporalOrdinal = timed.temporalOrdinal;
			timed.temporalOrdinal = ordinal;
		}
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	test('temporal ordinals are the exact gap-free replay order', () => {
		const shifted = complete() as {
			calibrations: { temporalOrdinal: number }[];
			blocks: { temporalOrdinal: number }[];
		};
		for (const event of [...shifted.calibrations, ...shifted.blocks]) {
			event.temporalOrdinal += 100;
		}
		expect(validateSeedCompleteness(shifted, EXP).complete).toBe(false);

		const duplicate = complete() as { blocks: { temporalOrdinal: number }[] };
		head(duplicate.blocks).temporalOrdinal += 1;
		expect(validateSeedCompleteness(duplicate, EXP).complete).toBe(false);

		const gap = complete() as { blocks: { temporalOrdinal: number }[] };
		head(gap.blocks.slice(-1)).temporalOrdinal += 1;
		expect(validateSeedCompleteness(gap, EXP).complete).toBe(false);

		const reordered = complete() as { calibrations: unknown[] };
		const first = reordered.calibrations[0];
		const second = reordered.calibrations[1];
		reordered.calibrations[0] = second;
		reordered.calibrations[1] = first;
		expect(validateSeedCompleteness(reordered, EXP).complete).toBe(false);
	});

	test('calibration binds direct config, seed, candidate, and retained build identity', () => {
		for (const mutate of [
			(calibration: Record<string, unknown>) => {
				calibration.configIdentity = 'other';
			},
			(calibration: Record<string, unknown>) => {
				calibration.seedId = 9999;
			},
			(calibration: Record<string, unknown>) => {
				calibration.candidate = 'split-normalized';
			},
			(calibration: Record<string, unknown>) => {
				calibration.buildId = 'transient/build';
			},
		]) {
			const raw = complete() as { calibrations: Record<string, unknown>[] };
			mutate(head(raw.calibrations));
			expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
		}
	});

	test('overlapping phase ranges and reused probe digests are rejected', () => {
		const overlap = complete() as {
			probes: {
				owner: string;
				metric: string;
				phase: string;
				rowOffset: number;
				traversalStartSequence: number;
			}[];
		};
		const warmup = overlap.probes.find(
			(probe) =>
				probe.owner === 'replica' &&
				probe.metric === 'confirmedTraversal' &&
				probe.phase === 'warmup',
		);
		expect(warmup).toBeDefined();
		if (warmup) {
			warmup.rowOffset = 0;
			warmup.traversalStartSequence = 50;
		}
		expect(validateSeedCompleteness(overlap, EXP).complete).toBe(false);

		const reused = complete() as { probes: ProbePlan[] };
		const calibration = reused.probes.find(
			(probe) =>
				probe.owner === 'replica' &&
				probe.metric === 'confirmedTraversal' &&
				probe.phase === 'calibration',
		);
		const timed = reused.probes.find(
			(probe) =>
				probe.owner === 'replica' &&
				probe.metric === 'confirmedTraversal' &&
				probe.phase === 'timed',
		);
		expect(calibration).toBeDefined();
		expect(timed).toBeDefined();
		if (calibration && timed) timed.itemsDigest = calibration.itemsDigest;
		expect(validateSeedCompleteness(reused, EXP).complete).toBe(false);
	});

	test('self-consistent rewrites cannot replace the deterministic expected probe plan', () => {
		const forge = (mutate: (plan: ProbePlan) => void) => {
			const raw = complete() as {
				probes: ProbePlan[];
				blocks: {
					owner: string;
					metric: string;
					warmupProbeId: string;
					warmupProbeDigest: string;
				}[];
			};
			const plan = raw.probes.find(
				(probe) =>
					probe.owner === 'replica' &&
					probe.metric === 'confirmedTraversal' &&
					probe.phase === 'warmup',
			);
			expect(plan).toBeDefined();
			if (plan === undefined) throw new Error('warmup probe fixture missing');
			mutate(plan);
			const { probeId: _priorProbeId, ...identity } = plan;
			plan.probeId = probeIdFor(identity);
			for (const block of raw.blocks) {
				if (block.owner === plan.owner && block.metric === plan.metric) {
					block.warmupProbeId = plan.probeId;
					block.warmupProbeDigest = plan.itemsDigest;
				}
			}
			return validateSeedCompleteness(raw, EXP);
		};

		expect(
			forge((plan) => {
				plan.itemsDigest = 'a'.repeat(64);
				plan.traversalStartSequence += 1;
				plan.traversalEndSequence -= 1;
			}).complete,
		).toBe(false);
		expect(
			forge((plan) => {
				plan.sourceDigest = 'b'.repeat(64);
			}).complete,
		).toBe(false);
		expect(
			forge((plan) => {
				head(plan.traversalPages).digest = 'c'.repeat(64);
			}).complete,
		).toBe(false);
		expect(
			forge((plan) => {
				head(plan.traversalPages).afterSequence += 1;
			}).complete,
		).toBe(false);
	});

	test('a terminal calibration round below the floor cannot fall back to the cap', () => {
		const raw = complete() as {
			calibrations: {
				owner: string;
				metric: string;
				roundIndex: number;
				trialIndex: number;
				elapsedMs: number;
			}[];
		};
		const terminal = raw.calibrations.find(
			(c) =>
				c.owner === 'replica' &&
				c.metric === 'confirmedPointRead' &&
				c.roundIndex === 1 &&
				c.trialIndex === 0,
		);
		expect(terminal).toBeDefined();
		if (terminal) terminal.elapsedMs = EXP.minBlockMs - 0.01;
		expect(validateSeedCompleteness(raw, EXP).complete).toBe(false);
	});

	// A uniform +N shift of every reopen index keeps each cell's indices unique and
	// keeps the mod-L balanced rotation intact, so only an EXACT {0..N-1} index set
	// refuses it. The unshifted raw (the exact balanced relation) still passes.
	test('a uniform +4 shift of every reopen index is rejected, exact balance still passes', () => {
		expect(validateSeedCompleteness(complete(), EXP).complete).toBe(true);
		const raw = complete() as { reopens: { index: number }[] };
		for (const x of raw.reopens) x.index += 4;
		const result = validateSeedCompleteness(raw, EXP);
		expect(result.complete).toBe(false);
		// Rejected specifically on the index set, not the balanced rotation.
		expect(result.reasons.some((m) => m.includes('reopen index set'))).toBe(
			true,
		);
		expect(result.reasons.some((m) => m.includes('balanced rotation'))).toBe(
			false,
		);
	});
});
