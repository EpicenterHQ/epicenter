/**
 * Checkpoint-write ordering and partial-construction rollback (audit blocker 1).
 * The retained databases must survive a durable manifest-write failure (never
 * deleted under a false completed boundary), and a build that fails partway must
 * leave no open database or file behind.
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	completenessExpectations,
	createManifest,
	type ProvenanceConfig,
	type SeedRecord,
} from './checkpoint.js';
import {
	buildRetainedSet,
	cleanupRetainedSet,
	commitSeedCheckpoint,
} from './pilot.js';
import { buildCompleteRaw } from './raw-schema.test-support.js';
import { makeTrace, type Trace } from './trace.js';

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'pilot-commit-'));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tinyTrace(): Trace {
	return makeTrace({
		facts: 120,
		namespaceCount: 6,
		tableCount: 20,
		valueRatio: 0.08,
		dataSeed: 2000,
		targetLogicalStateBytes: 120 * 100,
		maxEncodedFactBytes: 4096,
	});
}
function finalFacts(trace: Trace) {
	return Array.from({ length: trace.options.facts }, (_, i) =>
		trace.finalFactAt(i),
	);
}

const CONFIG: ProvenanceConfig = {
	sourceVersion: 'test',
	profile: 'smoke',
	isPilot: true,
	candidates: [
		'unified-inline',
		'unified-normalized',
		'split-inline',
		'split-normalized',
	],
	owners: ['replica', 'authority'],
	seedIds: [1000],
	cycles: 1,
	reopenObservations: 2,
	tailTransactions: 2,
	maxReadBlocks: 64,
	minBlockMs: 20,
	bootstrapDraws: 10,
	bootstrapSeed: 1,
	ddlHashes: {},
	limitsDigest: 'd',
	runtime: { bun: 'x', sqlite: 'y' },
	executionSettings: {},
	workloadDigest: 'w',
	auxiliaryDigest: 'a',
};

function seedRecord(): SeedRecord {
	return {
		seedId: 1000,
		estimators: { 'replica/confirmedPointRead': 1 },
		hashes: { trace: 't' },
		raw: buildCompleteRaw(completenessExpectations(CONFIG, 0)),
		seedGatesPassed: true,
	} as unknown as SeedRecord;
}

describe('durable-write-before-delete ordering', () => {
	test('a manifest-write failure leaves all eight databases retained', () => {
		const dir = tempDir();
		const retained = buildRetainedSet(
			dir,
			0,
			finalFacts(tinyTrace()),
			tinyTrace(),
		);
		const paths = [...retained.handles.values()].map((h) => h.path);
		try {
			expect(() =>
				commitSeedCheckpoint({
					manifest: createManifest(CONFIG),
					record: seedRecord(),
					retained,
					persist: () => {
						throw new Error('disk full');
					},
				}),
			).toThrow('disk full');
			// The write failed, so NOTHING may have been deleted.
			expect(retained.cleanedUp).toBe(false);
			expect(retained.handles.size).toBe(8);
			expect(paths.every((p) => existsSync(p))).toBe(true);
		} finally {
			cleanupRetainedSet(retained);
		}
	});

	test('a successful durable write deletes the retained set afterward', () => {
		const dir = tempDir();
		const retained = buildRetainedSet(
			dir,
			1,
			finalFacts(tinyTrace()),
			tinyTrace(),
		);
		const paths = [...retained.handles.values()].map((h) => h.path);
		let persistedWhileRetained = false;
		const next = commitSeedCheckpoint({
			manifest: createManifest(CONFIG),
			record: seedRecord(),
			retained,
			persist: () => {
				// The durable write must see the databases still whole.
				persistedWhileRetained =
					retained.cleanedUp === false && retained.handles.size === 8;
			},
		});
		expect(persistedWhileRetained).toBe(true);
		expect(next.completedSeeds.length).toBe(1);
		expect(retained.cleanedUp).toBe(true);
		expect(paths.every((p) => !existsSync(p))).toBe(true);
	});
});

describe('partial construction rollback', () => {
	test('the fourth DB is really opened and registered, then populate throws: no file or handle remains', () => {
		const dir = tempDir();
		const facts = finalFacts(tinyTrace());
		const trace = tinyTrace();
		// Real open of every file (stage one). The fourth populate (stage two) throws
		// AFTER its database file has been created and registered.
		const opened: { db: Database; path: string; closed: boolean }[] = [];
		const openOne = (path: string) => {
			const db = new Database(path); // actually creates the file on disk
			const record = { db, path, closed: false };
			const realClose = db.close.bind(db);
			db.close = () => {
				record.closed = true;
				return realClose();
			};
			opened.push(record);
			return { db };
		};
		let populateCalls = 0;
		const populateOne = () => {
			populateCalls += 1;
			if (populateCalls === 4) throw new Error('populate failed');
			return { finalize() {} } as never;
		};
		expect(() =>
			buildRetainedSet(dir, 2, facts, trace, openOne, populateOne),
		).toThrow('populate failed');
		// Four files were opened (three populated, the fourth registered then failed).
		expect(opened.length).toBe(4);
		expect(populateCalls).toBe(4);
		// Every opened database, INCLUDING the fourth, is closed and its file deleted.
		expect(opened.every((r) => r.closed)).toBe(true);
		expect(opened.every((r) => !existsSync(r.path))).toBe(true);
	});

	test('a throwing finalizer during rollback still closes 4/4 and removes every file', () => {
		const dir = tempDir();
		const facts = finalFacts(tinyTrace());
		const trace = tinyTrace();
		const opened: { path: string }[] = [];
		let closeCount = 0;
		const openOne = (path: string) => {
			const db = new Database(path);
			const realClose = db.close.bind(db);
			db.close = () => {
				closeCount += 1;
				return realClose();
			};
			opened.push({ path });
			return { db };
		};
		let populateCalls = 0;
		const populateOne = () => {
			populateCalls += 1;
			if (populateCalls === 4) throw new Error('populate failed');
			// The FIRST populated store's finalizer throws during rollback; it must not
			// skip that record's close or file removal, nor any later record's.
			const shouldThrow = populateCalls === 1;
			return {
				finalize() {
					if (shouldThrow) throw new Error('finalize boom');
				},
			} as never;
		};
		let caught: unknown;
		try {
			buildRetainedSet(dir, 3, facts, trace, openOne, populateOne);
		} catch (error) {
			caught = error;
		}
		// The original population error is preserved FIRST in the aggregate.
		expect(caught).toBeInstanceOf(AggregateError);
		const aggregate = caught as AggregateError;
		expect((aggregate.errors[0] as Error).message).toBe('populate failed');
		expect(
			aggregate.errors.some((e) => (e as Error).message === 'finalize boom'),
		).toBe(true);
		// Despite the throwing finalizer, all four opened databases were closed and
		// all four files removed.
		expect(closeCount).toBe(4);
		expect(opened.length).toBe(4);
		expect(opened.every((r) => !existsSync(r.path))).toBe(true);
	});
});
