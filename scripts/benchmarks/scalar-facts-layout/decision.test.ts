/**
 * Fast tests of the evidence-status classifier with synthetic results (no
 * SQLite). It NEVER names a candidate: it returns only invalid | incomplete |
 * provisional. It fails closed on failed/duplicate cells, plan/constraint proof
 * failures, malformed witnesses, degenerate samples, seed discipline violations,
 * and missing required metrics; it is incomplete below the required repetitions
 * or with a missing cell; and it is provisional (never ready-for-ADR-review) on a
 * complete passing matrix.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { classifyEvidence, type RepetitionOracle } from './decision.js';
import { CANDIDATES, createStore, ddlStatements } from './layouts.js';
import type { QueryPlans } from './plan-proof.js';
import type { Owner, RunResult } from './runner.js';

const HEX64 = 'a'.repeat(64);

const onePlan = (detail: string) => ({ branches: [[detail]] });

const OWNERS: Owner[] = ['replica', 'authority'];
const IDS = CANDIDATES.map((c) => c.id);

// The REAL structured plans per candidate, so the classifier's candidate-specific
// recomputation agrees with the fixture (no drift, no hand-authored contract copy).
function realPlans(candidateId: string): QueryPlans {
	const candidate = CANDIDATES.find((c) => c.id === candidateId);
	if (!candidate) throw new Error(`unknown candidate ${candidateId}`);
	const db = createBunSqliteAdapter(new Database(':memory:'));
	db.run('PRAGMA foreign_keys = ON');
	for (const statement of ddlStatements(candidate)) db.run(statement);
	const store = createStore(db, candidate);
	return {
		feed: store.queryPlan('feed'),
		rowPoint: store.queryPlan('rowPoint'),
		valuePoint: store.queryPlan('valuePoint'),
		traverse: store.queryPlan('traverse'),
	};
}
const PLANS_BY_CANDIDATE: Record<string, QueryPlans> = Object.fromEntries(
	IDS.map((id) => [id, realPlans(id)]),
);
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
		runtime: 'bun',
		profile: 'full',
		outcome: 'passed',
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
		// The candidate's REAL structured plans so recomputation agrees per-candidate.
		plans: PLANS_BY_CANDIDATE[candidateId] as QueryPlans,
		planProof: {
			feedOrderedIndex: true,
			pointIndexed: true,
			traverseIndexed: true,
			ok: true,
		},
		constraintProof: { failures: [], ok: true },
		witness: {
			before: { count: 120, bytes: 1200, digestHex: HEX64 },
			after: { count: 120, bytes: 1200, digestHex: HEX64 },
		},
		integrityCheck: 'ok',
		authorityWriteModeled: false,
		...over,
	};
}

// The declared repetition count for these tests: this tool's local pre-pilot
// default (4), NOT a qualification policy.
const REQUIRED_REPS = 4;

/** A complete, correct matrix: 2 owners x 4 candidates x REQUIRED_REPS reps. */
function fullMatrix(): RunResult[] {
	const out: RunResult[] = [];
	for (let rep = 0; rep < REQUIRED_REPS; rep += 1)
		for (const owner of OWNERS)
			for (const id of IDS) out.push(cell(owner, id, rep, 100 + rep));
	return out;
}

// The declared per-repetition oracles, matching the fixture cell exactly:
// dataSeed 100+rep, current 120/1200/HEX64, present 100/1000, totalFacts 120,
// finalAbsent 20. Internally consistent (count == totalFacts; present+absent ==
// totalFacts). Lifecycle is no longer part of the classifier oracle.
const ORACLES: RepetitionOracle[] = Array.from(
	{ length: REQUIRED_REPS },
	(_unused, rep) => ({
		repetition: rep,
		dataSeed: 100 + rep,
		count: 120,
		currentProtocolFactBytes: 1200,
		digestHex: HEX64,
		presentCount: 100,
		presentLogicalStateBytes: 1000,
		totalFacts: 120,
		finalAbsent: 20,
	}),
);

const OPTIONS = {
	expectedRuntime: 'bun',
	expectedProfile: 'full',
	expectedRepetitionOracles: ORACLES,
	expectedOwners: OWNERS,
	expectedCandidateIds: IDS,
	requiredRepetitions: REQUIRED_REPS,
};

test('a complete passing matrix is provisional, never a candidate, never ready', () => {
	const report = classifyEvidence(fullMatrix(), OPTIONS);
	expect(report.status).toBe('provisional');
	expect(report.qualifyingRuntime).toBe(false);
	// The report shape carries no recommendation/candidate field at all.
	expect('recommendation' in report).toBe(false);
	expect(report.status).not.toBe('ready-for-ADR-review');
	expect(report.unsupportedWorkflows.length).toBeGreaterThan(0);
	expect(report.passedCells).toBe(report.expectedCells);
});

test('fewer than the declared required repetitions is incomplete', () => {
	const fewer = fullMatrix().filter((r) => r.repetition < REQUIRED_REPS - 1);
	expect(classifyEvidence(fewer, OPTIONS).status).toBe('incomplete');
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
	test('a failed cell outcome', () => {
		const results = fullMatrix();
		(results[0] as RunResult).outcome = 'failed';
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a duplicate cell', () => {
		const results = fullMatrix();
		results.push(cell('replica', IDS[0] as string, 0, 100));
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a failed query-plan proof (raw plan and proof both bad)', () => {
		const results = fullMatrix();
		const r = results[0] as RunResult;
		r.plans = { ...r.plans, feed: onePlan('SCAN facts') };
		r.planProof = {
			feedOrderedIndex: false,
			pointIndexed: true,
			traverseIndexed: true,
			ok: false,
		};
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a forged plan proof (raw SCAN plan but planProof.ok true)', () => {
		const results = fullMatrix();
		const r = results[0] as RunResult;
		// Raw feed is a full SCAN with a temp b-tree, but the retained proof lies.
		r.plans = {
			...r.plans,
			feed: { branches: [['SCAN facts', 'USE TEMP B-TREE FOR ORDER BY']] },
		};
		// planProof still claims ok:true; the classifier recomputes and rejects.
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a split feed with one good branch and one broken branch', () => {
		const results = fullMatrix();
		// Target a real split-inline cell: row branch is a proper ordered sequence
		// index; value branch is an unrelated primary-key SEARCH (not ordered by
		// sequence). Every branch must be independently valid per the contract.
		const r = results.find(
			(c) => c.candidateId === 'split-inline',
		) as RunResult;
		r.plans = {
			...r.plans,
			feed: {
				branches: [
					['SEARCH row_facts USING INDEX ai (sequence>?)'],
					[
						'SEARCH value_facts USING PRIMARY KEY (namespace=? AND local_key=?)',
					],
				],
			},
		};
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a fabricated plan (unrelated table plus an unknown detail)', () => {
		const results = fullMatrix();
		const r = results[0] as RunResult; // unified-inline
		r.plans = {
			...r.plans,
			feed: {
				branches: [
					[
						'SEARCH facts USING INDEX arbitrary_idx (sequence>?)',
						'TOTALLY UNKNOWN PLAN DETAIL',
					],
				],
			},
			rowPoint: onePlan('SEARCH unrelated USING INDEX arbitrary_idx'),
		};
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a plan for the wrong candidate (unified plan on a split cell)', () => {
		const results = fullMatrix();
		const split = results.find(
			(c) => c.candidateId === 'split-inline',
		) as RunResult;
		// A single-branch unified-style feed does not satisfy split-inline (2 branches).
		split.plans = PLANS_BY_CANDIDATE['unified-inline'] as QueryPlans;
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a forged constraint proof (ok:true with nonempty failures)', () => {
		const results = fullMatrix();
		(results[0] as RunResult).constraintProof = {
			failures: ['some attack was not rejected'],
			ok: true,
		};
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a failed constraint proof', () => {
		const results = fullMatrix();
		(results[0] as RunResult).constraintProof = {
			failures: ['some attack was not rejected'],
			ok: false,
		};
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a non-finite storage field', () => {
		const results = fullMatrix();
		(results[0] as RunResult).storage.allocatedPageBytes = Number.NaN;
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a malformed witness digest', () => {
		const results = fullMatrix();
		(results[0] as RunResult).witness.before.digestHex = 'not-hex';
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a spoofed runtime', () => {
		const results = fullMatrix();
		(results[0] as RunResult).runtime = 'not-bun';
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a spoofed profile', () => {
		const results = fullMatrix();
		(results[0] as RunResult).profile = 'smoke';
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('an incoherent passed cell (outcome passed but correct false)', () => {
		const results = fullMatrix();
		(results[0] as RunResult).correct = false;
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('an unknown outcome', () => {
		const results = fullMatrix();
		(results[0] as RunResult).outcome = 'weird' as never;
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('an unsupported outcome is rejected, not silently incomplete', () => {
		const results = fullMatrix();
		(results[0] as RunResult).outcome = 'unsupported';
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('non-freelist pages exceed allocated pages', () => {
		const results = fullMatrix();
		(results[0] as RunResult).storage.nonFreelistPageBytes = 999_999;
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('witness count disagrees with storage current count', () => {
		const results = fullMatrix();
		(results[0] as RunResult).storage.currentCount = 121; // witness says 120
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a forged present count (not the repetition oracle)', () => {
		const results = fullMatrix();
		(results[0] as RunResult).storage.presentCount = 101; // oracle is 100
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a forged present-proxy byte total (not the repetition oracle)', () => {
		const results = fullMatrix();
		(results[0] as RunResult).storage.presentLogicalStateBytes = 1001;
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a forged current count that agrees with its own witness but not the oracle', () => {
		const results = fullMatrix();
		const r = results[0] as RunResult;
		// Self-consistent (witness matches storage) but wrong vs the oracle (120).
		r.storage.currentCount = 130;
		r.witness.before = { ...r.witness.before, count: 130 };
		r.witness.after = { ...r.witness.after, count: 130 };
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a wrong digest (self-equal but not the oracle)', () => {
		const results = fullMatrix();
		const r = results[0] as RunResult;
		const other = 'b'.repeat(64);
		r.witness.before = { ...r.witness.before, digestHex: other };
		r.witness.after = { ...r.witness.after, digestHex: other };
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a wrong protocol byte total (self-consistent but not the oracle)', () => {
		const results = fullMatrix();
		const r = results[0] as RunResult;
		r.storage.currentProtocolFactBytes = 1300;
		r.witness.before = { ...r.witness.before, bytes: 1300 };
		r.witness.after = { ...r.witness.after, bytes: 1300 };
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('mixed digests within one repetition (one cell disagrees with the oracle)', () => {
		const results = fullMatrix();
		// Flip a single rep-0 cell's digest; every other rep-0 cell still matches
		// the oracle, so this odd-one-out is caught by the oracle binding.
		const r = results.find((c) => c.repetition === 0) as RunResult;
		const other = 'c'.repeat(64);
		r.witness.before = { ...r.witness.before, digestHex: other };
		r.witness.after = { ...r.witness.after, digestHex: other };
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('a wrong data seed (not the oracle seed)', () => {
		const results = fullMatrix();
		(results[0] as RunResult).dataSeed = 999; // oracle rep 0 seed is 100
		expect(classifyEvidence(results, OPTIONS).status).toBe('invalid');
	});
	test('an internally inconsistent oracle (present + absent != totalFacts)', () => {
		const badOracles = ORACLES.map((o, i) =>
			i === 0 ? { ...o, finalAbsent: 25 } : o,
		); // present(100)+absent(25) != totalFacts(120)
		expect(
			classifyEvidence(fullMatrix(), {
				...OPTIONS,
				expectedRepetitionOracles: badOracles,
			}).status,
		).toBe('invalid');
	});
	test('an EXTRA oracle for an unused repetition (not an exact closed set)', () => {
		const extra: RepetitionOracle = {
			repetition: 999,
			dataSeed: 777,
			count: 120,
			currentProtocolFactBytes: 1200,
			digestHex: HEX64,
			presentCount: 100,
			presentLogicalStateBytes: 1000,
			totalFacts: 120,
			finalAbsent: 20,
		};
		expect(
			classifyEvidence(fullMatrix(), {
				...OPTIONS,
				expectedRepetitionOracles: [...ORACLES, extra],
			}).status,
		).toBe('invalid');
	});
	test('too few oracles for the required repetitions', () => {
		expect(
			classifyEvidence(fullMatrix(), {
				...OPTIONS,
				expectedRepetitionOracles: ORACLES.slice(0, REQUIRED_REPS - 1),
			}).status,
		).toBe('invalid');
	});
	test('non-distinct oracle seeds', () => {
		const dupSeed = ORACLES.map((o) => ({ ...o, dataSeed: 100 }));
		expect(
			classifyEvidence(fullMatrix(), {
				...OPTIONS,
				expectedRepetitionOracles: dupSeed,
			}).status,
		).toBe('invalid');
	});
	test('the full forged counterexample cell', () => {
		// Every spoof at once must still classify invalid, never provisional.
		const results = fullMatrix();
		results[0] = {
			...(results[0] as RunResult),
			runtime: 'ghost',
			profile: 'ghost',
			outcome: 'passed',
			correct: false,
			reason: 'ok',
			plans: {
				feed: onePlan('SCAN facts'),
				rowPoint: onePlan('SCAN facts'),
				valuePoint: onePlan('SCAN facts'),
				traverse: onePlan('SCAN facts'),
			},
			planProof: {
				feedOrderedIndex: true,
				pointIndexed: true,
				traverseIndexed: true,
				ok: true,
			},
			constraintProof: { failures: ['unrejected attack'], ok: true },
			storage: {
				presentLogicalStateBytes: 1000,
				currentProtocolFactBytes: 1200,
				allocatedPageBytes: 2000,
				nonFreelistPageBytes: 9000,
				maxProtocolFactBytes: 100,
				presentCount: 100,
				currentCount: 999,
			},
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
							after: { ...r.witness.after, digestHex: 'b'.repeat(64) },
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
