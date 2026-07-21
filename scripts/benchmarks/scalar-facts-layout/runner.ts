/**
 * Owner-specific workloads, timing, reopen, storage, and query plans.
 *
 * Each run builds one candidate into a page-addressable SQLite database, installs
 * the shared corpus, verifies the reconstructed state against the oracle's
 * three-part witness, then times the owner's critical operations keeping raw
 * samples. The database holds only the candidate-varying tables, so the
 * whole-file page bytes are exactly the storage metric (no fixture tables dilute
 * it). Four byte quantities are kept distinct (present logical state, current
 * protocol facts, allocated page bytes, non-freelist page bytes).
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
 * The lifecycle the runner depends on, over page-addressable file SQLite. Bun
 * supplies a synchronous implementation; a browser OPFS SQLite runtime can return
 * promises and reuse this contract unchanged. The runner imports no `bun:sqlite`
 * or `node:*`. Durable Object SQLite is explicitly OUT of scope: its storage is
 * not page/freelist addressable the same way, so it needs a separate runner with
 * its own storage accounting; `pageMetrics` here must never be faked for it.
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

/** Plan-semantics proof: point/traverse must be indexed SEARCH, feed no temp b-tree. */
export type PlanProof = {
	feedNoTempBtree: boolean;
	pointIndexed: boolean;
	traverseIndexed: boolean;
	ok: boolean;
};

/** A candidate's DDL-level constraint proof (raw-attack refusals), retained per cell. */
export type ConstraintProof = { failures: string[]; ok: boolean };

const isIndexedSearch = (plan: string): boolean => {
	const p = plan.toUpperCase();
	return p.includes('SEARCH') && !p.includes('SCAN');
};

/** Validate plan semantics per operation, not truthiness. Whitespace-only is empty. */
export function evaluatePlanProof(plans: QueryPlans): PlanProof {
	const feedNoTempBtree =
		plans.feed.trim().length > 0 &&
		!plans.feed.toUpperCase().includes('TEMP B-TREE');
	const pointIndexed =
		isIndexedSearch(plans.rowPoint) && isIndexedSearch(plans.valuePoint);
	const traverseIndexed = isIndexedSearch(plans.traverse);
	return {
		feedNoTempBtree,
		pointIndexed,
		traverseIndexed,
		ok: feedNoTempBtree && pointIndexed && traverseIndexed,
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
	/** The candidate's DDL constraint-proof failures, computed once per candidate. */
	constraintFailures: string[];
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

		// Build: install the corpus in bounded, nested-contract transactions.
		// The authority replays its full event log (every install, with
		// intermediate overwrites and tombstones); the replica acquires only the
		// settled current facts in sequence order from an already-folded authority.
		// Both reconstruct the same oracle state, monotonic install guaranteeing it.
		const source =
			options.owner === 'authority'
				? trace.events()
				: trace.finalFactsBySequence();
		const acquisition = timeRaw(1, () => {
			const batch: Fact[] = [];
			const installBatch = (): void => {
				db.transaction(() => {
					for (const fact of batch) store.install(fact);
				});
				batch.length = 0;
			};
			for (const fact of source) {
				batch.push(fact);
				if (batch.length >= options.installBatch) installBatch();
			}
			if (batch.length > 0) installBatch();
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
	const constraintProof: ConstraintProof = {
		failures: options.constraintFailures,
		ok: options.constraintFailures.length === 0,
	};
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
