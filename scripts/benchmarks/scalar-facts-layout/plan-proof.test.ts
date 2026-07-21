/**
 * Focused tests for the candidate-specific, fail-closed plan proof. The real
 * store plans pass their own candidate; fabricated plans (unrelated table, wrong
 * predicate, unknown detail, one broken split branch), an unknown candidate, and a
 * candidate mismatch all fail.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { CANDIDATES, createStore, ddlStatements } from './layouts.js';
import { evaluatePlanProof, type QueryPlans } from './plan-proof.js';

function realPlans(candidateId: string): QueryPlans {
	const candidate = CANDIDATES.find((c) => c.id === candidateId);
	if (!candidate) throw new Error(`unknown candidate ${candidateId}`);
	const db = createBunSqliteAdapter(new Database(':memory:'));
	db.run('PRAGMA foreign_keys = ON');
	for (const s of ddlStatements(candidate)) db.run(s);
	const store = createStore(db, candidate);
	return {
		feed: store.queryPlan('feed'),
		rowPoint: store.queryPlan('rowPoint'),
		valuePoint: store.queryPlan('valuePoint'),
		traverse: store.queryPlan('traverse'),
	};
}
const one = (detail: string) => ({ branches: [[detail]] });

test('every candidate accepts its own real plans', () => {
	for (const c of CANDIDATES)
		expect(evaluatePlanProof(c.id, realPlans(c.id)).ok).toBe(true);
});

test('an unknown candidate id fails closed', () => {
	expect(evaluatePlanProof('ghost', realPlans('unified-inline')).ok).toBe(
		false,
	);
});

test('a fabricated plan with an unrelated table and unknown detail fails', () => {
	const plans: QueryPlans = {
		feed: {
			branches: [
				[
					'SEARCH facts USING INDEX arbitrary_idx (sequence>?)',
					'TOTALLY UNKNOWN PLAN DETAIL',
				],
			],
		},
		rowPoint: one('SEARCH unrelated USING INDEX arbitrary_idx'),
		valuePoint: one('SEARCH unrelated USING INDEX arbitrary_idx'),
		traverse: one('SEARCH unrelated USING INDEX arbitrary_idx'),
	};
	expect(evaluatePlanProof('unified-inline', plans).ok).toBe(false);
});

test('an unrelated table in an otherwise-valid feed fails', () => {
	const base = realPlans('unified-inline');
	const plans = {
		...base,
		feed: one('SEARCH unrelated USING INDEX x (sequence>?)'),
	};
	expect(evaluatePlanProof('unified-inline', plans).ok).toBe(false);
});

test('a wrong feed predicate (index but not a sequence range) fails', () => {
	const base = realPlans('unified-inline');
	const plans = {
		...base,
		feed: one('SEARCH facts USING INDEX x (namespace=?)'),
	};
	expect(evaluatePlanProof('unified-inline', plans).ok).toBe(false);
});

test('an unknown detail row fails even beside a valid access', () => {
	const base = realPlans('unified-inline');
	const plans = {
		...base,
		rowPoint: {
			branches: [
				[
					'SEARCH facts USING PRIMARY KEY (kind=? AND namespace=? AND local_key=? AND row_id=?)',
					'MYSTERY ROW',
				],
			],
		},
	};
	expect(evaluatePlanProof('unified-inline', plans).ok).toBe(false);
});

test('a full SCAN or temp b-tree in any branch fails', () => {
	const base = realPlans('unified-inline');
	expect(
		evaluatePlanProof('unified-inline', { ...base, feed: one('SCAN facts') })
			.ok,
	).toBe(false);
	expect(
		evaluatePlanProof('unified-inline', {
			...base,
			feed: { branches: [['SCAN facts', 'USE TEMP B-TREE FOR ORDER BY']] },
		}).ok,
	).toBe(false);
});

test('a split feed with one good and one broken branch fails', () => {
	const base = realPlans('split-inline');
	const plans = {
		...base,
		feed: {
			branches: [
				['SEARCH row_facts USING INDEX ai (sequence>?)'],
				['SEARCH value_facts USING PRIMARY KEY (namespace=? AND local_key=?)'],
			],
		},
	};
	expect(evaluatePlanProof('split-inline', plans).ok).toBe(false);
});

test('one candidate real plans do not satisfy another candidate contract', () => {
	// split-inline needs 2 feed branches; unified-inline feed has 1.
	expect(
		evaluatePlanProof('split-inline', realPlans('unified-inline')).ok,
	).toBe(false);
});

test('split feed with a duplicated branch (both row_facts) fails', () => {
	const base = realPlans('split-inline');
	const row = ['SEARCH row_facts USING INDEX i (sequence>?)'];
	const plans = { ...base, feed: { branches: [row, row] } };
	expect(evaluatePlanProof('split-inline', plans).ok).toBe(false);
});

test('split-inline with row/value point tables swapped fails', () => {
	const base = realPlans('split-inline');
	const plans = {
		...base,
		rowPoint: {
			branches: [
				[
					'SEARCH value_facts USING PRIMARY KEY (namespace=? AND local_key=? AND row_id=?)',
				],
			],
		},
		valuePoint: {
			branches: [
				['SEARCH row_facts USING PRIMARY KEY (namespace=? AND local_key=?)'],
			],
		},
	};
	expect(evaluatePlanProof('split-inline', plans).ok).toBe(false);
});

test('a traverse bound to the wrong table fails', () => {
	const base = realPlans('split-inline');
	const plans = {
		...base,
		traverse: {
			branches: [
				['SEARCH value_facts USING PRIMARY KEY (namespace=? AND local_key=?)'],
			],
		},
	};
	expect(evaluatePlanProof('split-inline', plans).ok).toBe(false);
});

test('a predicate smuggled into a structural row does not satisfy a missing SEARCH predicate', () => {
	// unified-inline rowPoint drops LOCAL_KEY from the indexed SEARCH but smuggles
	// it into a structural SCALAR SUBQUERY row.
	const base = realPlans('unified-inline');
	const plans = {
		...base,
		rowPoint: {
			branches: [
				[
					'SEARCH facts USING PRIMARY KEY (kind=? AND namespace=? AND row_id=?)',
					'SCALAR SUBQUERY LOCAL_KEY=?',
				],
			],
		},
	};
	expect(evaluatePlanProof('unified-inline', plans).ok).toBe(false);
});

test('normalized: a point missing the coordinate lookup access fails', () => {
	// Drop the coordinates covering-index access from the normalized rowPoint.
	const base = realPlans('unified-normalized');
	const plans = {
		...base,
		rowPoint: {
			branches: [
				['SEARCH facts USING PRIMARY KEY (coordinate_id=? AND row_id=?)'],
			],
		},
	};
	expect(evaluatePlanProof('unified-normalized', plans).ok).toBe(false);
});

test('normalized: a feed branch missing the coordinate join fails', () => {
	const base = realPlans('split-normalized');
	const plans = {
		...base,
		feed: {
			branches: [
				['SEARCH row_facts USING INDEX i (sequence>?)'],
				['SEARCH value_facts USING INDEX i (sequence>?)'],
			],
		},
	};
	expect(evaluatePlanProof('split-normalized', plans).ok).toBe(false);
});
