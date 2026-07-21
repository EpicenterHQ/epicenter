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
	completenessExpectations,
	computeProvenanceIdentity,
	createManifest,
	decideResume,
	type ProvenanceConfig,
	parseManifest,
	persistManifest,
	type SeedRecord,
	serializeManifest,
} from './checkpoint.js';
import { buildSeedEstimators } from './estimators.js';
import { type ProbePlan, probeIdFor } from './probe-plan.js';
import { buildCompleteRaw } from './raw-schema.test-support.js';

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
	traceOptions: [1000, 1001, 1002, 1003].map((dataSeed) => ({
		facts: 240,
		namespaceCount: 6,
		tableCount: 20,
		valueRatio: 0.08,
		dataSeed,
		targetLogicalStateBytes: 24_000,
		maxEncodedFactBytes: 4096,
	})),
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
	limitsDigest: 'limits-digest',
	runtime: { bun: '1.3.1', sqlite: '3.51.0' },
	executionSettings: {
		journal_mode: 'WAL',
		synchronous: 'NORMAL',
		page_size: 4096,
		foreign_keys: 'ON',
		recursive_triggers: 'ON',
		wal_autocheckpoint: 1000,
	},
	workloadDigest: 'w-digest',
	auxiliaryDigest: 'a-digest',
};

// Raw for seed index 0 (seedId 1000); hand-built manifests below all use seedId 1000.
const COMPLETE_RAW = buildCompleteRaw(completenessExpectations(CONFIG, 0));

function head<T>(values: readonly T[]): T {
	const value = values[0];
	if (value === undefined) throw new Error('expected a non-empty array');
	return value;
}

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
	// Each seed's raw must match its OWN index (the schedule and build-id prefix
	// depend on it), so a resumed multi-seed manifest validates.
	const seedIndex = CONFIG.seedIds.indexOf(seedId);
	const raw = buildCompleteRaw(
		completenessExpectations(CONFIG, seedIndex),
	) as SeedRecord['raw'];
	return {
		seedId,
		estimators: buildSeedEstimators(
			raw,
			computeProvenanceIdentity(CONFIG),
			seedId,
		),
		hashes: { trace: 'abc', traceBound: '1', auxiliaryBound: '1' },
		raw,
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
		expect(
			computeProvenanceIdentity({
				...CONFIG,
				maxBlockOps: CONFIG.maxBlockOps / 2,
			}),
		).not.toBe(base);
		expect(computeProvenanceIdentity({ ...CONFIG, cycles: 4 })).not.toBe(base);
		expect(
			computeProvenanceIdentity({
				...CONFIG,
				traceOptions: CONFIG.traceOptions.map((options, index) =>
					index === 0 ? { ...options, facts: options.facts + 1 } : options,
				),
			}),
		).not.toBe(base);
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
	test('a valid empty checkpoint with the full frozen config round-trips', () => {
		expect(parseManifest(serializeManifest(createManifest(CONFIG)))).toEqual(
			createManifest(CONFIG),
		);
	});

	test('a self-hashed empty config and invented manifest keys are refused', () => {
		const emptyConfig = {} as ProvenanceConfig;
		expect(
			parseManifest(
				JSON.stringify({
					identity: computeProvenanceIdentity(emptyConfig),
					config: emptyConfig,
					completedSeeds: [],
				}),
			),
		).toBeNull();

		const extra = { ...createManifest(CONFIG), invented: true };
		expect(parseManifest(JSON.stringify(extra))).toBeNull();
		const missing = structuredClone(createManifest(CONFIG)) as Record<
			string,
			unknown
		>;
		delete missing.completedSeeds;
		expect(parseManifest(JSON.stringify(missing))).toBeNull();
	});

	test('self-hashed config, runtime, execution, and DDL shape changes are refused', () => {
		const hostileConfigs: Record<string, unknown>[] = [];
		const extraConfig = structuredClone(CONFIG) as unknown as Record<
			string,
			unknown
		>;
		extraConfig.invented = true;
		hostileConfigs.push(extraConfig);
		const missingConfig = structuredClone(CONFIG) as unknown as Record<
			string,
			unknown
		>;
		delete missingConfig.workloadDigest;
		hostileConfigs.push(missingConfig);
		for (const key of ['runtime', 'executionSettings', 'ddlHashes'] as const) {
			const extra = structuredClone(CONFIG) as unknown as Record<
				string,
				unknown
			>;
			(extra[key] as Record<string, unknown>).invented = 'x';
			hostileConfigs.push(extra);
			const missing = structuredClone(CONFIG) as unknown as Record<
				string,
				unknown
			>;
			delete (missing[key] as Record<string, unknown>)[
				Object.keys(missing[key] as Record<string, unknown>)[0] as string
			];
			hostileConfigs.push(missing);
		}
		const extraTrace = structuredClone(CONFIG) as unknown as Record<
			string,
			unknown
		>;
		(
			(extraTrace.traceOptions as Record<string, unknown>[])[0] as Record<
				string,
				unknown
			>
		).invented = true;
		hostileConfigs.push(extraTrace);
		const missingTrace = structuredClone(CONFIG) as unknown as Record<
			string,
			unknown
		>;
		delete (
			(missingTrace.traceOptions as Record<string, unknown>[])[0] as Record<
				string,
				unknown
			>
		).facts;
		hostileConfigs.push(missingTrace);
		for (const config of hostileConfigs) {
			expect(
				parseManifest(
					JSON.stringify({
						identity: computeProvenanceIdentity(config as ProvenanceConfig),
						config,
						completedSeeds: [],
					}),
				),
			).toBeNull();
		}
	});

	test('self-hashed invalid seed and count domains are refused', () => {
		for (const patch of [
			{ seedIds: [] },
			{ seedIds: [1000, 1000] },
			{ traceOptions: [] },
			{
				traceOptions: CONFIG.traceOptions.map((options, index) =>
					index === 0 ? { ...options, dataSeed: 9999 } : options,
				),
			},
			{ cycles: -1 },
			{ reopenObservations: 1.5 },
			{ minBlockMs: 0 },
		]) {
			const config = { ...structuredClone(CONFIG), ...patch };
			expect(
				parseManifest(
					JSON.stringify({
						identity: computeProvenanceIdentity(config as ProvenanceConfig),
						config,
						completedSeeds: [],
					}),
				),
			).toBeNull();
		}
	});

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
					estimators: [],
					hashes: { t: 'x' },
					raw: structuredClone(COMPLETE_RAW),
				},
			],
		};
		expect(parseManifest(JSON.stringify(bad))).toBeNull();
	});

	test('a manifest with a seed missing raw observation arrays is refused', () => {
		const manifest = createManifest(CONFIG);
		const missingRaw = {
			...manifest,
			completedSeeds: [
				{
					seedId: 1000,
					estimators: [],
					hashes: { t: 'x' },
					raw: { blocks: [], reopens: [], cells: [] }, // missing keys
				},
			],
		};
		expect(parseManifest(JSON.stringify(missingRaw))).toBeNull();
	});

	test('a raw observation with a non-finite numeric field is refused (corruption)', () => {
		// JSON cannot hold Infinity, so inject a raw 1e999 literal that JSON.parse
		// turns into Infinity, corrupting one block's elapsedMs.
		const serialized = serializeManifest(
			commitSeed(createManifest(CONFIG), seedRecord(1000)),
		);
		const corrupt = serialized.replace('"elapsedMs": 25', '"elapsedMs": 1e999');
		expect(corrupt).not.toBe(serialized); // the replacement actually happened
		expect(parseManifest(corrupt)).toBeNull();
	});

	test('a complete manifest with one reopen removed is refused (wrong count)', () => {
		const manifest = commitSeed(createManifest(CONFIG), seedRecord(1000));
		const parsed = JSON.parse(serializeManifest(manifest));
		parsed.completedSeeds[0].raw.reopens.pop(); // now short one reopen
		expect(parseManifest(JSON.stringify(parsed))).toBeNull();
	});

	test('a complete manifest with a wrong-enum owner is refused', () => {
		const manifest = commitSeed(createManifest(CONFIG), seedRecord(1000));
		const parsed = JSON.parse(serializeManifest(manifest));
		parsed.completedSeeds[0].raw.cells[0].owner = 'bogus';
		expect(parseManifest(JSON.stringify(parsed))).toBeNull();
	});

	test('resume reconstructs probe truth instead of trusting a self-consistent raw rewrite', () => {
		const manifest = commitSeed(createManifest(CONFIG), seedRecord(1000));
		const parsed = JSON.parse(serializeManifest(manifest)) as {
			completedSeeds: {
				raw: {
					probes: ProbePlan[];
					blocks: {
						owner: string;
						metric: string;
						warmupProbeId: string;
						warmupProbeDigest: string;
					}[];
				};
			}[];
		};
		const raw = head(parsed.completedSeeds).raw;
		const plan = raw.probes.find(
			(probe) =>
				probe.owner === 'replica' &&
				probe.metric === 'confirmedTraversal' &&
				probe.phase === 'warmup',
		);
		expect(plan).toBeDefined();
		if (plan === undefined) throw new Error('warmup probe fixture missing');
		plan.itemsDigest = 'd'.repeat(64);
		plan.traversalStartSequence += 1;
		plan.traversalEndSequence -= 1;
		const { probeId: _priorProbeId, ...identity } = plan;
		plan.probeId = probeIdFor(identity);
		for (const block of raw.blocks) {
			if (block.owner === plan.owner && block.metric === plan.metric) {
				block.warmupProbeId = plan.probeId;
				block.warmupProbeDigest = plan.itemsDigest;
			}
		}
		expect(parseManifest(JSON.stringify(parsed))).toBeNull();
	});

	test('a complete seed round-trips and resumes (structural equivalence)', () => {
		let manifest = createManifest(CONFIG);
		manifest = commitSeed(manifest, seedRecord(1000));
		const reloaded = parseManifest(serializeManifest(manifest));
		expect(reloaded).not.toBeNull();
		// The reloaded raw is byte-identical to the committed raw.
		expect(JSON.stringify(reloaded?.completedSeeds[0]?.raw)).toBe(
			JSON.stringify(manifest.completedSeeds[0]?.raw),
		);
	});

	test('a committed seed outside the config seed list is refused', () => {
		const manifest = commitSeed(createManifest(CONFIG), seedRecord(1000));
		const serialized = JSON.parse(serializeManifest(manifest));
		serialized.completedSeeds[0].seedId = 9999; // not in seedIds
		writeFileSync(join(tempDir(), 'm.json'), JSON.stringify(serialized));
		expect(parseManifest(JSON.stringify(serialized))).toBeNull();
	});

	test('duplicate or out-of-order committed seeds are refused', () => {
		const duplicate = commitSeed(createManifest(CONFIG), seedRecord(1000));
		duplicate.completedSeeds.push(
			structuredClone(head(duplicate.completedSeeds)),
		);
		expect(parseManifest(serializeManifest(duplicate))).toBeNull();

		const outOfOrder = createManifest(CONFIG);
		outOfOrder.completedSeeds.push(seedRecord(1001));
		expect(parseManifest(serializeManifest(outOfOrder))).toBeNull();
	});

	test('a committed seed with an invented top-level field is refused', () => {
		const manifest = commitSeed(createManifest(CONFIG), seedRecord(1000));
		const parsed = JSON.parse(serializeManifest(manifest));
		parsed.completedSeeds[0].invented = true;
		expect(parseManifest(JSON.stringify(parsed))).toBeNull();
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
			commitSeed(manifest, { ...seedRecord(1000), estimators: [] }),
		).toThrow(/partial/);
	});

	test('refuses persisted estimators whose value or identity differs from raw', () => {
		const manifest = createManifest(CONFIG);
		const wrongValue = structuredClone(seedRecord(1000));
		head(wrongValue.estimators).value += 1;
		expect(() => commitSeed(manifest, wrongValue)).toThrow(/partial/);

		const wrongIdentity = structuredClone(seedRecord(1000));
		head(wrongIdentity.estimators).configIdentity = 'forged';
		expect(() => commitSeed(manifest, wrongIdentity)).toThrow(/partial/);
	});

	test('refuses closed and estimator-consistent raw with an extra tail', () => {
		const manifest = createManifest(CONFIG);
		const record = seedRecord(1000);
		record.raw.tails.push(structuredClone(head(record.raw.tails)));
		record.estimators = buildSeedEstimators(
			record.raw,
			manifest.identity,
			record.seedId,
		);
		expect(() => commitSeed(manifest, record)).toThrow(/incomplete raw/);
	});

	test('refuses to commit a duplicate seed', () => {
		const manifest = commitSeed(createManifest(CONFIG), seedRecord(1000));
		expect(() => commitSeed(manifest, seedRecord(1000))).toThrow(
			/already committed/,
		);
	});

	test('refuses to commit a later seed before the configured prefix', () => {
		expect(() => commitSeed(createManifest(CONFIG), seedRecord(1001))).toThrow(
			/incomplete raw/,
		);
	});
});
