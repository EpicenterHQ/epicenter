/**
 * What only prototype B can express. Each of these is a row in the decision
 * matrix that the shared conformance suite cannot reach, because prototype A
 * has no vocabulary for it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
	acquireWriteLease,
	inspect,
	openReader,
	PlanRefusedError,
} from '../src/plan/index.ts';
import { comparePlan } from '../src/plan/manifest.ts';
import { createRuntime, defaultRoots } from '../src/plan/runtime.ts';
import {
	baseline,
	nextFormat,
	purchaseGainedColumn,
	reordered,
	seededAuthority,
	type Tmp,
	tempRoot,
	withIndex,
	withNewTable,
} from './fixtures.ts';

let tmp: Tmp;
beforeEach(() => {
	tmp = tempRoot('plan');
});
afterEach(() => tmp.cleanup());

const makeRuntime = () =>
	createRuntime({
		cacheRoot: join(tmp.dir, 'cache'),
		dataRoot: join(tmp.dir, 'data'),
	});

function sync(
	runtime: ReturnType<typeof makeRuntime>,
	declaration: Parameters<typeof inspect>[0],
	principal: string,
	authorityId: string,
) {
	const location = runtime.locate({ family: 'books', principal });
	const result = acquireWriteLease(location);
	if (!result.acquired) throw new Error('lease unavailable');
	const controller = result.lease.open(declaration, authorityId);
	try {
		const state = controller.state();
		if (state.kind === 'absent' || state.kind === 'stale')
			controller.apply(state.plan);
		controller.ingest(seededAuthority(authorityId).all(), {
			syncedAt: '2026-07-31T00:00:00Z',
		});
		controller.setCursor(7);
	} finally {
		controller.close();
		result.lease.release();
	}
	return location;
}

describe('the plan is a value, computed without a disk', () => {
	test('a matching declaration is current, whatever key order it was written in', () => {
		const manifest = comparePlan(baseline, 'realm-a', null);
		expect(manifest.kind).toBe('absent');
		if (manifest.kind !== 'absent') return;

		const stored = manifest.plan.nextManifest;
		expect(comparePlan(baseline, 'realm-a', stored).kind).toBe('current');
		expect(comparePlan(reordered, 'realm-a', stored).kind).toBe('current');
		expect(comparePlan(withIndex, 'realm-a', stored).kind).toBe('current');
	});

	test('a changed table names itself, and the cursor survives', () => {
		const stored = requirePlan(
			comparePlan(baseline, 'realm-a', null),
		).nextManifest;
		const state = comparePlan(purchaseGainedColumn, 'realm-a', stored);
		expect(state.kind).toBe('stale');
		if (state.kind !== 'stale') return;

		expect(state.plan.reason).toBe('declaration-changed');
		expect(state.plan.dropTables).toEqual(['purchase']);
		expect(state.plan.clearCursor).toBe(false);
		expect(state.plan.changes).toEqual([
			{ kind: 'changed', table: 'purchase', paths: ['columns'] },
		]);
		expect(state.plan.describe()).toContain('purchase changed at columns');
		expect(state.plan.describe()).toContain('cursor kept');
	});

	test('an added table drops nothing at all', () => {
		const stored = requirePlan(
			comparePlan(baseline, 'realm-a', null),
		).nextManifest;
		const state = comparePlan(withNewTable, 'realm-a', stored);
		if (state.kind !== 'stale') throw new Error('expected stale');

		expect(state.plan.dropTables).toEqual([]);
		expect(state.plan.changes).toEqual([{ kind: 'added', table: 'bill' }]);
		expect(state.plan.clearCursor).toBe(false);
	});

	test('a removed table drops only itself, named from the stored manifest', () => {
		const stored = requirePlan(
			comparePlan(withNewTable, 'realm-a', null),
		).nextManifest;
		const state = comparePlan(baseline, 'realm-a', stored);
		if (state.kind !== 'stale') throw new Error('expected stale');

		expect(state.plan.dropTables).toEqual(['bill']);
		expect(state.plan.changes).toEqual([{ kind: 'removed', table: 'bill' }]);
	});

	test('a declaration format change refuses to compare and clears the cursor', () => {
		const stored = requirePlan(
			comparePlan(baseline, 'realm-a', null),
		).nextManifest;
		const state = comparePlan(nextFormat, 'realm-a', stored);
		if (state.kind !== 'stale') throw new Error('expected stale');

		expect(state.plan.reason).toBe('format-change');
		expect(state.plan.changes).toEqual([]);
		expect(state.plan.dropTables.sort()).toEqual(['purchase', 'vendor']);
		expect(state.plan.clearCursor).toBe(true);
	});
});

describe('authority identity is checked separately from the fingerprint', () => {
	test('a store stamped for another principal is foreign, not stale', () => {
		const runtime = makeRuntime();
		const location = sync(runtime, baseline, 'realm-a', 'realm-a');

		// The same declaration, the same file, a different upstream principal:
		// exactly what a restored backup or a reauthorization against another
		// company produces.
		const state = inspect(baseline, location, 'realm-b');
		expect(state.kind).toBe('foreign');
	});

	test('a foreign store yields no reader at all', () => {
		const runtime = makeRuntime();
		const location = sync(runtime, baseline, 'realm-a', 'realm-a');

		const reader = openReader(baseline, location, 'realm-b');
		expect(reader.kind).toBe('foreign');
		if (reader.kind !== 'foreign') return;
		expect(reader.storedAuthority).toBe('realm-a');
		expect(reader.expectedAuthority).toBe('realm-b');
	});

	test('a foreign store is refused rather than silently rebuilt', () => {
		const runtime = makeRuntime();
		const location = sync(runtime, baseline, 'realm-a', 'realm-a');

		const result = acquireWriteLease(location);
		if (!result.acquired) throw new Error('lease unavailable');
		const controller = result.lease.open(baseline, 'realm-b');
		try {
			const absent = comparePlan(baseline, 'realm-b', null);
			if (absent.kind !== 'absent') throw new Error('expected absent');
			expect(() => controller.apply(absent.plan)).toThrow(PlanRefusedError);
		} finally {
			controller.close();
			result.lease.release();
		}
	});

	test('a plan built for one declaration cannot be applied to another', () => {
		const runtime = makeRuntime();
		const location = runtime.locate({ family: 'books', principal: 'realm-a' });
		const result = acquireWriteLease(location);
		if (!result.acquired) throw new Error('lease unavailable');
		const controller = result.lease.open(baseline, 'realm-a');
		try {
			const other = comparePlan(withNewTable, 'realm-a', null);
			if (other.kind !== 'absent') throw new Error('expected absent');
			expect(() => controller.apply(other.plan)).toThrow(PlanRefusedError);
		} finally {
			controller.close();
			result.lease.release();
		}
	});
});

describe('one sync owner per principal', () => {
	test('a second lease yields instead of racing', () => {
		const runtime = makeRuntime();
		const location = runtime.locate({ family: 'books', principal: 'realm-a' });

		const first = acquireWriteLease(location);
		expect(first.acquired).toBe(true);
		const second = acquireWriteLease(location);
		expect(second.acquired).toBe(false);

		if (first.acquired) first.lease.release();
		const third = acquireWriteLease(location);
		expect(third.acquired).toBe(true);
		if (third.acquired) third.lease.release();
	});

	test('a released lease cannot still write', () => {
		const runtime = makeRuntime();
		const location = runtime.locate({ family: 'books', principal: 'realm-a' });
		const result = acquireWriteLease(location);
		if (!result.acquired) throw new Error('lease unavailable');
		const controller = result.lease.open(baseline, 'realm-a');
		result.lease.release();

		expect(() => controller.setCursor(1)).toThrow();
		controller.close();
	});
});

describe('the runtime owns the path, so four prose rules become mechanical', () => {
	test('a materialization lives under cache-class storage, not the data root', () => {
		const runtime = makeRuntime();
		const location = runtime.locate({ family: 'books', principal: 'realm-a' });

		expect(relative(runtime.cacheRoot, location.dbPath).startsWith('..')).toBe(
			false,
		);
		expect(relative(runtime.dataRoot, location.dbPath).startsWith('..')).toBe(
			true,
		);
		expect(location.storageClass).toBe('cache');
	});

	test('the OS defaults split by durability class, not by app', () => {
		const roots = defaultRoots('local-books');
		expect(roots.cacheRoot).not.toBe(roots.dataRoot);
		expect(relative(roots.dataRoot, roots.cacheRoot).startsWith('..')).toBe(
			true,
		);
	});

	test('a credential can never be placed inside a store directory', () => {
		const runtime = makeRuntime();
		const location = runtime.locate({ family: 'books', principal: 'realm-a' });
		const credential = runtime.credentialPath({
			family: 'books',
			principal: 'realm-a',
		});

		expect(relative(location.dir, credential).startsWith('..')).toBe(true);
		expect(relative(runtime.cacheRoot, credential).startsWith('..')).toBe(true);
	});

	test('store directories are 0700 without any app remembering to ask', () => {
		const runtime = makeRuntime();
		const location = runtime.locate({ family: 'books', principal: 'realm-a' });
		expect(statSync(location.dir).mode & 0o777).toBe(0o700);
	});

	test('two principals get two directories, and neither can escape its root', () => {
		const runtime = makeRuntime();
		const a = runtime.locate({ family: 'books', principal: 'realm-a' });
		const b = runtime.locate({ family: 'books', principal: 'realm-b' });
		expect(a.dir).not.toBe(b.dir);

		expect(() =>
			runtime.locate({ family: 'books', principal: '../../escape' }),
		).toThrow();
		expect(() => runtime.locate({ family: 'books', principal: '' })).toThrow();
	});

	test('two families of one principal do not share a store', () => {
		const runtime = makeRuntime();
		const books = runtime.locate({
			family: 'books',
			principal: 'someone@example.com',
		});
		const mail = runtime.locate({
			family: 'mail',
			principal: 'someone@example.com',
		});
		expect(books.dbPath).not.toBe(mail.dbPath);
	});
});

describe('a stale read is a different type, not a flag', () => {
	test('stale rows arrive wrapped in the plan that explains them', () => {
		const runtime = makeRuntime();
		const location = sync(makeRuntime(), baseline, 'realm-a', 'realm-a');
		void runtime;

		const reader = openReader(purchaseGainedColumn, location, 'realm-a');
		expect(reader.kind).toBe('stale');
		if (reader.kind !== 'stale') return;

		const read = reader.read('vendor');
		expect(read.rows).toHaveLength(1);
		expect(read.staleness.describe()).toContain('purchase changed');
		reader.close();
	});

	test('a reader holds no method that could destroy the store', () => {
		const location = sync(makeRuntime(), baseline, 'realm-a', 'realm-a');
		const reader = openReader(baseline, location, 'realm-a');
		if (reader.kind !== 'current') throw new Error('expected current');

		// Not "has it and refuses": the reader type does not carry them at all.
		// These lines fail `bun run typecheck` if that ever stops being true.
		// @ts-expect-error a reader cannot rebuild
		expect(reader.apply).toBeUndefined();
		// @ts-expect-error a reader cannot ingest
		expect(reader.ingest).toBeUndefined();
		// @ts-expect-error a reader cannot move the cursor
		expect(reader.setCursor).toBeUndefined();
		reader.close();
	});
});

function requirePlan(state: ReturnType<typeof comparePlan>) {
	if (state.kind !== 'absent') throw new Error('expected an absent store');
	return state.plan;
}
