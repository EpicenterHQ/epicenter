/**
 * Fast tests of the evidence-status classifier with synthetic results (no
 * SQLite). It NEVER names a candidate: it returns only invalid | incomplete |
 * provisional. It fails closed on failed/duplicate cells, empty plans, seed
 * discipline violations, and missing required metrics; it is incomplete below
 * five repetitions or with a missing cell; and it is provisional (never
 * ready-for-ADR-review) on a complete correct matrix.
 */
import { describe, expect, test } from 'bun:test';

import { classifyEvidence } from './decision.js';
import { CANDIDATES } from './layouts.js';
import type { Owner, RunResult } from './runner.js';

const OWNERS: Owner[] = ['replica', 'authority'];
const IDS = CANDIDATES.map((c) => c.id);
const METRICS_BY_OWNER: Record<Owner, string[]> = {
	replica: [
		'acquisition',
		'rowPointRead',
		'valuePointRead',
		'traverse',
		'warmReopen',
	],
	authority: [
		'acquisition',
		'feedFresh',
		'feedResume',
		'foldPointRead',
		'warmReopen',
	],
};

function cell(
	owner: Owner,
	candidateId: string,
	repetition: number,
	dataSeed: number,
	over: Partial<RunResult> = {},
): RunResult {
	const metrics: Record<string, number[]> = {};
	for (const m of METRICS_BY_OWNER[owner]) metrics[m] = [1, 1, 1];
	return {
		candidateId,
		owner,
		repetition,
		dataSeed,
		correct: true,
		reason: 'ok',
		metrics,
		storage: {
			presentLogicalStateBytes: 1000,
			currentProtocolFactBytes: 1200,
			allocatedPageBytes: 2000,
			nonFreelistPageBytes: 1800,
			maxProtocolFactBytes: 100,
			presentCount: 100,
			currentCount: 120,
		},
		plans: { feed: 'p', rowPoint: 'p', valuePoint: 'p', traverse: 'p' },
		witness: {
			before: { count: 120, bytes: 1200, digestHex: 'abc' },
			after: { count: 120, bytes: 1200, digestHex: 'abc' },
		},
		integrityCheck: 'ok',
		authorityWriteModeled: false,
		...over,
	};
}

/** A complete, correct matrix: 2 owners x 4 candidates x 5 reps, seed 100+rep. */
function fullMatrix(): RunResult[] {
	const out: RunResult[] = [];
	for (let rep = 0; rep < 5; rep += 1)
		for (const owner of OWNERS)
			for (const id of IDS) out.push(cell(owner, id, rep, 100 + rep));
	return out;
}

const OPTIONS = {
	profile: 'full' as const,
	expectedOwners: OWNERS,
	expectedCandidateIds: IDS,
	requiredRepetitions: 5,
};

test('a complete correct matrix is provisional, never a candidate, never ready', () => {
	const report = classifyEvidence(fullMatrix(), OPTIONS);
	expect(report.status).toBe('provisional');
	expect(report.provisional).toBe(true);
	// The report shape carries no recommendation/candidate field at all.
	expect('recommendation' in report).toBe(false);
	expect(report.status).not.toBe('ready-for-ADR-review');
	expect(report.unsupportedWorkflows.length).toBeGreaterThan(0);
	expect(report.presentCorrectCells).toBe(report.expectedCells);
});

test('fewer than five repetitions is incomplete', () => {
	const three = fullMatrix().filter((r) => r.repetition < 3);
	expect(classifyEvidence(three, OPTIONS).status).toBe('incomplete');
});

test('a missing cell is incomplete', () => {
	const missing = fullMatrix().filter(
		(r) =>
			!(
				r.owner === 'replica' &&
				r.candidateId === IDS[0] &&
				r.repetition === 2
			),
	);
	expect(classifyEvidence(missing, OPTIONS).status).toBe('incomplete');
});

describe('fails closed to invalid', () => {
	test('a failed cell', () => {
		const results = fullMatrix();
		(results[0] as RunResult).correct = false;
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a duplicate cell', () => {
		const results = fullMatrix();
		results.push(cell('replica', IDS[0] as string, 0, 100));
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('an empty query plan', () => {
		const results = fullMatrix();
		(results[0] as RunResult).plans = {
			feed: '',
			rowPoint: 'p',
			valuePoint: 'p',
			traverse: 'p',
		};
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('an inconsistent seed within a repetition', () => {
		const results = fullMatrix();
		(results[0] as RunResult).dataSeed = 999; // rep 0 should all be 100
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('non-distinct seeds across repetitions', () => {
		const results = fullMatrix().map((r) => ({ ...r, dataSeed: 100 })); // all reps same seed
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a globally missing required metric', () => {
		const results = fullMatrix().map((r) => {
			if (r.owner !== 'replica') return r;
			const { traverse: _dropped, ...rest } = r.metrics;
			return { ...r, metrics: rest };
		});
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});

	test('an unexpected candidate id', () => {
		const results = fullMatrix();
		results.push(cell('replica', 'ghost-candidate', 0, 100));
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});

	test('a repetition outside the declared range', () => {
		const results = fullMatrix();
		results.push(cell('replica', IDS[0] ?? '', 9, 109));
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});

	test('an empty timing sample array', () => {
		const results = fullMatrix().map((r, i) =>
			i === 0 ? { ...r, metrics: { ...r.metrics, acquisition: [] } } : r,
		);
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});

	test('a non-finite timing sample', () => {
		const results = fullMatrix().map((r, i) =>
			i === 0
				? { ...r, metrics: { ...r.metrics, acquisition: [1, Number.NaN] } }
				: r,
		);
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});

	test('a witness that changed across reopen', () => {
		const results = fullMatrix().map((r, i) =>
			i === 0
				? {
						...r,
						witness: {
							before: r.witness.before,
							after: { ...r.witness.after, digestHex: 'different' },
						},
					}
				: r,
		);
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});

	test('a failed integrity check', () => {
		const results = fullMatrix().map((r, i) =>
			i === 0 ? { ...r, integrityCheck: 'malformed' } : r,
		);
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
});

test('the classifier output never contains a candidate id as a decision', () => {
	const report = classifyEvidence(fullMatrix(), OPTIONS);
	// cells carry candidate ids as raw evidence, but no field selects one.
	const keys = Object.keys(report);
	expect(keys).not.toContain('recommendation');
	expect(keys).not.toContain('winner');
	expect(keys).not.toContain('tie');
});
