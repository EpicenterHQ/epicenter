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
 * The identity is computed with the portable streaming hash over canonical JSON,
 * so it is reproducible across runtimes. This module is pure: it owns the
 * manifest shape and the resume decision, not the filesystem. The runner reads
 * and writes the manifest file and calls here to decide.
 */

import {
	canonicalize,
	utf8ByteLength,
} from '../../../packages/data/src/protocol/v1/canonical.js';
import { Sha256Stream } from './portable-hash.js';

/**
 * Everything that must be identical for two runs to share a checkpoint. Any
 * change here changes the identity and refuses a cross-identity resume.
 */
export type ProvenanceConfig = {
	/** The workload source version, e.g. the git commit the run was launched from. */
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
	/** A canonical digest of the trace options and limits (workload identity). */
	workloadDigest: string;
	/** A canonical digest of the auxiliary-trace options. */
	auxiliaryDigest: string;
};

/** One committed seed's reduced evidence, the unit a resume may skip. */
export type SeedRecord = {
	seedId: number;
	/** The seed-level estimators, keyed `owner/candidate/metric` -> scalar. */
	estimators: Record<string, number>;
	/** Provenance hashes captured for this seed (trace, auxiliary, integrity). */
	hashes: Record<string, string>;
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
	if (Object.keys(record.estimators).length === 0) {
		throw new Error(
			`refusing to commit seed ${record.seedId} with no estimators; a partial timing block is not a resume point`,
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
