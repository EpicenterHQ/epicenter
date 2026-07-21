/**
 * Failure-path tests for the runner's lifecycle handling. A runtime that throws
 * at open, close, reopen, or cleanup must yield exactly one failed cell, and a
 * cleanup failure must never override the first failure that already occurred.
 */
import { expect, test } from 'bun:test';
import type { SqliteDatabase } from '@epicenter/sqlite';

import { makeInMemoryBunDb } from './bun-runtime.js';
import { CANDIDATES } from './layouts.js';
import {
	type BenchmarkRuntime,
	type ConstraintProof,
	type RunnerOptions,
	runCandidate,
} from './runner.js';
import type { TraceOptions } from './trace.js';

const TRACE: TraceOptions = {
	facts: 40,
	namespaceCount: 4,
	tableCount: 6,
	valueRatio: 0.1,
	dataSeed: 1,
	targetLogicalStateBytes: 40 * 200,
	maxEncodedFactBytes: 8192,
};

const PASSING_CONSTRAINT: ConstraintProof = { ok: true, failures: [] };

/** A runtime over one in-memory db that can be told to throw at a lifecycle point. */
function fakeRuntime(
	throwAt?: 'open' | 'close' | 'reopen' | 'cleanup',
): (statements: string[]) => BenchmarkRuntime {
	return (statements) => {
		if (throwAt === 'open') throw new Error('open boom');
		const db: SqliteDatabase = makeInMemoryBunDb(statements);
		return {
			db,
			close() {
				if (throwAt === 'close') throw new Error('close boom');
			},
			reopen() {
				if (throwAt === 'reopen') throw new Error('reopen boom');
				return db; // in-memory: the same handle stands in for a reopen
			},
			checkpoint() {},
			pageMetrics() {
				return { allocatedPageBytes: 0, nonFreelistPageBytes: 0 };
			},
			cleanup() {
				if (throwAt === 'cleanup') throw new Error('cleanup boom');
			},
		};
	};
}

function options(
	throwAt?: 'open' | 'close' | 'reopen' | 'cleanup',
): RunnerOptions {
	return {
		trace: TRACE,
		owner: 'replica',
		repetition: 0,
		iterations: 3,
		installBatch: 8,
		openRuntime: fakeRuntime(throwAt),
		runtimeName: 'bun',
		profile: 'smoke',
		constraintProof: PASSING_CONSTRAINT,
	};
}

const candidate = CANDIDATES[0];
if (!candidate) throw new Error('no candidate');

test('openRuntime throwing yields one failed cell, no crash', async () => {
	const cell = await runCandidate(candidate, options('open'));
	expect(cell.outcome).toBe('failed');
	expect(cell.correct).toBe(false);
	expect(cell.reason).toContain('open boom');
});

test('close throwing yields a failed cell', async () => {
	const cell = await runCandidate(candidate, options('close'));
	expect(cell.outcome).toBe('failed');
	expect(cell.reason).toContain('close boom');
});

test('reopen throwing yields a failed cell', async () => {
	const cell = await runCandidate(candidate, options('reopen'));
	expect(cell.outcome).toBe('failed');
	expect(cell.reason).toContain('reopen boom');
});

test('cleanup throwing is retained as a failed cell', async () => {
	const cell = await runCandidate(candidate, options('cleanup'));
	expect(cell.outcome).toBe('failed');
	expect(cell.reason).toContain('cleanup failed');
});

test('cleanup failure does not override the first failure', async () => {
	// Reopen throws first; cleanup then also throws. The retained reason must be
	// the reopen failure, not the cleanup one.
	const throwBoth: (statements: string[]) => BenchmarkRuntime = (
		statements,
	) => {
		const db = makeInMemoryBunDb(statements);
		return {
			db,
			close() {},
			reopen(): SqliteDatabase {
				throw new Error('reopen boom');
			},
			checkpoint() {},
			pageMetrics() {
				return { allocatedPageBytes: 0, nonFreelistPageBytes: 0 };
			},
			cleanup() {
				throw new Error('cleanup boom');
			},
		};
	};
	const cell = await runCandidate(candidate, {
		...options(),
		openRuntime: throwBoth,
	});
	expect(cell.outcome).toBe('failed');
	expect(cell.reason).toContain('reopen boom');
	expect(cell.reason).not.toContain('cleanup boom');
});

test('point-read timing is singular: point queries grow linearly in N, not N^2', async () => {
	// A counting runtime tallies point-read queries (SELECT present, payload,
	// sequence ... WHERE ..., never an ORDER BY feed/scan). The acquisition phase
	// (fixed corpus) is a constant C independent of iterations; the timing phase
	// adds rowPointRead (N) + valuePointRead (N). So point queries = C + 2N + 1, and
	// the DELTA between two iteration counts is exactly 2*(N2-N1) when timing is
	// singular. Under the old N^2 loop the delta would be 2*(N2^2 - N1^2).
	const isPointRead = (sql: string): boolean =>
		sql.includes('present, payload, sequence') &&
		sql.includes('WHERE') &&
		!sql.includes('ORDER BY');
	const runCounting = async (iterations: number): Promise<number> => {
		let pointQueries = 0;
		const rt: (statements: string[]) => BenchmarkRuntime = (statements) => {
			const inner = makeInMemoryBunDb(statements);
			const db: SqliteDatabase = {
				run: (sql, params) => inner.run(sql, params),
				all: (sql, params) => {
					if (isPointRead(sql)) pointQueries += 1;
					return inner.all(sql, params);
				},
				transaction: (fn) => inner.transaction(fn),
			};
			return {
				db,
				close() {},
				reopen() {
					return db;
				},
				checkpoint() {},
				pageMetrics() {
					return { allocatedPageBytes: 0, nonFreelistPageBytes: 0 };
				},
				cleanup() {
					inner.close();
				},
			};
		};
		const cell = await runCandidate(candidate, {
			...options(),
			iterations,
			openRuntime: rt,
		});
		expect(cell.correct).toBe(true);
		expect((cell.metrics.rowPointRead ?? []).length).toBe(iterations);
		return pointQueries;
	};
	const n1 = 6;
	const n2 = 12;
	const delta = (await runCounting(n2)) - (await runCounting(n1));
	expect(delta).toBe(2 * (n2 - n1)); // linear: 12
	expect(delta).not.toBe(2 * (n2 * n2 - n1 * n1)); // not quadratic: 216
});
