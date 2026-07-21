/**
 * Candidate- and operation-specific query-plan proof.
 *
 * The proof is NOT candidate-agnostic and NOT fail-open. For each candidate and
 * operation it declares the expected branch count, the closed set of table tokens
 * (real names and the aliases the SQL uses) any SEARCH may reference, and the
 * semantic predicate fragments each branch must cover. A branch is valid only if
 * every detail row is either a known structural EXPLAIN row (SCALAR SUBQUERY and
 * friends) or a SEARCH over an allowed table using an index/primary key, with no
 * full SCAN and no temp b-tree, and the branch covers every required predicate.
 *
 * Index NAMES are deliberately not bound (they are version-specific prose); the
 * binding is table + access kind + predicate coverage. A fabricated plan that
 * references an unrelated table, drops a required predicate, or carries an unknown
 * detail row is rejected. The classifier recomputes this from `result.candidateId`
 * and the raw structured plans, never trusting the retained booleans.
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

type OpContract = { branchCount: number; requiredPerBranch: string[] };
type CandidateContract = {
	allowedTables: string[];
	ops: Record<PlanOp, OpContract>;
};

const SEQ = 'SEQUENCE>';
const KEY = ['KIND=', 'NAMESPACE=', 'LOCAL_KEY=', 'ROW_ID='];
const NS_LK = ['NAMESPACE=', 'LOCAL_KEY='];
const COORD_LOOKUP = ['KIND=', 'NAMESPACE=', 'LOCAL_KEY='];

/** The declared per-candidate plan contract. Aliases `t`/`c` are the SQL's join aliases. */
const CONTRACTS: Record<string, CandidateContract> = {
	'unified-inline': {
		allowedTables: ['FACTS'],
		ops: {
			feed: { branchCount: 1, requiredPerBranch: [SEQ] },
			rowPoint: { branchCount: 1, requiredPerBranch: KEY },
			valuePoint: { branchCount: 1, requiredPerBranch: KEY },
			traverse: { branchCount: 1, requiredPerBranch: ['KIND=', ...NS_LK] },
		},
	},
	'unified-normalized': {
		allowedTables: ['FACTS', 'COORDINATES', 'T', 'C'],
		ops: {
			feed: { branchCount: 1, requiredPerBranch: [SEQ, 'ROWID='] },
			rowPoint: {
				branchCount: 1,
				requiredPerBranch: ['COORDINATE_ID=', 'ROW_ID=', ...COORD_LOOKUP],
			},
			valuePoint: {
				branchCount: 1,
				requiredPerBranch: ['COORDINATE_ID=', 'ROW_ID=', ...COORD_LOOKUP],
			},
			traverse: {
				branchCount: 1,
				requiredPerBranch: ['COORDINATE_ID=', ...COORD_LOOKUP],
			},
		},
	},
	'split-inline': {
		allowedTables: ['ROW_FACTS', 'VALUE_FACTS'],
		ops: {
			feed: { branchCount: 2, requiredPerBranch: [SEQ] },
			rowPoint: { branchCount: 1, requiredPerBranch: NS_LK.concat('ROW_ID=') },
			valuePoint: { branchCount: 1, requiredPerBranch: NS_LK },
			traverse: { branchCount: 1, requiredPerBranch: NS_LK },
		},
	},
	'split-normalized': {
		allowedTables: ['ROW_FACTS', 'VALUE_FACTS', 'COORDINATES', 'T', 'C'],
		ops: {
			feed: { branchCount: 2, requiredPerBranch: [SEQ, 'ROWID='] },
			rowPoint: {
				branchCount: 1,
				requiredPerBranch: ['COORDINATE_ID=', 'ROW_ID=', ...COORD_LOOKUP],
			},
			valuePoint: {
				branchCount: 1,
				requiredPerBranch: ['COORDINATE_ID=', ...COORD_LOOKUP],
			},
			traverse: {
				branchCount: 1,
				requiredPerBranch: ['COORDINATE_ID=', ...COORD_LOOKUP],
			},
		},
	},
};

/** Structural EXPLAIN rows that carry no table access; allowed but never sufficient alone. */
const STRUCTURAL =
	/^(SCALAR SUBQUERY|CORRELATED SCALAR SUBQUERY|CO-ROUTINE|MATERIALIZE|LIST SUBQUERY|UNION|COMPOUND) /;
const VIA = /USING (PRIMARY KEY|COVERING INDEX|INTEGER PRIMARY KEY|INDEX)/;

type RowKind = 'search' | 'structural' | 'bad';
function classifyRow(row: string, allowed: readonly string[]): RowKind {
	const u = row.toUpperCase().trim();
	if (u.length === 0) return 'bad';
	if (u.includes('TEMP B-TREE') || u.includes('SCAN')) return 'bad';
	if (STRUCTURAL.test(u)) return 'structural';
	const match = u.match(/^SEARCH (\S+) /);
	if (!match) return 'bad'; // unknown, non-structural, non-search detail
	const table = match[1] as string;
	if (!allowed.includes(table)) return 'bad'; // unrelated table
	if (!VIA.test(u)) return 'bad'; // not an indexed/PK access
	return 'search';
}

function branchValid(
	branch: string[],
	allowed: readonly string[],
	requiredPredicates: readonly string[],
): boolean {
	if (branch.length === 0) return false;
	let hasSearch = false;
	for (const row of branch) {
		const kind = classifyRow(row, allowed);
		if (kind === 'bad') return false;
		if (kind === 'search') hasSearch = true;
	}
	if (!hasSearch) return false;
	const text = branch.join(' | ').toUpperCase();
	return requiredPredicates.every((fragment) => text.includes(fragment));
}

function opValid(
	plan: QueryPlan,
	allowed: readonly string[],
	op: OpContract,
): boolean {
	if (plan.branches.length !== op.branchCount) return false;
	return plan.branches.every((branch) =>
		branchValid(branch, allowed, op.requiredPerBranch),
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
	const allowed = contract.allowedTables;
	const feedOrderedIndex = opValid(plans.feed, allowed, contract.ops.feed);
	const pointIndexed =
		opValid(plans.rowPoint, allowed, contract.ops.rowPoint) &&
		opValid(plans.valuePoint, allowed, contract.ops.valuePoint);
	const traverseIndexed = opValid(
		plans.traverse,
		allowed,
		contract.ops.traverse,
	);
	return {
		feedOrderedIndex,
		pointIndexed,
		traverseIndexed,
		ok: feedOrderedIndex && pointIndexed && traverseIndexed,
	};
}
