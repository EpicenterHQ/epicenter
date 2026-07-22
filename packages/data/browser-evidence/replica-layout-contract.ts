export type ReplicaLayoutProfile = 'smoke' | 'full';

export type ReplicaLayoutEngine = 'chromium' | 'webkit';

export type ReplicaLayoutCandidate = 'wide' | 'split';

export type ReplicaLayoutMetric =
	| 'pointRead'
	| 'traversal'
	| 'laneWrite'
	| 'feedInstall'
	| 'reopen';

export type ReplicaLayoutProfileParameters = {
	records: number;
	proxyBytes: number;
	repetitions: number;
	pointBatches: number;
	traversals: number;
	laneBatches: number;
	feedBatches: number;
	reopenSamples: number;
	batchSize: number;
};

const MIB = 1024 * 1024;

export const REPLICA_LAYOUT_PROFILES: Record<
	ReplicaLayoutProfile,
	ReplicaLayoutProfileParameters
> = {
	smoke: {
		records: 5_000,
		proxyBytes: MIB,
		repetitions: 1,
		pointBatches: 8,
		traversals: 3,
		laneBatches: 4,
		feedBatches: 4,
		reopenSamples: 3,
		batchSize: 64,
	},
	full: {
		records: 1_000_000,
		proxyBytes: 512 * MIB,
		repetitions: 3,
		pointBatches: 64,
		traversals: 16,
		laneBatches: 64,
		feedBatches: 32,
		reopenSamples: 8,
		batchSize: 64,
	},
};

export type ReplicaLayoutSummary = {
	rawMs: number[];
	p50Ms: number;
	p95Ms: number;
	minimumMs: number;
	maximumMs: number;
};

export type ReplicaLayoutCandidateRun = {
	candidate: ReplicaLayoutCandidate;
	repetition: number;
	metrics: Record<ReplicaLayoutMetric, ReplicaLayoutSummary>;
	storage: {
		pageSize: number;
		pageCount: number;
		freelistCount: number;
		liveBytes: number;
		fileBytes: number;
	};
	integrityCheck: 'ok';
	recordCount: number;
	observedProxyBytes: number;
	queryPlans: Record<Exclude<ReplicaLayoutMetric, 'reopen'>, string[]>;
};

export type ReplicaLayoutComparison = {
	wideMs: number;
	splitMs: number;
	differencePercent: number | null;
	faster: ReplicaLayoutCandidate;
};

export type ReplicaLayoutAggregate = {
	metrics: Record<
		ReplicaLayoutMetric,
		{
			p50: ReplicaLayoutComparison;
			p95: ReplicaLayoutComparison;
		}
	>;
	stopRule:
		| 'material-direction-found'
		| 'all-hot-metrics-equivalent'
		| 'continue-measurement';
};

export type ReplicaLayoutEngineResult = {
	outcome: 'passed' | 'not-admitted' | 'failed';
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	profile: ReplicaLayoutProfile;
	parameters: ReplicaLayoutProfileParameters;
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
	schemas?: {
		installedSchemaEncoding: string;
		wideDdlOwner: 'packages/data/src/store/replica/schema.ts';
		wideSchemaSha256: string;
		splitSchemaSha256: string;
		splitDdlSha256: string;
	};
	runs: ReplicaLayoutCandidateRun[];
	aggregate?: ReplicaLayoutAggregate;
	reason?: string;
};

export type ReplicaLayoutWorkerRequest = {
	type: 'run';
	profile: ReplicaLayoutProfile;
	runId: string;
};

export type ReplicaLayoutWorkerMessage =
	| {
			type: 'progress';
			message: string;
	  }
	| {
			type: 'result';
			result: ReplicaLayoutEngineResult;
	  }
	| {
			type: 'error';
			name: string;
			message: string;
			stack?: string;
	  };

export type ReplicaLayoutEvidenceDriver = {
	run(
		profile: ReplicaLayoutProfile,
		runId: string,
	): Promise<ReplicaLayoutEngineResult>;
};

export type ReplicaLayoutEvidenceReport = {
	schemaVersion: 'epicenter-browser-replica-layout-evidence/v1';
	kind: 'epicenter-browser-replica-layout-evidence';
	scope: 'pre-physical-browser-engine';
	decisionEligible: false;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	charter: 'ADR-0177 wide-versus-split hot paths: browser OPFS slice';
	profile: ReplicaLayoutProfile;
	source: {
		commit: string;
		clean: boolean;
		cleanScope: 'fingerprinted harness, package manifest, and lockfile';
		dirtyPaths: string[];
		lockfileSha256: string;
		harnessSha256: string;
		files: { path: string; sha256: string }[];
	};
	playwrightVersion: string;
	engines: Array<{
		engine: ReplicaLayoutEngine;
		browserVersion: string;
		userAgent: string;
		platform: string;
		headless: true;
		persistentProfile: true;
		origin: string;
		result: ReplicaLayoutEngineResult;
		interpretation: string[];
	}>;
	limitations: string[];
	overall: 'provisional' | 'incomplete' | 'invalid';
};

export function assertReplicaLayoutEvidence(
	value: unknown,
): asserts value is ReplicaLayoutEvidenceReport {
	if (typeof value !== 'object' || value === null) {
		throw new Error('Replica layout evidence must be an object');
	}
	const report = value as Partial<ReplicaLayoutEvidenceReport>;
	if (
		report.schemaVersion !== 'epicenter-browser-replica-layout-evidence/v1' ||
		report.kind !== 'epicenter-browser-replica-layout-evidence' ||
		report.scope !== 'pre-physical-browser-engine' ||
		report.decisionEligible !== false
	) {
		throw new Error('Replica layout evidence identity is invalid');
	}
	if (report.source?.clean !== (report.source?.dirtyPaths.length === 0)) {
		throw new Error('Replica layout source cleanliness is inconsistent');
	}
	if (
		report.source?.cleanScope !==
		'fingerprinted harness, package manifest, and lockfile'
	) {
		throw new Error('Replica layout source cleanliness scope is invalid');
	}
	if (!Array.isArray(report.engines) || report.engines.length === 0) {
		throw new Error('Replica layout evidence has no engine results');
	}
	const seen = new Set<ReplicaLayoutEngine>();
	for (const entry of report.engines) {
		if (seen.has(entry.engine)) {
			throw new Error(`Duplicate replica layout engine '${entry.engine}'`);
		}
		seen.add(entry.engine);
		const result = entry.result;
		if (result.profile !== report.profile) {
			throw new Error(
				`Engine '${entry.engine}' profile does not match the report`,
			);
		}
		const expectedParameters =
			REPLICA_LAYOUT_PROFILES[report.profile ?? 'smoke'];
		if (
			JSON.stringify(result.parameters) !== JSON.stringify(expectedParameters)
		) {
			throw new Error(
				`Engine '${entry.engine}' parameters are not the frozen profile`,
			);
		}
		if (result.outcome === 'passed') {
			if (result.proxy === undefined) {
				throw new Error(`Engine '${entry.engine}' lacks proxy evidence`);
			}
			if (
				result.proxy.records !== result.parameters.records ||
				result.proxy.targetBytes !== result.parameters.proxyBytes
			) {
				throw new Error(
					`Engine '${entry.engine}' proxy does not match its profile`,
				);
			}
			if (result.runs.length !== result.parameters.repetitions * 2) {
				throw new Error(
					`Engine '${entry.engine}' has an incomplete candidate matrix`,
				);
			}
			if (result.schemas === undefined || result.aggregate === undefined) {
				throw new Error(
					`Engine '${entry.engine}' lacks schema or aggregate evidence`,
				);
			}
			const candidateRepetitions = new Set<string>();
			for (const run of result.runs) {
				candidateRepetitions.add(`${run.candidate}:${run.repetition}`);
				if (
					run.recordCount !== result.parameters.records ||
					run.observedProxyBytes !== result.parameters.proxyBytes ||
					run.integrityCheck !== 'ok'
				) {
					throw new Error(`Engine '${entry.engine}' retained an invalid run`);
				}
				for (const [metric, summary] of Object.entries(run.metrics) as Array<
					[ReplicaLayoutMetric, ReplicaLayoutSummary]
				>) {
					const expectedSamples =
						metric === 'pointRead'
							? result.parameters.pointBatches
							: metric === 'traversal'
								? result.parameters.traversals
								: metric === 'laneWrite'
									? result.parameters.laneBatches
									: metric === 'feedInstall'
										? result.parameters.feedBatches
										: result.parameters.reopenSamples;
					if (
						summary.rawMs.length !== expectedSamples ||
						summary.rawMs.some(
							(sample) => !Number.isFinite(sample) || sample < 0,
						)
					) {
						throw new Error(
							`Engine '${entry.engine}' retained invalid raw timing`,
						);
					}
				}
			}
			for (const candidate of ['wide', 'split'] as const) {
				for (
					let repetition = 0;
					repetition < result.parameters.repetitions;
					repetition += 1
				) {
					if (!candidateRepetitions.has(`${candidate}:${repetition}`)) {
						throw new Error(
							`Engine '${entry.engine}' has an incomplete candidate matrix`,
						);
					}
				}
			}
		} else if (
			result.reason === undefined ||
			result.runs.length !== 0 ||
			result.schemas !== undefined ||
			result.aggregate !== undefined
		) {
			throw new Error(
				`Engine '${entry.engine}' has invalid incomplete evidence`,
			);
		}
	}
	const expectedOverall = report.engines.every(
		({ result }) => result.outcome === 'passed',
	)
		? 'provisional'
		: 'incomplete';
	if (report.overall !== expectedOverall) {
		throw new Error(`Replica layout overall must be '${expectedOverall}'`);
	}
}
