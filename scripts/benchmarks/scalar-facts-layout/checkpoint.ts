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
import { Sha256Stream } from './portable-hash.js';

/**
 * Everything that must be identical for two runs to share a checkpoint. Any
 * change here changes the identity and refuses a cross-identity resume. The
 * identity binds the exact source, the whole config, the per-candidate DDL
 * hashes, the validated limits, the runtime and SQLite versions, the execution
 * settings (pragmas), and the real workload and auxiliary digests.
 */
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
	/** Williams cycles per seed. */
	cycles: number;
	/** Minimum timed-block duration in milliseconds. */
	minBlockMs: number;
	/** Bootstrap draw count and seed. */
	bootstrapDraws: number;
	bootstrapSeed: number;
	/** Per-candidate DDL hash: the exact physical schema behind each candidate. */
	ddlHashes: Record<string, string>;
	/** A canonical digest of the validated V1 limits. */
	limitsDigest: string;
	/** The runtime and SQLite versions the evidence was produced under. */
	runtime: { bun: string; sqlite: string };
	/** The execution settings (pragmas) that shape physical behavior. */
	executionSettings: Record<string, string | number>;
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
export type SeedRaw = {
	blocks: unknown[];
	reopens: unknown[];
	tails: unknown[];
	macros: unknown[];
	cells: unknown[];
};

/** One committed seed's evidence, the unit a resume may skip. */
export type SeedRecord = {
	seedId: number;
	/** The seed-level estimators, keyed `owner/candidate/metric` -> scalar. */
	estimators: Record<string, number>;
	/** Provenance hashes captured for this seed (trace, auxiliary, integrity). */
	hashes: Record<string, string>;
	/** The complete raw per-seed observations, persisted so resume covers this seed. */
	raw: SeedRaw;
	/** True when this seed cleared every per-seed proof gate. */
	seedGatesPassed: boolean;
};

export type PilotManifest = {
	/** The provenance identity all seeds in this manifest share. */
	identity: string;
	config: ProvenanceConfig;
	/** Committed whole-seed records, in commit order. */
	completedSeeds: SeedRecord[];
};

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
	if (!isValidSeedRecord(record)) {
		throw new Error(
			`refusing to commit a malformed or partial seed record for seed ${seedLabel}; a resume point must be a complete whole seed`,
		);
	}
	if (manifest.completedSeeds.some((seed) => seed.seedId === record.seedId)) {
		throw new Error(`seed ${record.seedId} is already committed`);
	}
	return {
		...manifest,
		completedSeeds: [...manifest.completedSeeds, record],
	};
}

function isValidSeedRecord(record: unknown): record is SeedRecord {
	if (typeof record !== 'object' || record === null) return false;
	const r = record as Record<string, unknown>;
	if (!Number.isInteger(r.seedId)) return false;
	if (typeof r.seedGatesPassed !== 'boolean') return false;
	if (typeof r.estimators !== 'object' || r.estimators === null) return false;
	const estimators = r.estimators as Record<string, unknown>;
	const keys = Object.keys(estimators);
	if (keys.length === 0) return false; // a partial block has no estimators
	for (const key of keys) {
		const value = estimators[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) return false;
	}
	if (typeof r.hashes !== 'object' || r.hashes === null) return false;
	const hashes = r.hashes as Record<string, unknown>;
	if (Object.keys(hashes).length === 0) return false; // provenance is required
	for (const key of Object.keys(hashes)) {
		if (typeof hashes[key] !== 'string') return false;
	}
	if (typeof r.raw !== 'object' || r.raw === null) return false;
	const raw = r.raw as Record<string, unknown>;
	// Every raw observation array must be present, so a resumed seed carries the
	// same derived-gate inputs a fresh run would; a missing or non-array field is a
	// partial raw cell and is rejected.
	for (const field of ['blocks', 'reopens', 'tails', 'macros', 'cells']) {
		if (!Array.isArray(raw[field])) return false;
	}
	return true;
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
	if (typeof record.identity !== 'string') return null;
	if (typeof record.config !== 'object' || record.config === null) return null;
	if (!Array.isArray(record.completedSeeds)) return null;
	if (!record.completedSeeds.every(isValidSeedRecord)) return null;
	const config = record.config as ProvenanceConfig;
	// The embedded identity must equal the identity recomputed from the config, so
	// a hand-edited config cannot slip through under a stale identity.
	if (computeProvenanceIdentity(config) !== record.identity) return null;
	// Every committed seed must belong to the config's seed list.
	const seedIds = new Set(config.seedIds);
	for (const seed of record.completedSeeds as SeedRecord[]) {
		if (!seedIds.has(seed.seedId)) return null;
	}
	return {
		identity: record.identity,
		config,
		completedSeeds: record.completedSeeds as SeedRecord[],
	};
}
