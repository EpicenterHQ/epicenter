/**
 * What prototype A can do, and what it structurally cannot. Both halves are
 * evidence: the interchangeable policies are a real win over an unconditional
 * drop, and the two holes below are the ones that survive every policy choice.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	openMaterialization,
	readStale,
	rebuildOnStale,
	refuseStale,
	StaleMaterializationError,
} from '../src/policy/index.ts';
import {
	baseline,
	purchaseGainedColumn,
	seededAuthority,
	type Tmp,
	tempRoot,
} from './fixtures.ts';

let tmp: Tmp;
beforeEach(() => {
	tmp = tempRoot('policy');
});
afterEach(() => tmp.cleanup());

function pathFor(principal: string): string {
	const dir = join(tmp.dir, principal);
	mkdirSync(dir, { recursive: true });
	return join(dir, 'store.sqlite3');
}

function seed(principal: string): string {
	const path = pathFor(principal);
	const handle = openMaterialization(baseline, { path });
	handle.ingest(seededAuthority(principal).all(), {
		syncedAt: '2026-07-31T00:00:00Z',
	});
	handle.setCursor(7);
	handle.close();
	return path;
}

describe('the lifecycle policy is interchangeable', () => {
	test('rebuildOnStale drops the derived tables and clears the cursor', () => {
		const path = seed('realm-a');
		const handle = openMaterialization(purchaseGainedColumn, {
			path,
			policy: rebuildOnStale,
		});
		try {
			expect(handle.stale).toBe(true);
			expect(handle.read('purchase')).toHaveLength(0);
			expect(handle.cursor()).toBe(0);
		} finally {
			handle.close();
		}
	});

	test('refuseStale never constructs a handle', () => {
		const path = seed('realm-a');
		expect(() =>
			openMaterialization(purchaseGainedColumn, { path, policy: refuseStale }),
		).toThrow(StaleMaterializationError);

		// And the store is untouched, so a rollback to the old release still reads.
		const back = openMaterialization(baseline, { path, readonly: true });
		expect(back.read('purchase')).toHaveLength(1);
		back.close();
	});

	test('readStale keeps the old rows and reports the mismatch', () => {
		const path = seed('realm-a');
		const handle = openMaterialization(purchaseGainedColumn, {
			path,
			policy: readStale,
		});
		try {
			expect(handle.stale).toBe(true);
			expect(handle.storedFingerprint).not.toBe(handle.fingerprint);
			// The rows survive, but the new column the release expects is absent,
			// which is the shape of the bug the fingerprint was meant to prevent.
			expect(handle.read('purchase')[0]?.['account_ref']).toBeUndefined();
		} finally {
			handle.close();
		}
	});

	test('a read-only open reports staleness and stamps nothing', () => {
		const path = seed('realm-a');
		const reader = openMaterialization(purchaseGainedColumn, {
			path,
			readonly: true,
		});
		expect(reader.stale).toBe(true);
		reader.close();

		const after = openMaterialization(baseline, { path, readonly: true });
		expect(after.stale).toBe(false);
		after.close();
	});
});

describe('the holes no policy closes', () => {
	test('a store holding another principal opens as current', () => {
		// The store carries no authority identity, so a file restored from backup
		// or misfiled under another realm is indistinguishable from the right one.
		// Nothing in the fingerprint can catch this: ADR-0194 correctly excludes
		// authority identity from its inputs, which means something *else* has to
		// carry it, and in this shape nothing does.
		const path = seed('realm-a');
		const asOtherRealm = openMaterialization(baseline, {
			path,
			readonly: true,
		});
		try {
			expect(asOtherRealm.stale).toBe(false);
			expect(asOtherRealm.read('vendor')).toHaveLength(1);
		} finally {
			asOtherRealm.close();
		}
	});

	test('every handle carries rebuild, including one a reader was handed', () => {
		const path = seed('realm-a');
		const reader = openMaterialization(baseline, { path, readonly: true });
		try {
			// The method exists on the type. SQLite is the only thing stopping it,
			// and it stops it at the moment of the drop rather than at review time.
			expect(typeof reader.rebuild).toBe('function');
			expect(() => reader.rebuild()).toThrow();
		} finally {
			reader.close();
		}

		// On a writer handle it succeeds, from anywhere that holds the handle.
		const writer = openMaterialization(baseline, { path });
		try {
			expect(writer.read('vendor')).toHaveLength(1);
			writer.rebuild();
			expect(writer.read('vendor')).toHaveLength(0);
		} finally {
			writer.close();
		}
	});

	test('a whole-store fingerprint cannot say which table moved', () => {
		const path = seed('realm-a');
		const handle = openMaterialization(purchaseGainedColumn, {
			path,
			policy: rebuildOnStale,
		});
		try {
			// `vendor` was not touched by the declaration change, and it is gone
			// anyway: one digest for the whole store cannot express a smaller
			// rebuild, so a change to one table costs a full re-pull of all of them.
			expect(handle.read('vendor')).toHaveLength(0);
		} finally {
			handle.close();
		}
	});

	test('nothing prevents a second writer from opening and rebuilding', () => {
		const path = seed('realm-a');
		const first = openMaterialization(baseline, { path });
		const second = openMaterialization(baseline, { path });
		try {
			second.rebuild();
			expect(first.read('vendor')).toHaveLength(0);
		} finally {
			second.close();
			first.close();
		}
	});
});
