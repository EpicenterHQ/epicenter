/**
 * Identity-closed seed estimator tests.
 *
 * These prove owner and metric families are reduced independently, every scalar
 * carries config and outer-seed identity, tail summaries are recomputed from raw
 * samples, and a persisted value or identity cannot diverge from retained raw.
 */

import { describe, expect, test } from 'bun:test';

import { CANDIDATE_IDS } from './candidates.js';
import {
	buildSeedEstimators,
	type EstimatorRaw,
	estimatorsMatchRaw,
} from './estimators.js';
import type { CompletenessExpectations } from './raw-schema.js';
import { buildCompleteRaw } from './raw-schema.test-support.js';
import { buildSeedSchedule } from './schedule.js';

const EXPECTATIONS: CompletenessExpectations = {
	owners: ['replica', 'authority'],
	candidates: [...CANDIDATE_IDS],
	reopenObservations: 2,
	tailTransactions: 4,
	minBlockMs: 20,
	maxBlockOps: 16,
	seedId: 1000,
	configIdentity: 'config-a',
	traceOptions: {
		facts: 240,
		namespaceCount: 6,
		tableCount: 20,
		valueRatio: 0.08,
		dataSeed: 1000,
		targetLogicalStateBytes: 24_000,
		maxEncodedFactBytes: 4096,
	},
	seedIndex: 0,
	schedule: buildSeedSchedule({
		seedId: 1000,
		candidates: [...CANDIDATE_IDS],
		cycles: 1,
		rotation: 0,
	}).blocks,
	letterMapping: buildSeedSchedule({
		seedId: 1000,
		candidates: [...CANDIDATE_IDS],
		cycles: 1,
		rotation: 0,
	}).letterMapping,
};

function head<T>(values: readonly T[]): T {
	const value = values[0];
	if (value === undefined) throw new Error('expected a non-empty array');
	return value;
}

function setup() {
	const raw = buildCompleteRaw(EXPECTATIONS) as unknown as EstimatorRaw;
	return { raw };
}

describe('owner and metric families stay independent', () => {
	test('each read metric and owner has its own candidate estimator', () => {
		const { raw } = setup();
		for (const block of raw.blocks) {
			if (
				block.owner === 'replica' &&
				block.candidate === 'unified-inline' &&
				block.metric === 'confirmedPointRead'
			) {
				block.elapsedMs = 10;
			}
		}
		const estimators = buildSeedEstimators(raw, 'config-a', 1000);
		const point = estimators.find(
			(estimator) =>
				estimator.owner === 'replica' &&
				estimator.candidate === 'unified-inline' &&
				estimator.metric === 'confirmedPointRead' &&
				estimator.statistic === 'medianElapsedMs',
		);
		const traversal = estimators.find(
			(estimator) =>
				estimator.owner === 'replica' &&
				estimator.candidate === 'unified-inline' &&
				estimator.metric === 'confirmedTraversal' &&
				estimator.statistic === 'medianElapsedMs',
		);
		expect(point?.value).toBe(10);
		expect(traversal?.value).toBe(25);
		expect(estimators.length).toBe(104);
		expect(
			estimators.every(
				(estimator) =>
					estimator.configIdentity === 'config-a' && estimator.seedId === 1000,
			),
		).toBe(true);
	});

	test('tail percentiles and throughput are recomputed from retained samples', () => {
		const { raw } = setup();
		const tail = raw.tails[0];
		expect(tail).toBeDefined();
		if (!tail) return;
		tail.samplesMs = [1, 2, 3, 4];
		const estimators = buildSeedEstimators(raw, 'config-a', 1000).filter(
			(estimator) =>
				estimator.owner === tail.owner &&
				estimator.candidate === tail.candidate &&
				estimator.metric === tail.metric,
		);
		expect(estimators.find((e) => e.statistic === 'p50Ms')?.value).toBe(2);
		expect(estimators.find((e) => e.statistic === 'p95Ms')?.value).toBe(4);
		expect(estimators.find((e) => e.statistic === 'p99Ms')?.value).toBe(4);
		expect(
			estimators.find((e) => e.statistic === 'throughputPerSec')?.value,
		).toBe(400);
	});
});

describe('persisted estimators are derived data, never trusted input', () => {
	test('a changed value, config identity, seed, or extra estimator is rejected', () => {
		const { raw } = setup();
		const estimators = buildSeedEstimators(raw, 'config-a', 1000);
		expect(estimatorsMatchRaw(estimators, raw, 'config-a', 1000)).toBe(true);

		const changedValue = structuredClone(estimators);
		head(changedValue).value += 1;
		expect(estimatorsMatchRaw(changedValue, raw, 'config-a', 1000)).toBe(false);

		const changedIdentity = structuredClone(estimators);
		head(changedIdentity).configIdentity = 'other';
		expect(estimatorsMatchRaw(changedIdentity, raw, 'config-a', 1000)).toBe(
			false,
		);

		const changedSeed = structuredClone(estimators);
		head(changedSeed).seedId = 1001;
		expect(estimatorsMatchRaw(changedSeed, raw, 'config-a', 1000)).toBe(false);

		expect(
			estimatorsMatchRaw([...estimators, estimators[0]], raw, 'config-a', 1000),
		).toBe(false);
	});
});
