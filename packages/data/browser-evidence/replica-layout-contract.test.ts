/**
 * Guards the retained browser replica-layout artifact against incomplete or
 * overstated measurement matrices.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import {
	assertReplicaLayoutEvidence,
	deriveReplicaLayoutInterpretation,
	REPLICA_LAYOUT_CLEAN_SCOPE,
	REPLICA_LAYOUT_PROFILES,
	REPLICA_LAYOUT_PROVENANCE_LIMITATION,
	type ReplicaLayoutCandidateRun,
	type ReplicaLayoutEvidenceReport,
} from './replica-layout-contract.js';

function candidateRun(candidate: 'wide' | 'split'): ReplicaLayoutCandidateRun {
	const summary = (samples: number) => ({
		rawMs: Array.from({ length: samples }, () => 1),
		p50Ms: 1,
		p95Ms: 1,
		minimumMs: 1,
		maximumMs: 1,
	});
	const parameters = REPLICA_LAYOUT_PROFILES.smoke;
	return {
		candidate,
		repetition: 0,
		metrics: {
			pointRead: summary(parameters.pointBatches),
			traversal: summary(parameters.traversals),
			laneWrite: summary(parameters.laneBatches),
			feedInstall: summary(parameters.feedBatches),
			reopen: summary(parameters.reopenSamples),
		},
		storage: {
			pageSize: 4096,
			pageCount: 2,
			freelistCount: 0,
			liveBytes: 8192,
			fileBytes: 8192,
		},
		integrityCheck: 'ok',
		recordCount: parameters.records,
		observedProxyBytes: parameters.proxyBytes,
		queryPlans: {
			pointRead: ['primary key'],
			traversal: ['primary key'],
			laneWrite: ['primary key'],
			feedInstall: ['primary key'],
		},
	};
}

function report(): ReplicaLayoutEvidenceReport {
	const comparison = {
		wideMs: 1,
		splitMs: 1,
		differencePercent: 0,
		faster: 'wide' as const,
	};
	const value: ReplicaLayoutEvidenceReport = {
		schemaVersion: 'epicenter-browser-replica-layout-evidence/v1',
		kind: 'epicenter-browser-replica-layout-evidence',
		scope: 'pre-physical-browser-engine',
		decisionEligible: false,
		startedAt: '2026-07-22T00:00:00.000Z',
		finishedAt: '2026-07-22T00:00:01.000Z',
		durationMs: 1_000,
		charter: 'ADR-0177 wide-versus-split hot paths: browser OPFS slice',
		profile: 'smoke',
		source: {
			commit: 'abc',
			clean: true,
			cleanScope: REPLICA_LAYOUT_CLEAN_SCOPE,
			dirtyPaths: [],
			lockfileSha256: 'lock',
			harnessSha256: 'harness',
			files: [],
		},
		playwrightVersion: '1.0.0',
		engines: [
			{
				engine: 'chromium',
				browserVersion: '1',
				userAgent: 'test',
				platform: 'test',
				headless: true,
				persistentProfile: true,
				origin: 'http://127.0.0.1',
				result: {
					outcome: 'passed',
					startedAt: '2026-07-22T00:00:00.000Z',
					finishedAt: '2026-07-22T00:00:01.000Z',
					durationMs: 1_000,
					profile: 'smoke',
					parameters: REPLICA_LAYOUT_PROFILES.smoke,
					storageEstimate: { requiredAvailableBytes: 160 },
					runtime: {
						sqliteVersion: '3',
						opfsBackend: 'sqlite.org OPFS SAH Pool VFS',
						journalMode: 'delete',
						synchronous: 'extra',
					},
					proxy: {
						version: 1,
						encoding: 'UTF-8 bytes of RFC 8785 canonical {address,payload}',
						records: REPLICA_LAYOUT_PROFILES.smoke.records,
						targetBytes: REPLICA_LAYOUT_PROFILES.smoke.proxyBytes,
						emptyProxyBytes: 64,
						baseFillerBytes: 64,
						extraFillerRecords: 0,
					},
					schemas: {
						installedSchemaEncoding: 'test',
						wideDdlOwner: 'packages/data/src/store/replica/schema.ts',
						wideSchemaSha256: 'wide',
						splitSchemaSha256: 'split',
						splitDdlSha256: 'ddl',
					},
					runs: [candidateRun('wide'), candidateRun('split')],
					aggregate: {
						metrics: {
							pointRead: { p50: comparison, p95: comparison },
							traversal: { p50: comparison, p95: comparison },
							laneWrite: { p50: comparison, p95: comparison },
							feedInstall: { p50: comparison, p95: comparison },
							reopen: { p50: comparison, p95: comparison },
						},
						stopRule: 'all-hot-metrics-equivalent',
					},
				},
				interpretation: [],
			},
		],
		limitations: [REPLICA_LAYOUT_PROVENANCE_LIMITATION, 'test'],
		overall: 'provisional',
	};
	const engine = value.engines[0];
	if (engine === undefined) throw new Error('Fixture engine is missing');
	engine.interpretation = deriveReplicaLayoutInterpretation(
		value.profile,
		engine.result,
	);
	return value;
}

function refreshInterpretation(value: ReplicaLayoutEvidenceReport): void {
	const engine = value.engines[0];
	if (engine === undefined) throw new Error('Fixture engine is missing');
	engine.interpretation = deriveReplicaLayoutInterpretation(
		value.profile,
		engine.result,
	);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const retainedArtifacts = [
	'docs/benchmarks/replica-layout/2026-07-22-browser-wide-vs-split-smoke.json',
	'docs/benchmarks/replica-layout/2026-07-22-browser-wide-vs-split-full-chromium.json',
	'docs/benchmarks/replica-layout/2026-07-22-browser-wide-vs-split-full-webkit.json',
] as const;

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function committedBytes(commit: string, path: string): Uint8Array {
	const result = Bun.spawnSync(['git', 'show', `${commit}:${path}`], {
		cwd: repoRoot,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (!result.success) {
		throw new Error(
			`Cannot read retained source ${commit}:${path}: ${result.stderr.toString()}`,
		);
	}
	return new Uint8Array(result.stdout);
}

function recomputeHarnessSha256(
	files: ReplicaLayoutEvidenceReport['source']['files'],
): string {
	const hash = createHash('sha256');
	for (const file of files) {
		hash.update(file.path);
		hash.update('\0');
		hash.update(file.sha256);
		hash.update('\0');
	}
	return hash.digest('hex');
}

describe('browser replica layout evidence contract', () => {
	test('accepts a complete wide-versus-split matrix', () => {
		expect(() => assertReplicaLayoutEvidence(report())).not.toThrow();
	});

	test('rejects a missing candidate run', () => {
		const value = report();
		value.engines[0]?.result.runs.pop();
		expect(() => assertReplicaLayoutEvidence(value)).toThrow(
			'incomplete candidate matrix',
		);
	});

	test('retains a harness-side full-profile quota refusal as incomplete', () => {
		const value = report();
		const result = value.engines[0]?.result;
		if (result === undefined) throw new Error('Fixture engine is missing');
		result.outcome = 'not-admitted';
		result.reason = 'Storage estimate is below the charter admission bound';
		result.runs = [];
		result.schemas = undefined;
		result.aggregate = undefined;
		value.overall = 'incomplete';
		refreshInterpretation(value);
		expect(() => assertReplicaLayoutEvidence(value)).not.toThrow();
	});

	test('retains a browser-process failure as incomplete', () => {
		const value = report();
		const result = value.engines[0]?.result;
		if (result === undefined) throw new Error('Fixture engine is missing');
		result.outcome = 'failed';
		result.reason = 'webkit page crashed during benchmark';
		result.runs = [];
		result.schemas = undefined;
		result.aggregate = undefined;
		result.proxy = undefined;
		value.overall = 'incomplete';
		refreshInterpretation(value);
		expect(() => assertReplicaLayoutEvidence(value)).not.toThrow();
	});

	test('rejects aggregate findings that do not follow from raw samples', () => {
		const value = report();
		const aggregate = value.engines[0]?.result.aggregate;
		if (aggregate === undefined)
			throw new Error('Fixture aggregate is missing');
		aggregate.stopRule = 'material-direction-found';
		expect(() => assertReplicaLayoutEvidence(value)).toThrow(
			'invalid aggregate',
		);
	});

	test('retained reports reproduce findings and historical source hashes', async () => {
		for (const artifactPath of retainedArtifacts) {
			const artifact: unknown = await Bun.file(
				resolve(repoRoot, artifactPath),
			).json();
			expect(() => assertReplicaLayoutEvidence(artifact)).not.toThrow();
			if (typeof artifact !== 'object' || artifact === null) {
				throw new Error(`${artifactPath} is not an evidence report`);
			}
			const report = artifact as ReplicaLayoutEvidenceReport;
			expect(report.source.harnessSha256).toBe(
				recomputeHarnessSha256(report.source.files),
			);
			expect(report.source.lockfileSha256).toBe(
				sha256(committedBytes(report.source.commit, 'bun.lock')),
			);
			for (const file of report.source.files) {
				expect(file.sha256, `${artifactPath}: ${file.path}`).toBe(
					sha256(committedBytes(report.source.commit, file.path)),
				);
			}
		}
	});
});
