export type ReplicaLayoutProfile = 'smoke' | 'full';

export type ReplicaLayoutEngine = 'chromium' | 'webkit';

export type ReplicaLayoutCandidate = 'wide' | 'split';

export type ReplicaLayoutMetric =
	| 'pointRead'
	| 'traversal'
	| 'laneWrite'
	| 'feedInstall'
	| 'reopen';

export const REPLICA_LAYOUT_METRICS = [
	'pointRead',
	'traversal',
	'laneWrite',
	'feedInstall',
	'reopen',
] as const satisfies readonly ReplicaLayoutMetric[];

export const REPLICA_LAYOUT_CLEAN_SCOPE =
	'listed harness files, package manifest, and lockfile; bundled transitive modules excluded' as const;

export const REPLICA_LAYOUT_PROVENANCE_LIMITATION =
	'The source fingerprint covers only source.files plus bun.lock. It does not cover bundled transitive modules such as the production schema, canonical encoder, SQLite adapter, or installed dependency bytes.' as const;

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
		cleanScope: typeof REPLICA_LAYOUT_CLEAN_SCOPE;
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

function percentile(values: readonly number[], fraction: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
		0
	);
}

export function summarizeReplicaLayoutSamples(
	rawMs: number[],
): ReplicaLayoutSummary {
	return {
		rawMs,
		p50Ms: percentile(rawMs, 0.5),
		p95Ms: percentile(rawMs, 0.95),
		minimumMs: Math.min(...rawMs),
		maximumMs: Math.max(...rawMs),
	};
}

function comparison(wideMs: number, splitMs: number): ReplicaLayoutComparison {
	const minimum = Math.min(wideMs, splitMs);
	return {
		wideMs,
		splitMs,
		differencePercent:
			minimum === 0
				? wideMs === splitMs
					? 0
					: null
				: (Math.abs(wideMs - splitMs) / minimum) * 100,
		faster: wideMs <= splitMs ? 'wide' : 'split',
	};
}

function comparisonsEqual(
	left: ReplicaLayoutComparison,
	right: ReplicaLayoutComparison,
): boolean {
	return (
		left.wideMs === right.wideMs &&
		left.splitMs === right.splitMs &&
		left.differencePercent === right.differencePercent &&
		left.faster === right.faster
	);
}

export function deriveReplicaLayoutAggregate(
	runs: ReplicaLayoutCandidateRun[],
): ReplicaLayoutAggregate {
	const metrics = {} as ReplicaLayoutAggregate['metrics'];
	for (const metric of REPLICA_LAYOUT_METRICS) {
		const wide = runs.filter(({ candidate }) => candidate === 'wide');
		const split = runs.filter(({ candidate }) => candidate === 'split');
		metrics[metric] = {
			p50: comparison(
				percentile(
					wide.map((run) => run.metrics[metric].p50Ms),
					0.5,
				),
				percentile(
					split.map((run) => run.metrics[metric].p50Ms),
					0.5,
				),
			),
			p95: comparison(
				percentile(
					wide.map((run) => run.metrics[metric].p95Ms),
					0.5,
				),
				percentile(
					split.map((run) => run.metrics[metric].p95Ms),
					0.5,
				),
			),
		};
	}
	const differences = Object.values(metrics).flatMap(({ p50, p95 }) =>
		[p50.differencePercent, p95.differencePercent].filter(
			(difference): difference is number => difference !== null,
		),
	);
	const hasUnquantifiableDifference = Object.values(metrics).some(
		({ p50, p95 }) =>
			p50.differencePercent === null || p95.differencePercent === null,
	);
	return {
		metrics,
		stopRule: differences.some((difference) => difference > 20)
			? 'material-direction-found'
			: !hasUnquantifiableDifference &&
					differences.every((difference) => difference < 10)
				? 'all-hot-metrics-equivalent'
				: 'continue-measurement',
	};
}

export function deriveReplicaLayoutInterpretation(
	profile: ReplicaLayoutProfile,
	result: ReplicaLayoutEngineResult,
): string[] {
	if (result.outcome !== 'passed') {
		return [
			`The ${profile} charter ${result.outcome}: ${result.reason ?? 'unknown reason'}.`,
		];
	}
	const statements = [
		profile === 'smoke'
			? 'Smoke validates the measurement method only; it is not decision eligible.'
			: 'The full charter measures 1,000,000 records and 536,870,912 canonical proxy bytes, but remains pre-physical browser-engine evidence.',
		`ADR-0177 stop rule: ${result.aggregate?.stopRule ?? 'missing'}.`,
	];
	for (const metric of REPLICA_LAYOUT_METRICS) {
		const aggregate = result.aggregate?.metrics[metric];
		if (aggregate === undefined) continue;
		const difference = (value: number | null): string =>
			value === null
				? 'not quantifiable at timer resolution'
				: `${value.toFixed(2)}%`;
		statements.push(
			`${metric}: ${aggregate.p50.faster} p50 difference is ${difference(aggregate.p50.differencePercent)}; ${aggregate.p95.faster} p95 difference is ${difference(aggregate.p95.differencePercent)}.`,
		);
	}
	return statements;
}

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
	if (report.source?.cleanScope !== REPLICA_LAYOUT_CLEAN_SCOPE) {
		throw new Error('Replica layout source cleanliness scope is invalid');
	}
	if (!report.limitations?.includes(REPLICA_LAYOUT_PROVENANCE_LIMITATION)) {
		throw new Error('Replica layout source limitation is missing');
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
			const aggregate = result.aggregate;
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
				for (const metric of REPLICA_LAYOUT_METRICS) {
					const summary = run.metrics[metric];
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
					const expectedSummary = summarizeReplicaLayoutSamples(summary.rawMs);
					if (
						summary.p50Ms !== expectedSummary.p50Ms ||
						summary.p95Ms !== expectedSummary.p95Ms ||
						summary.minimumMs !== expectedSummary.minimumMs ||
						summary.maximumMs !== expectedSummary.maximumMs
					) {
						throw new Error(
							`Engine '${entry.engine}' retained an invalid timing summary`,
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
			const expectedAggregate = deriveReplicaLayoutAggregate(result.runs);
			const aggregateMatches = REPLICA_LAYOUT_METRICS.every((metric) =>
				(['p50', 'p95'] as const).every((percentile) =>
					comparisonsEqual(
						aggregate.metrics[metric][percentile],
						expectedAggregate.metrics[metric][percentile],
					),
				),
			);
			if (
				!aggregateMatches ||
				aggregate.stopRule !== expectedAggregate.stopRule
			) {
				throw new Error(
					`Engine '${entry.engine}' retained an invalid aggregate`,
				);
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
		const expectedInterpretation = deriveReplicaLayoutInterpretation(
			report.profile ?? 'smoke',
			result,
		);
		if (
			entry.interpretation.length !== expectedInterpretation.length ||
			entry.interpretation.some(
				(statement, index) => statement !== expectedInterpretation[index],
			)
		) {
			throw new Error(
				`Engine '${entry.engine}' retained an invalid interpretation`,
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
