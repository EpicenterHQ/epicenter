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
	computeProvenanceIdentity,
	createManifest,
	type PilotManifest,
	type ProvenanceConfig,
	type SeedRecord,
} from './checkpoint.js';
import { buildSeedEstimators } from './estimators.js';
import {
	buildCalibrationIncompleteArtifact,
	buildRetainedSet,
	type CalibrationObservation,
	cleanupRetainedSet,
	persistSeedCheckpoint,
} from './pilot.js';
import { buildCompleteRaw } from './raw-schema.test-support.js';
import { evaluateCalibrationTrials } from './schedule.js';
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
	traceOptions: [
		{
			facts: 240,
			namespaceCount: 6,
			tableCount: 20,
			valueRatio: 0.08,
			dataSeed: 1000,
			targetLogicalStateBytes: 24_000,
			maxEncodedFactBytes: 4096,
		},
	],
	cycles: 1,
	reopenObservations: 2,
	tailTransactions: 2,
	maxReadBlocks: 64,
	minBlockMs: 20,
	maxBlockOps: 1 << 20,
	ddlHashes: {
		'unified-inline': 'h1',
		'unified-normalized': 'h2',
		'split-inline': 'h3',
		'split-normalized': 'h4',
	},
	limitsDigest: 'd',
	runtime: { bun: 'x', sqlite: 'y' },
	executionSettings: {
		journal_mode: 'WAL',
		synchronous: 'NORMAL',
		page_size: 4096,
		foreign_keys: 'ON',
		recursive_triggers: 'ON',
		wal_autocheckpoint: 1000,
	},
	workloadDigest: 'w',
	auxiliaryDigest: 'a',
};

function seedRecord(): SeedRecord {
	const raw = buildCompleteRaw(
		completenessExpectations(CONFIG, 0),
	) as SeedRecord['raw'];
	return {
		seedId: 1000,
		estimators: buildSeedEstimators(
			raw,
			computeProvenanceIdentity(CONFIG),
			1000,
		),
		hashes: { trace: 't', traceBound: '1', auxiliaryBound: '1' },
		raw,
	};
}

describe('durable persistence before cleanup', () => {
	test('calibration cap exhaustion produces an auditable incomplete artifact', () => {
		const provenance = { ...CONFIG, maxBlockOps: 2 };
		const expectations = completenessExpectations(provenance, 0);
		const raw = buildCompleteRaw(expectations) as SeedRecord['raw'];
		const trials = structuredClone(raw.calibrations).filter(
			(trial) =>
				(trial as { owner: string }).owner === 'replica' &&
				(trial as { metric: string }).metric === 'confirmedTraversal',
		) as CalibrationObservation[];
		const terminal = trials.find((trial) => trial.roundIndex === 1);
		expect(terminal).toBeDefined();
		if (terminal) terminal.elapsedMs = 19;
		expect(
			evaluateCalibrationTrials(
				trials,
				expectations.letterMapping as Record<'A' | 'B' | 'C' | 'D', string>,
				20,
				2,
			).status,
		).toBe('INCOMPLETE');
		const artifact = buildCalibrationIncompleteArtifact({
			provenance,
			manifestIdentity: computeProvenanceIdentity(provenance),
			refusal: {
				status: 'INCOMPLETE',
				reasonCode: 'CALIBRATION_OPS_UNSELECTED',
				selectedOps: null,
				reason: 'duration floor not reached at the operation cap',
				seedId: 1000,
				owner: 'replica',
				metric: 'confirmedTraversal',
				minBlockMs: 20,
				maxBlockOps: provenance.maxBlockOps,
				trials,
			},
			completedSeedIds: [],
			resumedSeedIds: [],
		});
		expect(artifact.status).toBe('INCOMPLETE');
		expect(artifact.selectedOps).toBeNull();
		expect(artifact.reasonCode).toBe('CALIBRATION_OPS_UNSELECTED');
		expect(artifact.method).toBeNull();
		expect(artifact).not.toHaveProperty('evidenceStatus');
		expect(artifact.completedSeedIds).toEqual([]);
		expect(JSON.stringify(artifact.trials)).toBe(JSON.stringify(trials));
	});

	test('a manifest-write failure leaves all eight databases retained', () => {
		const dir = tempDir();
		const retained = buildRetainedSet(
			dir,
			0,
			computeProvenanceIdentity(CONFIG),
			1000,
			finalFacts(tinyTrace()),
			tinyTrace(),
		);
		const paths = [...retained.handles.values()].map((h) => h.path);
		try {
			expect(() =>
				persistSeedCheckpoint({
					manifest: createManifest(CONFIG),
					record: seedRecord(),
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

	test('a successful durable write returns the committed manifest before cleanup', () => {
		const dir = tempDir();
		const retained = buildRetainedSet(
			dir,
			1,
			computeProvenanceIdentity(CONFIG),
			1000,
			finalFacts(tinyTrace()),
			tinyTrace(),
		);
		const paths = [...retained.handles.values()].map((h) => h.path);
		let persistedWhileRetained = false;
		let persisted: PilotManifest | undefined;
		const next = persistSeedCheckpoint({
			manifest: createManifest(CONFIG),
			record: seedRecord(),
			persist: (manifest) => {
				persisted = manifest;
				// The durable write must see the databases still whole.
				persistedWhileRetained =
					retained.cleanedUp === false && retained.handles.size === 8;
			},
		});
		expect(persistedWhileRetained).toBe(true);
		expect(persisted).toEqual(next);
		expect(next.completedSeeds.length).toBe(1);
		expect(retained.cleanedUp).toBe(false);
		expect(retained.handles.size).toBe(8);
		cleanupRetainedSet(retained);
		expect(retained.cleanedUp).toBe(true);
		expect(paths.every((p) => !existsSync(p))).toBe(true);
	});

	test('cleanup failure after persistence cannot hide or revert the committed manifest', () => {
		const dir = tempDir();
		const retained = buildRetainedSet(
			dir,
			2,
			computeProvenanceIdentity(CONFIG),
			1000,
			finalFacts(tinyTrace()),
			tinyTrace(),
		);
		const firstPath = retained.handles.values().next().value?.path;
		if (firstPath === undefined)
			throw new Error('expected a retained database');
		let manifest = createManifest(CONFIG);
		manifest = persistSeedCheckpoint({
			manifest,
			record: seedRecord(),
			persist: () => undefined,
		});
		let failRemoval = true;
		const removeOne = (path: string) => {
			if (path === firstPath && failRemoval) {
				failRemoval = false;
				throw new Error('remove failed');
			}
			for (const suffix of ['', '-wal', '-shm']) {
				rmSync(`${path}${suffix}`, { force: true });
			}
		};

		expect(() => cleanupRetainedSet(retained, removeOne)).toThrow(
			'could not be fully cleaned up',
		);
		expect(manifest.completedSeeds).toHaveLength(1);
		expect(manifest.completedSeeds[0]?.seedId).toBe(1000);
		expect(retained.cleanedUp).toBe(false);
		expect(retained.handles.size).toBe(1);
		cleanupRetainedSet(retained, removeOne);
		expect(manifest.completedSeeds).toHaveLength(1);
		expect(retained.cleanedUp).toBe(true);
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
			buildRetainedSet(
				dir,
				2,
				computeProvenanceIdentity(CONFIG),
				1000,
				facts,
				trace,
				openOne,
				populateOne,
			),
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
			buildRetainedSet(
				dir,
				3,
				computeProvenanceIdentity(CONFIG),
				1000,
				facts,
				trace,
				openOne,
				populateOne,
			);
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

	test('a close failure keeps that file while later rollback records still close and remove', () => {
		const dir = tempDir();
		const facts = finalFacts(tinyTrace());
		const trace = tinyTrace();
		const opened: Array<{
			path: string;
			closeForCleanup: () => void;
		}> = [];
		let closeCalls = 0;
		const openOne = (path: string) => {
			const db = new Database(path);
			const realClose = db.close.bind(db);
			const shouldFail = opened.length === 0;
			let failed = false;
			db.close = () => {
				closeCalls += 1;
				if (shouldFail && !failed) {
					failed = true;
					throw new Error('close boom');
				}
				return realClose();
			};
			opened.push({ path, closeForCleanup: realClose });
			return { db };
		};
		let populateCalls = 0;
		const populateOne = () => {
			populateCalls += 1;
			if (populateCalls === 4) throw new Error('populate failed');
			return { finalize() {} } as never;
		};

		let caught: unknown;
		try {
			buildRetainedSet(
				dir,
				4,
				computeProvenanceIdentity(CONFIG),
				1000,
				facts,
				trace,
				openOne,
				populateOne,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(AggregateError);
		const first = opened[0];
		if (first === undefined)
			throw new Error('expected the failed-close record');
		expect(
			(caught as AggregateError).errors.some(
				(error) =>
					(error as Error).message.includes(first.path) &&
					(error as Error).message.includes('file was retained'),
			),
		).toBe(true);
		expect(closeCalls).toBe(4);
		expect(opened).toHaveLength(4);
		expect(existsSync(first.path)).toBe(true);
		expect(opened.slice(1).every((record) => !existsSync(record.path))).toBe(
			true,
		);

		first.closeForCleanup();
		rmSync(first.path, { force: true });
	});
});
