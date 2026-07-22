/**
 * Guards the retained browser replica-layout artifact against incomplete or
 * overstated measurement matrices.
 */
import { describe, expect, test } from 'bun:test';

import {
	assertReplicaLayoutEvidence,
	REPLICA_LAYOUT_PROFILES,
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
	return {
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
			cleanScope: 'fingerprinted harness, package manifest, and lockfile',
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
				interpretation: ['test'],
			},
		],
		limitations: ['test'],
		overall: 'provisional',
	};
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
		expect(() => assertReplicaLayoutEvidence(value)).not.toThrow();
	});
});
