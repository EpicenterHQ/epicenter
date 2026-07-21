/**
 * Per-seed checkpointing and source/config provenance identity.
 *
 * The pilot builds and retains eight full-envelope databases per seed, which is
 * expensive, so a run must be resumable. But resuming across a changed workload
 * source or configuration would silently mix two experiments. This module makes
 * that impossible: a run's identity is a hash over its source version and its
 * entire configuration, and a checkpoint may only be resumed when the current
 * identity equals the stored one. Resumption happens only at a committed WHOLE
 * seed boundary; a partial timing block is never a resume point.
 *
 * The identity is computed with the portable streaming hash over canonical JSON.
 * The manifest is persisted atomically (temp file plus rename) and reloaded with
 * schema validation, so a resume is genuinely cross-process and a truncated or
 * tampered manifest is refused rather than trusted.
 */

import { renameSync, writeFileSync } from 'node:fs';

import {
	canonicalize,
	utf8ByteLength,
} from '../../../packages/data/src/protocol/v1/canonical.js';
import { CANDIDATE_IDS } from './candidates.js';
import {
	type EstimatorRaw,
	estimatorsMatchRaw,
	type SeedEstimator,
} from './estimators.js';
import { Sha256Stream } from './portable-hash.js';
import {
	type CompletenessExpectations,
	RAW_OWNERS,
	validateSeedCompleteness,
	validateSeedRawClosed,
} from './raw-schema.js';
import { buildSeedSchedule } from './schedule.js';
import type { TraceOptions } from './trace.js';

/**
 * Everything that must be identical for two runs to share a checkpoint. Any
 * change here changes the identity and refuses a cross-identity resume. The
 * identity binds the exact source, the whole config, the per-candidate DDL
 * hashes, the validated limits, the runtime and SQLite versions, the execution
 * settings (pragmas), and the real workload and auxiliary digests.
 */
export type ExecutionSettings = {
	journal_mode: string;
	synchronous: string;
	page_size: number;
	foreign_keys: string;
	recursive_triggers: string;
	wal_autocheckpoint: number;
};

export type ProvenanceConfig = {
	/** The exact workload source version, e.g. the git commit; never a generic placeholder. */
	sourceVersion: string;
	/** The pilot profile name (smoke, pilot, ...). */
	profile: string;
	/** Whether this is a pilot (non-decision) or a final run. */
	isPilot: boolean;
	/** The ordered candidate ids. */
	candidates: string[];
	/** The ordered owners. */
	owners: string[];
	/** The seed ids that define the outer units, in order. */
	seedIds: number[];
	/** Exact deterministic trace inputs for each seed, in the same order. */
	traceOptions: TraceOptions[];
	/** Williams cycles per seed. */
	cycles: number;
	/** Reopen observations per seed and candidate. */
	reopenObservations: number;
	/** Minimum tail transactions per tail experiment. */
	tailTransactions: number;
	/** Maximum measured read blocks per seed/candidate/owner/metric. */
	maxReadBlocks: number;
	/** Minimum timed-block duration in milliseconds. */
	minBlockMs: number;
	/** Maximum calibrated operations in one timed read block. */
	maxBlockOps: number;
	/** Per-candidate DDL hash: the exact physical schema behind each candidate. */
	ddlHashes: Record<string, string>;
	/** A canonical digest of the validated V1 limits. */
	limitsDigest: string;
	/** The runtime and SQLite versions the evidence was produced under. */
	runtime: { bun: string; sqlite: string };
	/** The execution settings (pragmas) that shape physical behavior. */
	executionSettings: ExecutionSettings;
	/** A canonical digest of the trace options (workload identity). */
	workloadDigest: string;
	/** A canonical digest of the auxiliary-trace options and their bound hashes. */
	auxiliaryDigest: string;
};

/**
 * The full raw observation payload for one seed: the block, reopen, tail, and
 * cell arrays the pilot records. Persisting it means a resumed run's gates cover
 * committed AND fresh seeds identically to a clean run, not estimators alone.
 */
export type SeedRaw = EstimatorRaw & {
	letterMapping: Record<string, string>;
	lifecycle: {
		peakRetained: number;
		liveAtCommit: number;
		retainedThroughCommit: boolean;
	};
	probes: unknown[];
	calibrations: unknown[];
	boundaries: unknown[];
};

/** One committed seed's evidence, the unit a resume may skip. */
export type SeedRecord = {
	seedId: number;
	/** Identity-closed seed-level estimators, each recomputable from retained raw. */
	estimators: SeedEstimator[];
	/** Provenance hashes captured for this seed (trace, auxiliary, integrity). */
	hashes: Record<string, string>;
	/** The complete raw per-seed observations, persisted so resume covers this seed. */
	raw: SeedRaw;
};

export type PilotManifest = {
	/** The provenance identity all seeds in this manifest share. */
	identity: string;
	config: ProvenanceConfig;
	/** Committed whole-seed records, in commit order. */
	completedSeeds: SeedRecord[];
};

const PROVENANCE_KEYS = [
	'sourceVersion',
	'profile',
	'isPilot',
	'candidates',
	'owners',
	'seedIds',
	'traceOptions',
	'cycles',
	'reopenObservations',
	'tailTransactions',
	'maxReadBlocks',
	'minBlockMs',
	'maxBlockOps',
	'ddlHashes',
	'limitsDigest',
	'runtime',
	'executionSettings',
	'workloadDigest',
	'auxiliaryDigest',
] as const;
const EXECUTION_SETTING_KEYS = [
	'journal_mode',
	'synchronous',
	'page_size',
	'foreign_keys',
	'recursive_triggers',
	'wal_autocheckpoint',
] as const;
const TRACE_OPTION_KEYS = [
	'facts',
	'namespaceCount',
	'tableCount',
	'valueRatio',
	'dataSeed',
	'targetLogicalStateBytes',
	'maxEncodedFactBytes',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: unknown,
	expected: readonly string[],
): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	return (
		keys.length === expected.length &&
		expected.every((key) => Object.hasOwn(value, key))
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isNonEmptyString);
}

function exactArray(value: readonly string[], expected: readonly string[]) {
	return (
		value.length === expected.length &&
		value.every((entry, index) => entry === expected[index])
	);
}

function isValidExecutionSettings(value: unknown): value is ExecutionSettings {
	if (!hasExactKeys(value, EXECUTION_SETTING_KEYS)) return false;
	return (
		isNonEmptyString(value.journal_mode) &&
		isNonEmptyString(value.synchronous) &&
		isPositiveInteger(value.page_size) &&
		isNonEmptyString(value.foreign_keys) &&
		isNonEmptyString(value.recursive_triggers) &&
		isPositiveInteger(value.wal_autocheckpoint)
	);
}

function isValidTraceOptions(value: unknown): value is TraceOptions {
	if (!hasExactKeys(value, TRACE_OPTION_KEYS)) return false;
	return (
		isPositiveInteger(value.facts) &&
		isPositiveInteger(value.namespaceCount) &&
		isPositiveInteger(value.tableCount) &&
		typeof value.valueRatio === 'number' &&
		Number.isFinite(value.valueRatio) &&
		value.valueRatio > 0 &&
		value.valueRatio <= 1 &&
		typeof value.dataSeed === 'number' &&
		Number.isSafeInteger(value.dataSeed) &&
		value.dataSeed >= 0 &&
		isPositiveInteger(value.targetLogicalStateBytes) &&
		isPositiveInteger(value.maxEncodedFactBytes)
	);
}

function isValidProvenanceConfig(value: unknown): value is ProvenanceConfig {
	if (!hasExactKeys(value, PROVENANCE_KEYS)) return false;
	const ddlHashes = value.ddlHashes;
	const seedIds = value.seedIds;
	const traceOptions = value.traceOptions;
	if (
		!isNonEmptyString(value.sourceVersion) ||
		!isNonEmptyString(value.profile) ||
		typeof value.isPilot !== 'boolean' ||
		!isStringArray(value.candidates) ||
		!exactArray(value.candidates, CANDIDATE_IDS) ||
		!isStringArray(value.owners) ||
		!exactArray(value.owners, RAW_OWNERS) ||
		!Array.isArray(seedIds) ||
		seedIds.length === 0 ||
		!seedIds.every((seedId) => Number.isSafeInteger(seedId) && seedId >= 0) ||
		new Set(seedIds).size !== seedIds.length ||
		!Array.isArray(traceOptions) ||
		traceOptions.length !== seedIds.length ||
		!traceOptions.every(
			(options, index) =>
				isValidTraceOptions(options) && options.dataSeed === seedIds[index],
		) ||
		!isPositiveInteger(value.cycles) ||
		!isPositiveInteger(value.reopenObservations) ||
		!isPositiveInteger(value.tailTransactions) ||
		!isPositiveInteger(value.maxReadBlocks) ||
		typeof value.minBlockMs !== 'number' ||
		!Number.isFinite(value.minBlockMs) ||
		value.minBlockMs <= 0 ||
		!isPositiveInteger(value.maxBlockOps) ||
		!hasExactKeys(value.runtime, ['bun', 'sqlite']) ||
		!isNonEmptyString(value.runtime.bun) ||
		!isNonEmptyString(value.runtime.sqlite) ||
		!isValidExecutionSettings(value.executionSettings) ||
		!isNonEmptyString(value.limitsDigest) ||
		!isNonEmptyString(value.workloadDigest) ||
		!isNonEmptyString(value.auxiliaryDigest) ||
		!hasExactKeys(ddlHashes, value.candidates) ||
		!value.candidates.every((candidate) =>
			isNonEmptyString(ddlHashes[candidate]),
		)
	) {
		return false;
	}
	return true;
}

/**
 * A stable identity hash over the source version and the entire configuration.
 * Canonicalization sorts keys, so field order never changes the identity, and the
 * streaming hash keeps it reproducible in a browser.
 */
export function computeProvenanceIdentity(config: ProvenanceConfig): string {
	const record = canonicalize(config);
	return new Sha256Stream()
		.update(`${utf8ByteLength(record)}:${record}`)
		.digestHex();
}

export function createManifest(config: ProvenanceConfig): PilotManifest {
	return {
		identity: computeProvenanceIdentity(config),
		config,
		completedSeeds: [],
	};
}

export type ResumeDecision =
	| { canResume: true; remainingSeedIds: number[]; completedSeedIds: number[] }
	| { canResume: false; reason: string };

/**
 * Decide whether an existing manifest can resume under the current config. It can
 * only when the identities match exactly; otherwise resuming would mix a changed
 * source or config into one dataset, so it refuses. When it can, it reports which
 * seed ids remain, computed from the committed whole-seed records.
 */
export function decideResume(
	existing: PilotManifest,
	currentConfig: ProvenanceConfig,
): ResumeDecision {
	const currentIdentity = computeProvenanceIdentity(currentConfig);
	if (existing.identity !== currentIdentity) {
		return {
			canResume: false,
			reason:
				'checkpoint identity mismatch: the source version or configuration changed, so resuming would mix experiments',
		};
	}
	const completedSeedIds = existing.completedSeeds.map((seed) => seed.seedId);
	if (
		completedSeedIds.some(
			(seedId, index) => seedId !== currentConfig.seedIds[index],
		)
	) {
		return {
			canResume: false,
			reason:
				'checkpoint seeds are not the unique committed prefix of the configured seed list',
		};
	}
	const completed = new Set(completedSeedIds);
	// A committed seed that is no longer in the configured seed list also signals a
	// config drift the identity should have caught; guard it explicitly.
	for (const id of completedSeedIds) {
		if (!currentConfig.seedIds.includes(id)) {
			return {
				canResume: false,
				reason: `checkpoint contains committed seed ${id} that is not in the current seed list`,
			};
		}
	}
	const remainingSeedIds = currentConfig.seedIds.filter(
		(id) => !completed.has(id),
	);
	return { canResume: true, remainingSeedIds, completedSeedIds };
}

/**
 * Commit one whole seed to the manifest, returning a new manifest. Refuses to
 * commit a partial seed (missing estimators) or a duplicate seed id, so a resume
 * point is always a complete seed.
 */
export function commitSeed(
	manifest: PilotManifest,
	record: SeedRecord,
): PilotManifest {
	const seedLabel = String((record as { seedId?: unknown } | null)?.seedId);
	if (!isValidSeedRecord(record, manifest.identity)) {
		throw new Error(
			`refusing to commit a malformed or partial seed record for seed ${seedLabel}; a resume point must be a complete whole seed`,
		);
	}
	if (manifest.completedSeeds.some((seed) => seed.seedId === record.seedId)) {
		throw new Error(`seed ${record.seedId} is already committed`);
	}
	const seedIndex = manifest.config.seedIds.indexOf(record.seedId);
	if (
		seedIndex < 0 ||
		seedIndex !== manifest.completedSeeds.length ||
		!validateSeedCompleteness(
			record.raw,
			completenessExpectations(manifest.config, seedIndex),
		).complete
	) {
		throw new Error(
			`refusing to commit incomplete raw observations or an out-of-order seed ${seedLabel}`,
		);
	}
	return {
		...manifest,
		completedSeeds: [...manifest.completedSeeds, record],
	};
}

function isValidSeedRecord(
	record: unknown,
	configIdentity: string,
): record is SeedRecord {
	if (typeof record !== 'object' || record === null) return false;
	const r = record as Record<string, unknown>;
	if (!hasExactKeys(r, ['seedId', 'estimators', 'hashes', 'raw'])) return false;
	if (!Number.isInteger(r.seedId)) return false;
	if (!hasExactKeys(r.hashes, ['trace', 'traceBound', 'auxiliaryBound'])) {
		return false;
	}
	const hashes = r.hashes as Record<string, unknown>;
	for (const key of Object.keys(hashes)) {
		if (!isNonEmptyString(hashes[key])) return false;
	}
	// Every observation is validated against its CLOSED shape (exact keys, enums,
	// finite numbers, id shapes). Completeness (exact counts) is checked separately
	// with profile-derived expectations.
	if (!validateSeedRawClosed(r.raw).valid) return false;
	return estimatorsMatchRaw(
		r.estimators,
		r.raw as EstimatorRaw,
		configIdentity,
		r.seedId as number,
	);
}

/**
 * Per-seed completeness expectations. The exact expected schedule is derived from
 * the single schedule owner (`buildSeedSchedule`) using this seed's index as the
 * rotation, and truncated to the read-block cap, so completeness compares block
 * identities against the real schedule rather than a reconstructed guess. Build
 * identity is derived separately from config identity, seed id, owner, and candidate.
 */
export function completenessExpectations(
	config: ProvenanceConfig,
	seedIndex: number,
): CompletenessExpectations {
	const seedId = config.seedIds[seedIndex];
	if (seedId === undefined)
		throw new Error(`seed index ${seedIndex} is out of range`);
	const traceOptions = config.traceOptions[seedIndex];
	if (traceOptions === undefined) {
		throw new Error(`trace options for seed index ${seedIndex} are missing`);
	}
	const schedule = buildSeedSchedule({
		seedId,
		candidates: config.candidates,
		cycles: config.cycles,
		rotation: seedIndex,
	});
	const perMetricTotal = Math.min(config.maxReadBlocks, config.cycles * 16);
	return {
		owners: config.owners,
		candidates: config.candidates,
		reopenObservations: config.reopenObservations,
		tailTransactions: config.tailTransactions,
		minBlockMs: config.minBlockMs,
		maxBlockOps: config.maxBlockOps,
		seedId,
		configIdentity: computeProvenanceIdentity(config),
		traceOptions,
		seedIndex,
		schedule: schedule.blocks.slice(0, perMetricTotal),
		letterMapping: schedule.letterMapping,
	};
}

/**
 * Serialize a manifest to a stable JSON string. The identity is recomputed and
 * embedded so a reload can detect any tampering with the config.
 */
export function serializeManifest(manifest: PilotManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Persist a manifest atomically: write a temp file then rename over the target,
 * so a crash mid-write never leaves a truncated manifest a later run would trust.
 */
export function persistManifest(path: string, manifest: PilotManifest): void {
	const temp = `${path}.tmp`;
	writeFileSync(temp, serializeManifest(manifest));
	renameSync(temp, path);
}

/**
 * Parse and schema-validate a persisted manifest. Returns the manifest only when
 * its shape is valid, every committed seed record is complete, and the embedded
 * identity equals the identity recomputed from its own config. Any deviation
 * (truncation, tampering, a partial seed, an identity that does not match its
 * config) returns null so the caller fails closed instead of resuming bad state.
 */
export function parseManifest(serialized: string): PilotManifest | null {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	if (!hasExactKeys(record, ['identity', 'config', 'completedSeeds']))
		return null;
	if (typeof record.identity !== 'string') return null;
	if (!isValidProvenanceConfig(record.config)) return null;
	if (!Array.isArray(record.completedSeeds)) return null;
	const config = record.config;
	// The embedded identity must equal the identity recomputed from the config, so
	// a hand-edited config cannot slip through under a stale identity.
	if (computeProvenanceIdentity(config) !== record.identity) return null;
	if (
		!record.completedSeeds.every((seed) =>
			isValidSeedRecord(seed, record.identity as string),
		)
	) {
		return null;
	}
	const completedSeedIds = (record.completedSeeds as SeedRecord[]).map(
		(seed) => seed.seedId,
	);
	if (
		completedSeedIds.some((seedId, index) => seedId !== config.seedIds[index])
	) {
		return null;
	}
	// Every committed seed must belong to the config's seed list and be a COMPLETE
	// seed against its OWN per-seed expectations (the schedule depends on the seed's
	// index), so a resumed seed is structurally equivalent to a fresh one.
	for (const seed of record.completedSeeds as SeedRecord[]) {
		const seedIndex = config.seedIds.indexOf(seed.seedId);
		if (seedIndex < 0) return null;
		const expectations = completenessExpectations(config, seedIndex);
		if (!validateSeedCompleteness(seed.raw, expectations).complete) return null;
	}
	return {
		identity: record.identity,
		config,
		completedSeeds: record.completedSeeds as SeedRecord[],
	};
}
