/** Deterministic, layout-independent probe plans reconstructed from frozen trace options. */

import { canonicalize } from '../../../packages/data/src/protocol/v1/canonical.js';
import { makeAuxiliaryTraces } from './auxiliary-traces.js';
import { Sha256Stream } from './portable-hash.js';
import { type Address, makeTrace, type TraceOptions } from './trace.js';
import { pilotLimits } from './v1-binding.js';

export const PROBE_PHASES = ['calibration', 'warmup', 'timed'] as const;
export type ProbePhase = (typeof PROBE_PHASES)[number];

export const PROBE_RANGES: Record<
	ProbePhase,
	{
		rowOffset: number;
		rowCount: number;
		watermarkOffset: number;
		watermarkCount: number;
		retryOffset: number;
		retryCount: number;
		traversalOffset: number;
		traversalCount: number;
	}
> = {
	calibration: {
		rowOffset: 0,
		rowCount: 64,
		watermarkOffset: 0,
		watermarkCount: 64,
		retryOffset: 0,
		retryCount: 2,
		traversalOffset: 0,
		traversalCount: 16,
	},
	warmup: {
		rowOffset: 64,
		rowCount: 64,
		watermarkOffset: 64,
		watermarkCount: 64,
		retryOffset: 2,
		retryCount: 3,
		traversalOffset: 16,
		traversalCount: 16,
	},
	timed: {
		rowOffset: 128,
		rowCount: 64,
		watermarkOffset: 128,
		watermarkCount: 64,
		retryOffset: 5,
		retryCount: 3,
		traversalOffset: 32,
		traversalCount: 16,
	},
};

export type TraversalProbePage = {
	pageIndex: number;
	afterSequence: number;
	throughSequence: number;
	digest: string;
};

export type ProbeItems = {
	rows: Address[];
	replicaIds: string[];
	watermarks: number[];
	traversalPages: TraversalProbePage[];
};

export type ProbePlanIdentity = {
	configIdentity: string;
	seedId: number;
	owner: string;
	metric: string;
	phase: ProbePhase;
	sourceDigest: string;
	itemsDigest: string;
	rowOffset: number;
	rowCount: number;
	watermarkOffset: number;
	watermarkCount: number;
	retryOffset: number;
	retryCount: number;
	traversalOffset: number;
	traversalCount: number;
	traversalStartSequence: number;
	traversalEndSequence: number;
	traversalPages: TraversalProbePage[];
};

export type ProbePlan = ProbePlanIdentity & { probeId: string };

export type ProbeSource = {
	sourceDigest: string;
	items: ProbeItems;
};

function digest(value: unknown): string {
	return new Sha256Stream().update(canonicalize(value)).digestHex();
}

/** Build the one deterministic probe source for a seed, independent of any layout. */
export function buildProbeSource(traceOptions: TraceOptions): ProbeSource {
	const trace = makeTrace(traceOptions);
	const rows = trace.sampleRowAddresses(192);
	const replicaIds = makeAuxiliaryTraces(
		trace,
		pilotLimits(),
	).retry.entries.map((entry) => entry.replicaId);
	const facts = Array.from({ length: traceOptions.facts }, (_, index) =>
		trace.finalFactAt(index),
	).sort((a, b) => a.sequence - b.sequence);
	const sequences = [...new Set(facts.map((fact) => fact.sequence))];
	if (sequences.length !== facts.length) {
		throw new Error('trace current sequences are not unique');
	}
	if (sequences.length < 48) {
		throw new Error('trace does not contain 48 non-empty traversal pages');
	}
	const maxSequence = sequences.at(-1);
	if (maxSequence === undefined)
		throw new Error('trace has no current sequence');
	const watermarks = Array.from({ length: 192 }, (_, index) =>
		Math.floor((maxSequence * index) / 192),
	);
	const traversalPages = Array.from({ length: 48 }, (_, pageIndex) => {
		const startIndex = Math.floor((pageIndex * sequences.length) / 48);
		const endIndex = Math.floor(((pageIndex + 1) * sequences.length) / 48) - 1;
		const throughSequence = sequences[endIndex];
		if (throughSequence === undefined) {
			throw new Error(`traversal page ${pageIndex} has no terminal sequence`);
		}
		const afterSequence =
			startIndex === 0 ? 0 : (sequences[startIndex - 1] as number);
		return {
			pageIndex,
			afterSequence,
			throughSequence,
			digest: digest(facts.slice(startIndex, endIndex + 1)),
		};
	});
	const items = { rows, replicaIds, watermarks, traversalPages };
	return {
		sourceDigest: digest({ traceOptions, items }),
		items,
	};
}

export function probeIdFor(identity: ProbePlanIdentity): string {
	return digest(identity);
}

/** Build one exact retained plan plus the phase items the runner must execute. */
export function buildProbePlan(
	source: ProbeSource,
	input: {
		configIdentity: string;
		seedId: number;
		owner: string;
		metric: string;
		phase: ProbePhase;
	},
): { plan: ProbePlan; items: ProbeItems } {
	const range = PROBE_RANGES[input.phase];
	const items: ProbeItems = {
		rows: source.items.rows.slice(
			range.rowOffset,
			range.rowOffset + range.rowCount,
		),
		replicaIds: source.items.replicaIds.slice(
			range.retryOffset,
			range.retryOffset + range.retryCount,
		),
		watermarks: source.items.watermarks.slice(
			range.watermarkOffset,
			range.watermarkOffset + range.watermarkCount,
		),
		traversalPages: source.items.traversalPages.slice(
			range.traversalOffset,
			range.traversalOffset + range.traversalCount,
		),
	};
	const firstPage = items.traversalPages[0];
	const lastPage = items.traversalPages.at(-1);
	if (firstPage === undefined || lastPage === undefined) {
		throw new Error(`probe phase ${input.phase} has no traversal pages`);
	}
	const identity: ProbePlanIdentity = {
		...input,
		sourceDigest: source.sourceDigest,
		itemsDigest: digest(items),
		...range,
		traversalStartSequence: firstPage.afterSequence,
		traversalEndSequence: lastPage.throughSequence,
		traversalPages: items.traversalPages,
	};
	return { plan: { ...identity, probeId: probeIdFor(identity) }, items };
}
