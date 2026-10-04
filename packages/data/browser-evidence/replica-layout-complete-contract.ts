export type CompleteProfile = 'smoke' | 'full';
export type CompleteEngine = 'chromium' | 'webkit';
export type CompleteCandidate = 'wide' | 'split';

export const COMPLETE_METRICS = [
	'pointRead',
	'traversal',
	'traversalScalar',
	'laneWrite',
	'seal',
	'factInstall',
	'docAppend',
	'docDrainScan',
	'blobDrainScan',
	'tombstoneCleanup',
	'reopen',
] as const;

export type CompleteMetric = (typeof COMPLETE_METRICS)[number];
export type StatementKind = 'run' | 'all';

export type CompleteProfileParameters = {
	records: number;
	proxyBytes: number;
	documents: number;
	blobs: number;
	pendingIntents: number;
	parkedIntents: number;
	documentInflight: number;
	repetitions: number;
	pointBatches: number;
	traversals: number;
	laneBatches: number;
	sealBatches: number;
	factPages: number;
	docAppendBatches: number;
	drainScans: number;
	tombstonePages: number;
	reopenSamples: number;
	batchSize: number;
};

const MIB = 1024 * 1024;

export const COMPLETE_PROFILES: Record<
	CompleteProfile,
	CompleteProfileParameters
> = {
	smoke: {
		records: 5_000,
		proxyBytes: MIB,
		documents: 250,
		blobs: 200,
		pendingIntents: 100,
		parkedIntents: 5,
		documentInflight: 13,
		repetitions: 1,
		pointBatches: 4,
		traversals: 3,
		laneBatches: 2,
		sealBatches: 2,
		factPages: 2,
		docAppendBatches: 2,
		drainScans: 3,
		tombstonePages: 1,
		reopenSamples: 2,
		batchSize: 16,
	},
	full: {
		records: 1_000_000,
		proxyBytes: 536_870_912,
		documents: 50_000,
		blobs: 40_000,
		pendingIntents: 20_000,
		parkedIntents: 1_000,
		documentInflight: 2_500,
		repetitions: 2,
		pointBatches: 32,
		traversals: 12,
		laneBatches: 16,
		sealBatches: 8,
		factPages: 8,
		docAppendBatches: 16,
		drainScans: 8,
		tombstonePages: 4,
		reopenSamples: 4,
		batchSize: 64,
	},
};

export const COMPLETE_SEEDING_DISCLOSURES = [
	'Confirmed rows use direct INSERT batches. The candidate-specific INSERT statement differs only by installed schema; the 5,000-row transaction loop and exact V1 proxy generator are structurally identical.',
	'Blob membership uses direct candidate-specific INSERT/UPDATE statements in an identical index loop. Real blob capture requires the layout-independent file store.',
	'Parked scalar intents use direct candidate-specific INSERT/UPDATE statements in an identical address loop because no store API creates an already parked lane.',
] as const;

export const COMPLETE_FINGERPRINT_BOUNDARY =
	'Fingerprints cover the complete worker, client, and runner source files exactly as stored. Bundled transitive modules, dependency bytes, generated bundles, schemas outside the installed-schema digest, and bun.lock are not covered.' as const;

export type Summary = {
	raw: number[];
	p50: number;
	p95: number;
	minimum: number;
	maximum: number;
};

export type MetricResult = {
	timingMs: Summary;
	statements: Record<StatementKind, Summary>;
};

export type QueryPlan = { sql: string; detail: string[] };

export type CompleteCandidateRun = {
	candidate: CompleteCandidate;
	repetition: number;
	metrics: Record<CompleteMetric, MetricResult>;
	storage: {
		pageSize: number;
		pageCount: number;
		freelistCount: number;
		liveBytes: number;
		opfsFileBytes: number;
	};
	integrityCheck: string;
	relationCountsAfterReopen: Record<string, number>;
	queryPlans: Record<CompleteMetric, QueryPlan[]>;
};

export type CompleteEngineResult = {
	outcome: 'passed' | 'not-admitted' | 'failed';
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	profile: CompleteProfile;
	parameters: CompleteProfileParameters;
	storageEstimate: {
		usageBytes?: number;
		quotaBytes?: number;
		availableBytes?: number;
		requiredAvailableBytes: number;
	};
	runtime: {
		sqliteVersion?: string;
		opfsBackend: 'sqlite.org OPFS SAH Pool VFS';
		journalMode: 'delete';
		synchronous: 'extra';
	};
	proxy?: {
		version: 1;
		encoding: 'UTF-8 bytes of RFC 8785 canonical {address,payload}';
		records: number;
		targetBytes: number;
		emptyProxyBytes: number;
		baseFillerBytes: number;
		extraFillerRecords: number;
	};
	installedSchemaEncoding?: string;
	installedSchemaSha256?: Record<CompleteCandidate, string>;
	runs: CompleteCandidateRun[];
	aggregate?: {
		metrics: Record<
			CompleteMetric,
			Record<CompleteCandidate, Summary>
		>;
	};
	reason?: string;
};

export type CompleteWorkerRequest = {
	type: 'run';
	profile: CompleteProfile;
	runId: string;
};

export type CompleteWorkerMessage =
	| { type: 'progress'; message: string }
	| { type: 'result'; result: CompleteEngineResult }
	| { type: 'error'; name: string; message: string; stack?: string };

export type CompleteEvidenceDriver = {
	run(profile: CompleteProfile, runId: string): Promise<CompleteEngineResult>;
};

export type CompleteEvidenceReport = {
	schemaVersion: 1;
	charter: 'ADR-0177 COMPLETE wide-versus-split replica benchmark: browser OPFS';
	commit: string;
	engine: CompleteEngine;
	browserVersion: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	profile: CompleteProfile;
	parameters: CompleteProfileParameters;
	runtime: {
		bun: string;
		playwright: string;
		userAgent: string;
		platform: string;
		sqlite?: string;
	};
	source: {
		fingerprintBoundary: typeof COMPLETE_FINGERPRINT_BOUNDARY;
		files: {
			worker: { path: string; sha256: string };
			client: { path: string; sha256: string };
			runner: { path: string; sha256: string };
		};
	};
	fixture: {
		documents: number;
		documentsWithSecondUpdate: number;
		activeDocumentInflight: number;
		blobMemberships: number;
		pendingIntents: number;
		parkedIntents: number;
		disclosures: readonly string[];
	};
	measurement: {
		timing: string;
		statementCounts: string;
		rowsCounterLimitation: string;
		measuredSqlBoundary: string;
	};
	workloadDecisions: readonly string[];
	result: CompleteEngineResult;
};

export function summarize(raw: number[]): Summary {
	const sorted = [...raw].sort((left, right) => left - right);
	const percentile = (fraction: number): number =>
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
		0;
	return {
		raw,
		p50: percentile(0.5),
		p95: percentile(0.95),
		minimum: Math.min(...raw),
		maximum: Math.max(...raw),
	};
}

export function aggregateCompleteRuns(
	runs: CompleteCandidateRun[],
): NonNullable<CompleteEngineResult['aggregate']> {
	return {
		metrics: Object.fromEntries(
			COMPLETE_METRICS.map((metric) => [
				metric,
				Object.fromEntries(
					(['wide', 'split'] as const).map((candidate) => [
						candidate,
						summarize(
							runs
								.filter((run) => run.candidate === candidate)
								.flatMap((run) => run.metrics[metric].timingMs.raw),
						),
					]),
				),
			]),
		) as NonNullable<CompleteEngineResult['aggregate']>['metrics'],
	};
}
