/**
 * Instrumented eight-database lifecycle assertion (spec: retain all eight per
 * seed, and never delete before commit on the success path). Builds the retained
 * set at tiny scale (no timed reads) and proves the peak live set is eight and
 * cleanup deletes every file.
 * It also proves failed cleanup and reopen transitions retain truthful ownership.
 * Durable-write-before-cleanup ordering is covered in `pilot-commit.test.ts`.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Candidate } from './candidates.js';
import {
	buildRetainedSet,
	cleanupRetainedSet,
	openExisting,
	type RetainedSet,
	reopenRetained,
	retainedKey,
	withEphemeralDatabase,
} from './pilot.js';
import { makeTrace, type Trace } from './trace.js';

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'pilot-lifecycle-'));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tinyTrace(): Trace {
	// Small enough to build eight databases in milliseconds; no timed reads here.
	return makeTrace({
		facts: 120,
		namespaceCount: 6,
		tableCount: 20,
		valueRatio: 0.08,
		dataSeed: 1000,
		targetLogicalStateBytes: 120 * 100,
		maxEncodedFactBytes: 4096,
	});
}

const REOPEN_CANDIDATE: Candidate = {
	id: 'unified-inline',
	relation: 'unified',
	coordinates: 'inline',
};

function reopenHarness(failOnce: Set<string>) {
	const attempts: string[] = [];
	const attempt = (operation: string) => {
		attempts.push(operation);
		if (failOnce.delete(operation)) throw new Error(`${operation} boom`);
	};
	const key = retainedKey('replica', REOPEN_CANDIDATE.id);
	const set: RetainedSet = {
		handles: new Map([
			[
				key,
				{
					owner: 'replica',
					candidate: REOPEN_CANDIDATE.id,
					buildId: 'reopen-test',
					path: 'reopen-test.sqlite',
					cleanup: { finalized: false, closed: false, removed: false },
					store: { finalize: () => attempt('finalize') } as never,
					db: { close: () => attempt('close') } as never,
				},
			],
		]),
		peakLive: 1,
		cleanedUp: false,
	};
	return { attempts, key, set };
}

describe('eight-database retained lifetime', () => {
	test('peak live set is eight, one per owner and candidate', () => {
		const dir = tempDir();
		const trace = tinyTrace();
		const facts = Array.from({ length: trace.options.facts }, (_, i) =>
			trace.finalFactAt(i),
		);
		const set = buildRetainedSet(dir, 0, 'test-config', 1000, facts, trace);
		try {
			expect(set.handles.size).toBe(8);
			expect(set.peakLive).toBe(8);
			// One handle per owner-by-candidate, all files present on disk.
			for (const owner of ['replica', 'authority'] as const) {
				for (const candidate of [
					'unified-inline',
					'unified-normalized',
					'split-inline',
					'split-normalized',
				]) {
					const handle = set.handles.get(retainedKey(owner, candidate));
					expect(handle).toBeDefined();
					if (handle) expect(existsSync(handle.path)).toBe(true);
				}
			}
		} finally {
			cleanupRetainedSet(set);
		}
	});

	test('cleanup deletes every retained database file', () => {
		const dir = tempDir();
		const trace = tinyTrace();
		const facts = Array.from({ length: trace.options.facts }, (_, i) =>
			trace.finalFactAt(i),
		);
		const set = buildRetainedSet(dir, 1, 'test-config', 1001, facts, trace);
		const paths = [...set.handles.values()].map((h) => h.path);
		expect(paths.length).toBe(8);
		expect(paths.every((p) => existsSync(p))).toBe(true);
		cleanupRetainedSet(set);
		expect(set.cleanedUp).toBe(true);
		expect(set.handles.size).toBe(0);
		expect(paths.every((p) => !existsSync(p))).toBe(true);
		expect(paths.every((p) => !existsSync(`${p}-wal`))).toBe(true);
	});
});

describe('cleanup failure ownership', () => {
	test('every operation and later handle continues while close and removal failures remain retryable', () => {
		const attempts: string[] = [];
		const failOnce = new Set([
			'finalize-fails:finalize',
			'close-fails:close',
			'remove-fails:remove',
		]);
		const attempt = (operation: string) => {
			attempts.push(operation);
			if (failOnce.delete(operation)) throw new Error(`${operation} boom`);
		};
		const set: RetainedSet = {
			handles: new Map(),
			peakLive: 4,
			cleanedUp: false,
		};
		for (const key of [
			'finalize-fails',
			'close-fails',
			'remove-fails',
			'later-succeeds',
		]) {
			set.handles.set(key, {
				owner: 'replica',
				candidate: key,
				buildId: key,
				path: key,
				cleanup: { finalized: false, closed: false, removed: false },
				store: {
					finalize: () => attempt(`${key}:finalize`),
				} as never,
				db: {
					close: () => attempt(`${key}:close`),
				} as never,
			});
		}
		const removeOne = (path: string) => attempt(`${path}:remove`);

		let caught: unknown;
		try {
			cleanupRetainedSet(set, removeOne);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(AggregateError);
		const aggregate = caught as AggregateError;
		expect(aggregate.errors.map((error) => (error as Error).message)).toEqual([
			"Failed to finalize retained database 'finalize-fails'",
			"Failed to close retained database 'close-fails'",
			"Failed to remove retained database 'remove-fails'",
		]);
		expect(attempts).toEqual([
			'finalize-fails:finalize',
			'finalize-fails:close',
			'finalize-fails:remove',
			'close-fails:finalize',
			'close-fails:close',
			'remove-fails:finalize',
			'remove-fails:close',
			'remove-fails:remove',
			'later-succeeds:finalize',
			'later-succeeds:close',
			'later-succeeds:remove',
		]);
		expect([...set.handles.keys()]).toEqual(['close-fails', 'remove-fails']);
		expect(set.handles.get('close-fails')?.cleanup).toEqual({
			finalized: true,
			closed: false,
			removed: false,
		});
		expect(set.handles.get('remove-fails')?.cleanup).toEqual({
			finalized: true,
			closed: true,
			removed: false,
		});
		expect(set.cleanedUp).toBe(false);

		cleanupRetainedSet(set, removeOne);
		expect(attempts.slice(11)).toEqual([
			'close-fails:close',
			'close-fails:remove',
			'remove-fails:remove',
		]);
		expect(set.handles.size).toBe(0);
		expect(set.cleanedUp).toBe(true);
	});
});

describe('ephemeral database ownership', () => {
	test('acquisition failure never removes an unowned existing path', () => {
		const acquisitionError = new Error('acquire boom');
		let removeCalls = 0;
		expect(() =>
			openExisting('reopen-test.sqlite', REOPEN_CANDIDATE, {
				acquire: () => {
					throw acquisitionError;
				},
				removeOnFailure: true,
				removeOne: () => {
					removeCalls += 1;
				},
			}),
		).toThrow(acquisitionError);
		expect(removeCalls).toBe(0);
	});

	test('post-acquisition initialization failure closes the acquired connection', () => {
		const setupError = new Error('setup boom');
		const attempts: string[] = [];
		const db = {
			close() {
				attempts.push('close');
			},
		};

		let caught: unknown;
		try {
			openExisting('reopen-test.sqlite', REOPEN_CANDIDATE, {
				acquire: () => db as never,
				initialize: () => {
					attempts.push('initialize');
					throw setupError;
				},
				removeOnFailure: true,
				removeOne: () => attempts.push('remove'),
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(setupError);
		expect(attempts).toEqual(['initialize', 'close', 'remove']);
	});

	test('a close failure preserves the initialization error first', () => {
		const setupError = new Error('setup boom');
		const closeError = new Error('close boom');
		const db = {
			close() {
				throw closeError;
			},
		};

		let caught: unknown;
		try {
			openExisting('reopen-test.sqlite', REOPEN_CANDIDATE, {
				acquire: () => db as never,
				initialize: () => {
					throw setupError;
				},
				removeOnFailure: true,
				removeOne: () => {
					throw new Error('remove must not run');
				},
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(AggregateError);
		const aggregate = caught as AggregateError;
		expect(aggregate.errors[0]).toBe(setupError);
		expect((aggregate.errors[1] as Error).cause).toBe(closeError);
		expect(aggregate.message).toContain(
			'could not be initialized or cleaned up',
		);
	});

	test('an action failure retains precedence and removes only after close', () => {
		const operationError = new Error('operation boom');
		const finalizeError = new Error('finalize boom');
		const attempts: string[] = [];
		let caught: unknown;
		try {
			withEphemeralDatabase({
				path: 'action-test.sqlite',
				opened: {
					store: {
						finalize() {
							attempts.push('finalize');
							throw finalizeError;
						},
					} as never,
					db: {
						close() {
							attempts.push('close');
						},
					} as never,
				},
				retainOnSuccess: true,
				operation() {
					attempts.push('operation');
					throw operationError;
				},
				removeOne: () => attempts.push('remove'),
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(AggregateError);
		const aggregate = caught as AggregateError;
		expect(aggregate.errors[0]).toBe(operationError);
		expect((aggregate.errors[1] as Error).cause).toBe(finalizeError);
		expect(attempts).toEqual(['operation', 'finalize', 'close', 'remove']);
	});

	test('a close failure prevents removal', () => {
		const attempts: string[] = [];
		expect(() =>
			withEphemeralDatabase({
				path: 'action-test.sqlite',
				opened: {
					store: {
						finalize: () => attempts.push('finalize'),
					} as never,
					db: {
						close() {
							attempts.push('close');
							throw new Error('close boom');
						},
					} as never,
				},
				operation: () => attempts.push('operation'),
				removeOne: () => attempts.push('remove'),
			}),
		).toThrow('cleanup was incomplete');
		expect(attempts).toEqual(['operation', 'finalize', 'close']);
	});

	test('a successful intermediate stage closes but retains its file', () => {
		const attempts: string[] = [];
		const result = withEphemeralDatabase({
			path: 'action-test.sqlite',
			opened: {
				store: {
					finalize: () => attempts.push('finalize'),
				} as never,
				db: {
					close: () => attempts.push('close'),
				} as never,
			},
			operation: () => {
				attempts.push('operation');
				return 42;
			},
			retainOnSuccess: true,
			removeOne: () => attempts.push('remove'),
		});

		expect(result).toBe(42);
		expect(attempts).toEqual(['operation', 'finalize', 'close']);
	});

	test('cleanup failure revokes an intermediate stage retention', () => {
		const attempts: string[] = [];
		expect(() =>
			withEphemeralDatabase({
				path: 'action-test.sqlite',
				opened: {
					store: {
						finalize() {
							attempts.push('finalize');
							throw new Error('finalize boom');
						},
					} as never,
					db: {
						close: () => attempts.push('close'),
					} as never,
				},
				operation: () => attempts.push('operation'),
				retainOnSuccess: true,
				removeOne: () => attempts.push('remove'),
			}),
		).toThrow('cleanup was incomplete');
		expect(attempts).toEqual(['operation', 'finalize', 'close', 'remove']);
	});
});

describe('reopen failure ownership', () => {
	test('a finalizer failure still closes and leaves the handle removable', () => {
		const { attempts, key, set } = reopenHarness(new Set(['finalize']));
		expect(() =>
			reopenRetained(set, 'replica', REOPEN_CANDIDATE, () => {
				attempts.push('open');
				throw new Error('open must not run');
			}),
		).toThrow('could not be safely reopened');
		expect(attempts).toEqual(['finalize', 'close']);
		expect(set.handles.get(key)?.cleanup).toEqual({
			finalized: false,
			closed: true,
			removed: false,
		});

		cleanupRetainedSet(set, () => attempts.push('remove'));
		expect(attempts).toEqual(['finalize', 'close', 'remove']);
		expect(set.cleanedUp).toBe(true);
	});

	test('a close failure aborts open and cleanup retries close before removal', () => {
		const { attempts, key, set } = reopenHarness(new Set(['close']));
		expect(() =>
			reopenRetained(set, 'replica', REOPEN_CANDIDATE, () => {
				attempts.push('open');
				throw new Error('open must not run');
			}),
		).toThrow('could not be safely reopened');
		expect(attempts).toEqual(['finalize', 'close']);
		expect(set.handles.get(key)?.cleanup).toEqual({
			finalized: true,
			closed: false,
			removed: false,
		});

		cleanupRetainedSet(set, () => attempts.push('remove'));
		expect(attempts).toEqual(['finalize', 'close', 'close', 'remove']);
		expect(set.cleanedUp).toBe(true);
	});

	test('an open failure leaves the prior closed handle for final removal', () => {
		const { attempts, key, set } = reopenHarness(new Set());
		expect(() =>
			reopenRetained(set, 'replica', REOPEN_CANDIDATE, () => {
				attempts.push('open');
				throw new Error('open boom');
			}),
		).toThrow('open boom');
		expect(attempts).toEqual(['finalize', 'close', 'open']);
		expect(set.handles.get(key)?.cleanup).toEqual({
			finalized: true,
			closed: true,
			removed: false,
		});

		cleanupRetainedSet(set, () => attempts.push('remove'));
		expect(attempts).toEqual(['finalize', 'close', 'open', 'remove']);
		expect(set.cleanedUp).toBe(true);
	});
});
