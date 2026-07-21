/**
 * Owner-specific workloads, timing, reopen, storage, and query plans.
 *
 * Each run builds one candidate into a temp WAL database, installs the shared
 * corpus, verifies the reconstructed state against the oracle's three-part
 * witness, then times the owner's critical operations keeping raw samples. The
 * database holds only the candidate-varying tables, so the whole-file page bytes
 * are exactly the storage metric (no fixture tables dilute it). Four byte
 * quantities are kept distinct (present logical state, current protocol facts,
 * allocated page bytes, non-freelist page bytes). A run that throws or whose
 * reconstruction diverges is a failed cell, never silently dropped.
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

export type PageMetrics = {
	allocatedPageBytes: number;
	nonFreelistPageBytes: number;
};

/**
 * The database lifecycle the runner depends on, runtime-neutral and async-ready.
 * Bun supplies a synchronous implementation; a future Worker/OPFS runtime can
 * return promises. The runner itself imports no `bun:sqlite` or `node:*`.
 */
export type BenchmarkRuntime = {
	db: SqliteDatabase;
	close(): void | Promise<void>;
	reopen(): SqliteDatabase | Promise<SqliteDatabase>;
	checkpoint(): void | Promise<void>;
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

export type RunResult = {
	candidateId: string;
	owner: Owner;
	repetition: number;
	dataSeed: number;
	correct: boolean;
	reason: string;
	/** Raw timing samples in milliseconds, per critical metric. */
	metrics: Record<string, number[]>;
	storage: StorageMeasure;
	plans: {
		feed: string;
		rowPoint: string;
		valuePoint: string;
		traverse: string;
	};
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
};

export async function runCandidate(
	candidate: Candidate,
	options: RunnerOptions,
): Promise<RunResult> {
	const trace = makeTrace(options.trace);
	const metrics: Record<string, number[]> = {};
	let correct = false;
	let reason = 'ok';
	const runtime = await options.openRuntime(ddlStatements(candidate));
	try {
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
		correct =
			actual.count === expected.currentCount &&
			actual.bytes === expected.currentProtocolFactBytes &&
			actual.digestHex === expected.digestHex;
		if (!correct) reason = 'reconstruction diverged from the oracle';

		// Physical page measures after a full checkpoint.
		await runtime.checkpoint();
		const pageMetrics = await runtime.pageMetrics(store.storageTables());

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

		const plans = {
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
		const witnessAfter = factSetDigest(reopenedStore.scanBySequence());
		if (
			witnessAfter.count !== actual.count ||
			witnessAfter.bytes !== actual.bytes ||
			witnessAfter.digestHex !== actual.digestHex
		) {
			correct = false;
			reason = 'witness changed across close/reopen';
		}
		const integrity =
			reopenedDb.all<{ integrity_check: string }>('PRAGMA integrity_check')[0]
				?.integrity_check ?? 'unknown';
		if (integrity !== 'ok') {
			correct = false;
			reason = `integrity_check: ${integrity}`;
		}
		return {
			candidateId: candidate.id,
			owner: options.owner,
			repetition: options.repetition,
			dataSeed: options.trace.dataSeed,
			correct,
			reason,
			metrics,
			storage: {
				presentLogicalStateBytes: expected.presentLogicalStateBytes,
				currentProtocolFactBytes: expected.currentProtocolFactBytes,
				...pageMetrics,
				maxProtocolFactBytes: expected.maxProtocolFactBytes,
				presentCount: expected.presentCount,
				currentCount: expected.currentCount,
			},
			plans,
			witness: { before: actual, after: witnessAfter },
			integrityCheck: integrity,
			authorityWriteModeled: false,
		};
	} catch (error) {
		return {
			candidateId: candidate.id,
			owner: options.owner,
			repetition: options.repetition,
			dataSeed: options.trace.dataSeed,
			correct: false,
			reason: error instanceof Error ? error.message : String(error),
			metrics,
			storage: {
				presentLogicalStateBytes: 0,
				currentProtocolFactBytes: 0,
				allocatedPageBytes: 0,
				nonFreelistPageBytes: 0,
				maxProtocolFactBytes: 0,
				presentCount: 0,
				currentCount: 0,
			},
			plans: { feed: '', rowPoint: '', valuePoint: '', traverse: '' },
			witness: { before: EMPTY_WITNESS, after: EMPTY_WITNESS },
			integrityCheck: 'unrun',
			authorityWriteModeled: false,
		};
	} finally {
		await runtime.cleanup();
	}
}
