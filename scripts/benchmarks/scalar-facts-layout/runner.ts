/**
 * The Bun/desktop-SQLite pre-pilot runner: owner-specific workloads, timing,
 * reopen, storage, and query plans.
 *
 * Each run builds one candidate into a page-addressable SQLite database, installs
 * the shared corpus through the atomic page seam, verifies the reconstructed
 * state against the oracle's three-part witness, then times the owner's critical
 * operations keeping raw samples. The database holds only the candidate-varying
 * tables, so the whole-file page bytes are exactly the storage metric. Four byte
 * quantities are kept distinct (present logical state, current protocol facts,
 * allocated page bytes, non-freelist page bytes).
 *
 * This is NOT a universal runtime. A browser Worker/OPFS harness and a Durable
 * Object authority harness each need their OWN lifecycle runner (atomic
 * page-plus-afterSequence progress, restart-prefix proof, crash/quota handling,
 * and OPFS or DO storage measurements). What they share with this runner is only
 * the portable vocabulary: the trace and byte oracle, the candidate DDL and
 * store, the query-plan operations, and the proof vocabulary. The injected
 * factory below abstracts the desktop file-SQLite lifecycle only.
 *
 * Every run produces exactly one cell with a settled `outcome`
 * (`passed`|`failed`; a future harness may also emit `unsupported`/`not-admitted`
 * for cells this Bun instrument never runs). A cell is `failed` if it throws, its
 * reconstruction diverges, its witness changes across reopen, integrity is not
 * ok, cleanup fails, its query-plan proof fails, or its candidate's constraint
 * proof fails. Cleanup failure is retained on the cell, never silently thrown
 * over the result.
 */

import type { SqliteDatabase } from '@epicenter/sqlite';

import { type Candidate, createStore, ddlStatements } from './layouts.js';
import {
	type Fact,
	factSetDigest,
	makeTrace,
	type TraceOptions,
} from './trace.js';

export type Owner = 'replica' | 'authority';

/** Per-cell outcome, distinct from the run-level evidence status. */
export type CellOutcome = 'passed' | 'failed' | 'unsupported' | 'not-admitted';

export type PageMetrics = {
	allocatedPageBytes: number;
	nonFreelistPageBytes: number;
};

/**
 * The desktop file-SQLite lifecycle this runner depends on. Bun supplies a
 * synchronous implementation; the async signatures exist only so the same
 * desktop runner could drive a node/better-sqlite-style backend, NOT so a browser
 * or Durable Object reuses it (those need their own runners, see the module
 * docstring). The runner imports no `bun:sqlite` or `node:*`. `pageMetrics` is
 * defined only for page/freelist-addressable file SQLite and must never be faked
 * for a runtime that lacks it (Durable Objects).
 */
export type BenchmarkRuntime = {
	db: SqliteDatabase;
	close(): void | Promise<void>;
	reopen(): SqliteDatabase | Promise<SqliteDatabase>;
	checkpoint(): void | Promise<void>;
	/** Page/freelist bytes; defined only for page-addressable file SQLite. */
	pageMetrics(tables: string[]): PageMetrics | Promise<PageMetrics>;
	cleanup(): void | Promise<void>;
};

/** Opens a fresh runtime with the candidate DDL already applied. */
export type RuntimeFactory = (
	statements: string[],
) => BenchmarkRuntime | Promise<BenchmarkRuntime>;

export type StorageMeasure = {
	presentLogicalStateBytes: number;
	currentProtocolFactBytes: number;
	allocatedPageBytes: number;
	nonFreelistPageBytes: number;
	maxProtocolFactBytes: number;
	presentCount: number;
	currentCount: number;
};

export type QueryPlans = {
	feed: string;
	rowPoint: string;
	valuePoint: string;
	traverse: string;
};

/**
 * Plan-semantics proof, evaluated per operation from the raw EXPLAIN QUERY PLAN
 * text (never truthiness). The classifier RECOMPUTES this from the raw plans and
 * never trusts the retained booleans.
 *
 * - feed must order by an index range on the sequence column (SQLite prints
 *   `... USING INDEX ... (sequence>?)`), with no full-table SCAN and no temp
 *   b-tree; a bare `SCAN facts` that sorts with a temp b-tree is refused.
 * - every point and the traverse must be an indexed SEARCH (USING PRIMARY KEY /
 *   INDEX / COVERING INDEX), no full SCAN, no temp b-tree.
 */
export type PlanProof = {
	feedOrderedIndex: boolean;
	pointIndexed: boolean;
	traverseIndexed: boolean;
	ok: boolean;
};

/** A candidate's DDL-level constraint proof (raw-attack refusals), retained per cell. */
export type ConstraintProof = { failures: string[]; ok: boolean };

/** An indexed SEARCH with no full SCAN and no temp b-tree. */
const isIndexedSearch = (plan: string): boolean => {
	const p = plan.toUpperCase();
	if (p.trim().length === 0) return false;
	if (p.includes('TEMP B-TREE') || p.includes('SCAN')) return false;
	return p.includes('SEARCH') && p.includes('USING ');
};

/** The feed orders by an index range on the sequence column, no scan, no temp b-tree. */
const isFeedOrderedIndex = (plan: string): boolean => {
	const p = plan.toUpperCase();
	if (p.trim().length === 0) return false;
	if (p.includes('TEMP B-TREE') || p.includes('SCAN')) return false;
	return p.includes('USING INDEX') && p.includes('SEQUENCE>');
};

/** Validate plan semantics per operation from the raw plans. */
export function evaluatePlanProof(plans: QueryPlans): PlanProof {
	const feedOrderedIndex = isFeedOrderedIndex(plans.feed);
	const pointIndexed =
		isIndexedSearch(plans.rowPoint) && isIndexedSearch(plans.valuePoint);
	const traverseIndexed = isIndexedSearch(plans.traverse);
	return {
		feedOrderedIndex,
		pointIndexed,
		traverseIndexed,
		ok: feedOrderedIndex && pointIndexed && traverseIndexed,
	};
}

export type RunResult = {
	candidateId: string;
	owner: Owner;
	repetition: number;
	dataSeed: number;
	/** The runtime and profile this cell ran under (per-cell identity). */
	runtime: string;
	profile: string;
	/** The settled per-cell outcome. This Bun instrument emits only passed/failed. */
	outcome: CellOutcome;
	/** Reconstruction and durability were exact (distinct from proof outcomes). */
	correct: boolean;
	reason: string;
	/** Raw timing samples in milliseconds, per critical metric. */
	metrics: Record<string, number[]>;
	storage: StorageMeasure;
	plans: QueryPlans;
	planProof: PlanProof;
	constraintProof: ConstraintProof;
	/** The three-part witness before and after the close/reopen; they must match. */
	witness: {
		before: { count: number; bytes: number; digestHex: string };
		after: { count: number; bytes: number; digestHex: string };
	};
	/** `PRAGMA integrity_check` of the reopened database. */
	integrityCheck: string;
	/** Authority runs measure only the read-side feed; the write path is unmodeled. */
	authorityWriteModeled: boolean;
};

const EMPTY_WITNESS = { count: 0, bytes: 0, digestHex: '' };
const ZERO_STORAGE: StorageMeasure = {
	presentLogicalStateBytes: 0,
	currentProtocolFactBytes: 0,
	allocatedPageBytes: 0,
	nonFreelistPageBytes: 0,
	maxProtocolFactBytes: 0,
	presentCount: 0,
	currentCount: 0,
};
const EMPTY_PLANS: QueryPlans = {
	feed: '',
	rowPoint: '',
	valuePoint: '',
	traverse: '',
};

/** Time `run` `iterations` times, returning raw millisecond samples. */
function timeRaw(iterations: number, run: () => void): number[] {
	const samples: number[] = [];
	for (let i = 0; i < iterations; i += 1) {
		const start = performance.now();
		run();
		samples.push(performance.now() - start);
	}
	return samples;
}

export type RunnerOptions = {
	trace: TraceOptions;
	owner: Owner;
	repetition: number;
	/** Timed-operation iteration count; small for smoke, larger for full. */
	iterations: number;
	installBatch: number;
	/** Injected lifecycle: keeps this module free of any runtime-specific import. */
	openRuntime: RuntimeFactory;
	/** Runtime identity stamped onto the cell (e.g. 'bun'). */
	runtimeName: string;
	/** Profile identity stamped onto the cell (e.g. 'smoke'). */
	profile: string;
	/** The candidate's DDL constraint proof, computed once per candidate across the pragma matrix. */
	constraintProof: ConstraintProof;
};

export async function runCandidate(
	candidate: Candidate,
	options: RunnerOptions,
): Promise<RunResult> {
	const trace = makeTrace(options.trace);
	const metrics: Record<string, number[]> = {};
	// Single mutable result state; every path folds into one returned cell.
	let firstFailure = '';
	const fail = (r: string): void => {
		if (!firstFailure) firstFailure = r;
	};
	let storage = ZERO_STORAGE;
	let plans = EMPTY_PLANS;
	let witnessBefore = EMPTY_WITNESS;
	let witnessAfter = EMPTY_WITNESS;
	let integrity = 'unrun';
	let runtime: BenchmarkRuntime | undefined;
	try {
		runtime = await options.openRuntime(ddlStatements(candidate));
		const db = runtime.db;
		const store = createStore(db, candidate);

		// Build: install the corpus through the atomic page seam, one transaction
		// per page, never a transaction wrapped around per-fact installs. The
		// authority replays its full event log (every install, with intermediate
		// overwrites and tombstones); the replica acquires only the settled current
		// facts in sequence order from an already-folded authority. Both reconstruct
		// the same oracle state, monotonic install guaranteeing it.
		const source =
			options.owner === 'authority'
				? trace.events()
				: trace.finalFactsBySequence();
		const acquisition = timeRaw(1, () => {
			let batch: Fact[] = [];
			const flush = (): void => {
				store.installPage(batch);
				batch = [];
			};
			for (const fact of source) {
				batch.push(fact);
				if (batch.length >= options.installBatch) flush();
			}
			if (batch.length > 0) flush();
		});
		metrics.acquisition = acquisition;

		// Correctness against the independent oracle (count, bytes, ordered digest).
		const expected = trace.measure();
		const actual = factSetDigest(store.scanBySequence());
		witnessBefore = actual;
		if (
			actual.count !== expected.currentCount ||
			actual.bytes !== expected.currentProtocolFactBytes ||
			actual.digestHex !== expected.digestHex
		) {
			fail('reconstruction diverged from the oracle');
		}

		// Physical page measures after a full checkpoint.
		await runtime.checkpoint();
		const pageMetrics = await runtime.pageMetrics(store.storageTables());
		storage = {
			presentLogicalStateBytes: expected.presentLogicalStateBytes,
			currentProtocolFactBytes: expected.currentProtocolFactBytes,
			...pageMetrics,
			maxProtocolFactBytes: expected.maxProtocolFactBytes,
			presentCount: expected.presentCount,
			currentCount: expected.currentCount,
		};

		const rows = trace.sampleRowAddresses(options.iterations);
		const values = trace.sampleValueAddresses(options.iterations);

		if (options.owner === 'replica') {
			metrics.rowPointRead = timeRaw(options.iterations, () => {
				for (const a of rows) store.get(a);
			});
			metrics.valuePointRead = timeRaw(options.iterations, () => {
				for (const a of values) store.get(a);
			});
			metrics.traverse = timeRaw(
				Math.max(1, Math.floor(options.iterations / 8)),
				() => {
					const a = rows[0];
					if (a?.kind === 'row') store.traverse(a.namespace, a.table);
				},
			);
		} else {
			metrics.feedFresh = timeRaw(
				Math.max(1, Math.floor(options.iterations / 8)),
				() => {
					store.feedPage(0, 256);
				},
			);
			const mid = Math.floor(expected.currentCount / 2);
			metrics.feedResume = timeRaw(options.iterations, () => {
				store.feedPage(mid, 256);
			});
			metrics.foldPointRead = timeRaw(options.iterations, () => {
				for (const a of rows) store.get(a);
			});
		}

		plans = {
			feed: store.queryPlan('feed'),
			rowPoint: store.queryPlan('rowPoint'),
			valuePoint: store.queryPlan('valuePoint'),
			traverse: store.queryPlan('traverse'),
		};

		// Warm reopen: time close + open + schema statement rebuild + probe.
		// Async-capable, so the close/reopen is bracketed explicitly rather than
		// wrapped in the synchronous `timeRaw`.
		const reopenStart = performance.now();
		await runtime.close();
		const reopenedDb = await runtime.reopen();
		const reopenedProbe = createStore(reopenedDb, candidate);
		const firstRow = rows[0];
		if (firstRow) reopenedProbe.get(firstRow);
		metrics.warmReopen = [performance.now() - reopenStart];
		// The witness (count, bytes, ordered digest) must be identical after the
		// close/reopen; durability that silently changed state is a failure.
		const reopenedStore = createStore(reopenedDb, candidate);
		witnessAfter = factSetDigest(reopenedStore.scanBySequence());
		if (
			witnessAfter.count !== witnessBefore.count ||
			witnessAfter.bytes !== witnessBefore.bytes ||
			witnessAfter.digestHex !== witnessBefore.digestHex
		) {
			fail('witness changed across close/reopen');
		}
		integrity =
			reopenedDb.all<{ integrity_check: string }>('PRAGMA integrity_check')[0]
				?.integrity_check ?? 'unknown';
		if (integrity !== 'ok') fail(`integrity_check: ${integrity}`);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	} finally {
		// Cleanup failure is retained on the cell, never thrown over the result.
		if (runtime) {
			try {
				await runtime.cleanup();
			} catch (error) {
				fail(
					`cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	// Build the single cell. Reconstruction/durability define `correct`; the
	// overall `outcome` additionally requires the plan and constraint proofs.
	const planProof = evaluatePlanProof(plans);
	const constraintProof = options.constraintProof;
	const correct = firstFailure === '';
	const outcome: CellOutcome =
		correct && planProof.ok && constraintProof.ok ? 'passed' : 'failed';
	const reason = firstFailure
		? firstFailure
		: !planProof.ok
			? 'query plan proof failed'
			: !constraintProof.ok
				? `constraint proof failed: ${constraintProof.failures[0] ?? ''}`
				: 'ok';
	return {
		candidateId: candidate.id,
		owner: options.owner,
		repetition: options.repetition,
		dataSeed: options.trace.dataSeed,
		runtime: options.runtimeName,
		profile: options.profile,
		outcome,
		correct,
		reason,
		metrics,
		storage,
		plans,
		planProof,
		constraintProof,
		witness: { before: witnessBefore, after: witnessAfter },
		integrityCheck: integrity,
		authorityWriteModeled: false,
	};
}
