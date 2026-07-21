/**
 * Closed schema and completeness validation. These prove a resumed or tampered
 * seed cannot pass: wrong enums, missing/extra fields, non-finite numbers,
 * duplicate identities, and wrong counts/cycles/metrics are all refused, while a
 * genuinely complete seed validates.
 */

import { describe, expect, test } from 'bun:test';

import {
	type CompletenessExpectations,
	isValidBlock,
	isValidCell,
	isValidReopen,
	isValidTail,
	RAW_CANDIDATE_IDS,
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
	candidates: [...RAW_CANDIDATE_IDS],
	cycles: CYCLES,
	rotation: SEED_INDEX,
});
const EXP: CompletenessExpectations = {
	owners: ['replica', 'authority'],
	candidates: [...RAW_CANDIDATE_IDS],
	reopenObservations: 2,
	minTailTransactions: 2,
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
		warmupMs: [1, 1, 1],
		elapsedMs: 25,
	};
}

describe('closed per-observation validators', () => {
	test('a well-formed block/reopen/tail/cell validate', () => {
		expect(isValidBlock(validBlock())).toBe(true);
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
				rec.buildId = rec.buildId.replace(/^s\d+\//, 's9/');
			}
		}
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
