/**
 * Candidate- and operation-specific query-plan proof, fail-closed.
 *
 * The contract is per operation, not candidate-wide. Each operation declares its
 * branches; each branch declares the exact set of indexed accesses it must
 * contain, and each access binds a SPECIFIC base table, a specific access kind
 * (index range, primary key, covering index, integer primary key), and the
 * predicate fragments that must appear ON THAT access's own EXPLAIN row. Accesses
 * are matched to the branch's real SEARCH rows as a bijection; branches are
 * matched to the operation's branch specs as a bijection (order-independent), so a
 * split feed must cover row_facts once and value_facts once. Structural EXPLAIN
 * rows (SCALAR SUBQUERY and friends) are allowed for planner shape but contribute
 * ZERO predicate evidence, so a predicate smuggled into a structural row does not
 * satisfy a missing predicate on an indexed SEARCH.
 *
 * The benchmark SQL uses no single-letter table aliases, so every EXPLAIN row
 * names its real base table; there is no candidate-wide alias allowlist. Index
 * names are deliberately not bound (version-specific); the binding is table plus
 * access kind plus predicate coverage. An unknown candidate id fails closed, as
 * does any full SCAN, temp b-tree, unrelated table, wrong access kind, missing or
 * smuggled predicate, wrong/duplicate/missing branch, or swapped operation.
 */
import type { PlanOp, QueryPlan } from './layouts.js';

export type QueryPlans = {
	feed: QueryPlan;
	rowPoint: QueryPlan;
	valuePoint: QueryPlan;
	traverse: QueryPlan;
};

export type PlanProof = {
	feedOrderedIndex: boolean;
	pointIndexed: boolean;
	traverseIndexed: boolean;
	ok: boolean;
};

type Via = 'index-range' | 'pk' | 'covering-index' | 'integer-pk';
type Access = { table: string; via: Via; predicates: string[] };
type BranchSpec = Access[];
type OpContract = BranchSpec[];
type CandidateContract = Record<PlanOp, OpContract>;

const VIA_MARK: Record<Via, string> = {
	'index-range': 'USING INDEX',
	pk: 'USING PRIMARY KEY',
	'covering-index': 'USING COVERING INDEX',
	'integer-pk': 'USING INTEGER PRIMARY KEY',
};

const seqAccess = (table: string): Access => ({
	table,
	via: 'index-range',
	predicates: ['SEQUENCE>'],
});
const coordJoin: Access = {
	table: 'coordinates',
	via: 'integer-pk',
	predicates: ['ROWID='],
};
const coordLookup: Access = {
	table: 'coordinates',
	via: 'covering-index',
	predicates: ['KIND=', 'NAMESPACE=', 'LOCAL_KEY='],
};

const CONTRACTS: Record<string, CandidateContract> = {
	'unified-inline': {
		feed: [[seqAccess('facts')]],
		rowPoint: [
			[
				{
					table: 'facts',
					via: 'pk',
					predicates: ['KIND=', 'NAMESPACE=', 'LOCAL_KEY=', 'ROW_ID='],
				},
			],
		],
		valuePoint: [
			[
				{
					table: 'facts',
					via: 'pk',
					predicates: ['KIND=', 'NAMESPACE=', 'LOCAL_KEY=', 'ROW_ID='],
				},
			],
		],
		traverse: [
			[
				{
					table: 'facts',
					via: 'pk',
					predicates: ['KIND=', 'NAMESPACE=', 'LOCAL_KEY='],
				},
			],
		],
	},
	'unified-normalized': {
		feed: [[seqAccess('facts'), coordJoin]],
		rowPoint: [
			[
				{
					table: 'facts',
					via: 'pk',
					predicates: ['COORDINATE_ID=', 'ROW_ID='],
				},
				coordLookup,
			],
		],
		valuePoint: [
			[
				{
					table: 'facts',
					via: 'pk',
					predicates: ['COORDINATE_ID=', 'ROW_ID='],
				},
				coordLookup,
			],
		],
		traverse: [
			[
				coordLookup,
				{ table: 'facts', via: 'pk', predicates: ['COORDINATE_ID='] },
			],
		],
	},
	'split-inline': {
		feed: [[seqAccess('row_facts')], [seqAccess('value_facts')]],
		rowPoint: [
			[
				{
					table: 'row_facts',
					via: 'pk',
					predicates: ['NAMESPACE=', 'LOCAL_KEY=', 'ROW_ID='],
				},
			],
		],
		valuePoint: [
			[
				{
					table: 'value_facts',
					via: 'pk',
					predicates: ['NAMESPACE=', 'LOCAL_KEY='],
				},
			],
		],
		traverse: [
			[
				{
					table: 'row_facts',
					via: 'pk',
					predicates: ['NAMESPACE=', 'LOCAL_KEY='],
				},
			],
		],
	},
	'split-normalized': {
		feed: [
			[seqAccess('row_facts'), coordJoin],
			[seqAccess('value_facts'), coordJoin],
		],
		rowPoint: [
			[
				{
					table: 'row_facts',
					via: 'pk',
					predicates: ['COORDINATE_ID=', 'ROW_ID='],
				},
				coordLookup,
			],
		],
		valuePoint: [
			[
				{ table: 'value_facts', via: 'pk', predicates: ['COORDINATE_ID='] },
				coordLookup,
			],
		],
		traverse: [
			[
				coordLookup,
				{ table: 'row_facts', via: 'pk', predicates: ['COORDINATE_ID='] },
			],
		],
	},
};

/** Structural EXPLAIN rows that carry no table access. They contribute no predicate. */
const STRUCTURAL =
	/^(SCALAR SUBQUERY|CORRELATED SCALAR SUBQUERY|CO-ROUTINE|MATERIALIZE|LIST SUBQUERY|UNION|COMPOUND)\b/;

/** Does one EXPLAIN row satisfy one access spec? Predicates are checked on THIS row only. */
function rowMatchesAccess(row: string, access: Access): boolean {
	const u = row.toUpperCase().trim();
	if (u.includes('SCAN') || u.includes('TEMP B-TREE')) return false;
	if (!new RegExp(`^SEARCH ${access.table.toUpperCase()} `).test(u))
		return false;
	if (!u.includes(VIA_MARK[access.via])) return false;
	return access.predicates.every((fragment) => u.includes(fragment));
}

/** Is one EXPLAIN row a recognized structural (non-access) row? */
function isStructural(row: string): boolean {
	return STRUCTURAL.test(row.toUpperCase().trim());
}

/** Can `specs` be matched one-to-one onto distinct `rows` under `matches`? */
function bijection<S, R>(
	specs: S[],
	rows: R[],
	matches: (spec: S, row: R) => boolean,
): boolean {
	if (specs.length !== rows.length) return false;
	const used = new Array<boolean>(rows.length).fill(false);
	const assign = (i: number): boolean => {
		if (i === specs.length) return true;
		for (let j = 0; j < rows.length; j += 1) {
			if (used[j]) continue;
			if (matches(specs[i] as S, rows[j] as R)) {
				used[j] = true;
				if (assign(i + 1)) return true;
				used[j] = false;
			}
		}
		return false;
	};
	return assign(0);
}

/** A branch validates iff its rows are exactly the spec's accesses (bijection) plus allowed structural rows. */
function branchMatchesSpec(branch: string[], spec: BranchSpec): boolean {
	if (branch.length === 0) return false;
	const searchRows: string[] = [];
	for (const row of branch) {
		const u = row.toUpperCase().trim();
		if (u.includes('SCAN') || u.includes('TEMP B-TREE')) return false;
		if (isStructural(row)) continue; // allowed, contributes no predicate
		if (!u.startsWith('SEARCH ')) return false; // unknown, non-structural detail
		searchRows.push(row);
	}
	return bijection(spec, searchRows, (access, row) =>
		rowMatchesAccess(row, access),
	);
}

/** An operation validates iff its actual branches biject onto its branch specs. */
function opValid(plan: QueryPlan, contract: OpContract): boolean {
	return bijection(contract, plan.branches, (spec, branch) =>
		branchMatchesSpec(branch, spec),
	);
}

/**
 * Recompute the plan proof for a specific candidate from its raw structured plans.
 * An unknown candidate id yields an all-false proof (fail closed).
 */
export function evaluatePlanProof(
	candidateId: string,
	plans: QueryPlans,
): PlanProof {
	const contract = CONTRACTS[candidateId];
	if (!contract) {
		return {
			feedOrderedIndex: false,
			pointIndexed: false,
			traverseIndexed: false,
			ok: false,
		};
	}
	const feedOrderedIndex = opValid(plans.feed, contract.feed);
	const pointIndexed =
		opValid(plans.rowPoint, contract.rowPoint) &&
		opValid(plans.valuePoint, contract.valuePoint);
	const traverseIndexed = opValid(plans.traverse, contract.traverse);
	return {
		feedOrderedIndex,
		pointIndexed,
		traverseIndexed,
		ok: feedOrderedIndex && pointIndexed && traverseIndexed,
	};
}
