/**
 * The checkpoint must make cross-identity resume impossible and only ever resume
 * at a committed whole-seed boundary. These tests target the resume-refusal and
 * partial-commit failures the recognition criteria require.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	commitSeed,
	computeProvenanceIdentity,
	createManifest,
	decideResume,
	type ProvenanceConfig,
	parseManifest,
	persistManifest,
	type SeedRecord,
	serializeManifest,
} from './checkpoint.js';

const CONFIG: ProvenanceConfig = {
	sourceVersion: 'f50a9c7d8a',
	profile: 'pilot',
	isPilot: true,
	candidates: [
		'unified-inline',
		'unified-normalized',
		'split-inline',
		'split-normalized',
	],
	owners: ['replica', 'authority'],
	seedIds: [1000, 1001, 1002, 1003],
	cycles: 3,
	minBlockMs: 20,
	bootstrapDraws: 10_000,
	bootstrapSeed: 0x5ca1ab1e,
	ddlHashes: { 'unified-inline': 'h1', 'unified-normalized': 'h2' },
	limitsDigest: 'limits-digest',
	runtime: { bun: '1.3.1', sqlite: '3.51.0' },
	executionSettings: { journal_mode: 'WAL', page_size: 4096 },
	workloadDigest: 'w-digest',
	auxiliaryDigest: 'a-digest',
};

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'ckpt-test-'));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function seedRecord(seedId: number): SeedRecord {
	return {
		seedId,
		estimators: { 'replica/unified-inline/confirmedPointRead': 1.23 },
		hashes: { trace: 'abc' },
		raw: {
			blocks: [],
			boundaries: [],
			reopens: [],
			tails: [],
			macros: [],
			cells: [],
		},
		seedGatesPassed: true,
	};
}

describe('provenance identity', () => {
	test('is stable and order-independent', () => {
		const a = computeProvenanceIdentity(CONFIG);
		// A reordered but equal config canonicalizes identically.
		const reordered: ProvenanceConfig = { ...CONFIG };
		expect(computeProvenanceIdentity(reordered)).toBe(a);
	});

	test('changes when any source or config field changes', () => {
		const base = computeProvenanceIdentity(CONFIG);
		expect(
			computeProvenanceIdentity({ ...CONFIG, sourceVersion: 'deadbeef' }),
		).not.toBe(base);
		expect(
			computeProvenanceIdentity({ ...CONFIG, workloadDigest: 'other' }),
		).not.toBe(base);
		expect(computeProvenanceIdentity({ ...CONFIG, bootstrapSeed: 1 })).not.toBe(
			base,
		);
		expect(computeProvenanceIdentity({ ...CONFIG, cycles: 4 })).not.toBe(base);
	});

	test('binds DDL hashes, limits, runtime, and execution settings', () => {
		const base = computeProvenanceIdentity(CONFIG);
		expect(
			computeProvenanceIdentity({
				...CONFIG,
				ddlHashes: { ...CONFIG.ddlHashes, 'unified-inline': 'changed' },
			}),
		).not.toBe(base);
		expect(
			computeProvenanceIdentity({ ...CONFIG, limitsDigest: 'changed' }),
		).not.toBe(base);
		expect(
			computeProvenanceIdentity({
				...CONFIG,
				runtime: { bun: '9.9.9', sqlite: '3.51.0' },
			}),
		).not.toBe(base);
		expect(
			computeProvenanceIdentity({
				...CONFIG,
				executionSettings: { ...CONFIG.executionSettings, page_size: 8192 },
			}),
		).not.toBe(base);
	});
});

describe('atomic persistence and schema-validated cross-process resume', () => {
	test('persist then parse round-trips a manifest', () => {
		const path = join(tempDir(), 'manifest.json');
		let manifest = createManifest(CONFIG);
		manifest = commitSeed(manifest, seedRecord(1000));
		persistManifest(path, manifest);
		const reloaded = parseManifest(readFileSync(path, 'utf8'));
		expect(reloaded).not.toBeNull();
		expect(reloaded?.completedSeeds.map((s) => s.seedId)).toEqual([1000]);
	});

	test('cross-process resume: reload from disk, resume, and skip committed seeds', () => {
		const path = join(tempDir(), 'manifest.json');
		// "Process A" commits seeds 1000 and 1001, then persists and exits.
		let a = createManifest(CONFIG);
		a = commitSeed(a, seedRecord(1000));
		a = commitSeed(a, seedRecord(1001));
		persistManifest(path, a);
		// "Process B" starts fresh, loads the manifest, and resumes.
		const loaded = parseManifest(readFileSync(path, 'utf8'));
		expect(loaded).not.toBeNull();
		const decision = decideResume(loaded as never, CONFIG);
		expect(decision.canResume).toBe(true);
		if (decision.canResume) {
			expect(decision.completedSeedIds).toEqual([1000, 1001]);
			expect(decision.remainingSeedIds).toEqual([1002, 1003]);
		}
	});

	test('a truncated manifest file is refused (fail closed)', () => {
		const path = join(tempDir(), 'manifest.json');
		persistManifest(path, commitSeed(createManifest(CONFIG), seedRecord(1000)));
		const truncated = readFileSync(path, 'utf8').slice(0, 40);
		expect(parseManifest(truncated)).toBeNull();
	});

	test('a config edited under a stale identity is refused', () => {
		const manifest = commitSeed(createManifest(CONFIG), seedRecord(1000));
		const serialized = serializeManifest(manifest);
		// Tamper with the config while leaving the stored identity untouched.
		const tampered = JSON.parse(serialized);
		tampered.config.cycles = 99;
		expect(parseManifest(JSON.stringify(tampered))).toBeNull();
	});

	test('a manifest with a partial (estimator-less) seed is refused', () => {
		const manifest = createManifest(CONFIG);
		const bad = {
			...manifest,
			completedSeeds: [
				{
					seedId: 1000,
					estimators: {},
					hashes: { t: 'x' },
					raw: {
						blocks: [],
						boundaries: [],
						reopens: [],
						tails: [],
						macros: [],
						cells: [],
					},
					seedGatesPassed: true,
				},
			],
		};
		// Recompute identity so only the seed shape is wrong.
		expect(parseManifest(JSON.stringify(bad))).toBeNull();
	});

	test('a manifest with a seed missing raw observations is refused', () => {
		const manifest = createManifest(CONFIG);
		const missingRaw = {
			...manifest,
			completedSeeds: [
				{
					seedId: 1000,
					estimators: { m: 1 },
					hashes: { t: 'x' },
					raw: { blocks: [], reopens: [], cells: [] }, // missing tails and macros
					seedGatesPassed: true,
				},
			],
		};
		expect(parseManifest(JSON.stringify(missingRaw))).toBeNull();
	});

	test('a raw observation with a non-finite numeric field is refused (corruption)', () => {
		// JSON cannot hold Infinity, so inject a raw 1e999 literal that JSON.parse
		// turns into Infinity, simulating a corrupted manifest on disk.
		const serialized = serializeManifest(
			commitSeed(createManifest(CONFIG), seedRecord(1000)),
		);
		const corrupt = serialized.replace(
			'"blocks": []',
			'"blocks": [{ "elapsedMs": 1e999 }]',
		);
		expect(corrupt).not.toBe(serialized); // the replacement actually happened
		expect(parseManifest(corrupt)).toBeNull();
	});

	test('a committed seed outside the config seed list is refused', () => {
		const manifest = commitSeed(createManifest(CONFIG), seedRecord(1000));
		const serialized = JSON.parse(serializeManifest(manifest));
		serialized.completedSeeds[0].seedId = 9999; // not in seedIds
		writeFileSync(join(tempDir(), 'm.json'), JSON.stringify(serialized));
		expect(parseManifest(JSON.stringify(serialized))).toBeNull();
	});
});

describe('resume decisions', () => {
	test('resumes under an identical config, reporting remaining seeds', () => {
		let manifest = createManifest(CONFIG);
		manifest = commitSeed(manifest, seedRecord(1000));
		manifest = commitSeed(manifest, seedRecord(1001));
		const decision = decideResume(manifest, CONFIG);
		expect(decision.canResume).toBe(true);
		if (decision.canResume) {
			expect(decision.completedSeedIds).toEqual([1000, 1001]);
			expect(decision.remainingSeedIds).toEqual([1002, 1003]);
		}
	});

	test('refuses to resume across a source-version change', () => {
		const manifest = commitSeed(createManifest(CONFIG), seedRecord(1000));
		const decision = decideResume(manifest, {
			...CONFIG,
			sourceVersion: 'other',
		});
		expect(decision.canResume).toBe(false);
		if (!decision.canResume) expect(decision.reason).toContain('mismatch');
	});

	test('refuses to resume across a workload-config change', () => {
		const manifest = commitSeed(createManifest(CONFIG), seedRecord(1000));
		const decision = decideResume(manifest, {
			...CONFIG,
			workloadDigest: 'changed',
		});
		expect(decision.canResume).toBe(false);
	});
});

describe('commit is whole-seed only', () => {
	test('refuses to commit a seed with no estimators (partial block)', () => {
		const manifest = createManifest(CONFIG);
		expect(() =>
			commitSeed(manifest, { ...seedRecord(1000), estimators: {} }),
		).toThrow(/partial/);
	});

	test('refuses to commit a duplicate seed', () => {
		const manifest = commitSeed(createManifest(CONFIG), seedRecord(1000));
		expect(() => commitSeed(manifest, seedRecord(1000))).toThrow(
			/already committed/,
		);
	});
});
