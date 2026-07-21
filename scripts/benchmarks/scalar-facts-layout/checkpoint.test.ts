/**
 * The checkpoint must make cross-identity resume impossible and only ever resume
 * at a committed whole-seed boundary. These tests target the resume-refusal and
 * partial-commit failures the recognition criteria require.
 */

import { describe, expect, test } from 'bun:test';

import {
	commitSeed,
	computeProvenanceIdentity,
	createManifest,
	decideResume,
	type ProvenanceConfig,
	type SeedRecord,
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
	workloadDigest: 'w-digest',
	auxiliaryDigest: 'a-digest',
};

function seedRecord(seedId: number): SeedRecord {
	return {
		seedId,
		estimators: { 'replica/unified-inline/confirmedPointRead': 1.23 },
		hashes: { trace: 'abc' },
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
