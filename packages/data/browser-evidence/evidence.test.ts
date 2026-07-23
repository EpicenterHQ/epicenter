/**
 * Contract tests for closed, fail-closed pre-physical browser evidence.
 */
import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';

import {
	assertBrowserEngineEvidence,
	type BrowserEngineEvidence,
	BrowserEngineEvidenceSchema,
	classifyEvidence,
	evidenceInjectionFor,
} from './evidence.js';

function validEvidence(): BrowserEngineEvidence {
	return {
		schemaVersion: 'epicenter-browser-engine-evidence/v1',
		kind: 'epicenter-browser-engine-evidence',
		scope: 'pre-physical-browser-engine',
		decisionEligible: false,
		semanticWitnessScope: 'within-run-only',
		runId: 'evidence-test',
		startedAt: '2026-07-21T12:00:00.000Z',
		endedAt: '2026-07-21T12:00:01.000Z',
		durationMs: 1_000,
		source: {
			commit: 'a'.repeat(40),
			clean: true,
			dirtyPaths: [],
			lockfileSha256: 'b'.repeat(64),
			harnessSha256: 'c'.repeat(64),
		},
		runtime: {
			engine: 'chromium',
			playwrightVersion: '1.61.1',
			browserVersion: '140.0.0',
			userAgent: 'test browser',
			platform: 'darwin',
			architecture: 'arm64',
			headless: true,
			persistentProfile: true,
			origin: 'http://127.0.0.1:1234',
		},
		features: {
			secureContext: true,
			sharedWorker: true,
			opfs: true,
			webLocks: true,
			syncAccessHandle: true,
		},
		cells: [
			{
				id: 'feature-admission',
				injection: 'none',
				outcome: 'passed',
				startedAt: '2026-07-21T12:00:00.000Z',
				endedAt: '2026-07-21T12:00:01.000Z',
				durationMs: 1_000,
				parameters: [],
				proofs: { rowCount: 1, semanticSha256: 'd'.repeat(64) },
			},
		],
		limitations: [
			'Automated browser-engine evidence is not physical mobile evidence.',
		],
		overall: 'incomplete',
	};
}

test('browser evidence schema accepts only the pre-physical contract', () => {
	const evidence = validEvidence();
	expect(Value.Check(BrowserEngineEvidenceSchema, evidence)).toBe(true);
	expect(() => assertBrowserEngineEvidence(evidence)).not.toThrow();

	expect(
		Value.Check(BrowserEngineEvidenceSchema, {
			...evidence,
			scope: 'physical-mobile',
		}),
	).toBe(false);
	expect(
		Value.Check(BrowserEngineEvidenceSchema, {
			...evidence,
			decisionEligible: true,
		}),
	).toBe(false);
	expect(
		Value.Check(BrowserEngineEvidenceSchema, {
			...evidence,
			overall: 'ready-for-ADR-review',
		}),
	).toBe(false);
	expect(
		Value.Check(BrowserEngineEvidenceSchema, {
			...evidence,
			physicalSafariPassed: true,
		}),
	).toBe(false);
});

function completeEvidence(): BrowserEngineEvidence {
	const evidence = validEvidence();
	const base = evidence.cells[0];
	if (base === undefined) throw new Error('Expected fixture cell');
	const sha = 'd'.repeat(64);
	const continuedSha = 'f'.repeat(64);
	const cell = (
		id: BrowserEngineEvidence['cells'][number]['id'],
		parameters: BrowserEngineEvidence['cells'][number]['parameters'] = [],
		proofs: BrowserEngineEvidence['cells'][number]['proofs'] = {
			rowCount: 1,
			semanticSha256: sha,
		},
	): BrowserEngineEvidence['cells'][number] => ({
		...base,
		id,
		injection: evidenceInjectionFor(id),
		parameters,
		proofs,
	});
	return {
		...evidence,
		cells: [
			cell('feature-admission'),
			cell(
				'crud-durability-reload',
				[
					{ name: 'beforeSemanticSha256', value: sha },
					{ name: 'reopenedSemanticSha256', value: sha },
				],
				{ rowCount: 1, semanticSha256: sha, documentSha256: 'e'.repeat(64) },
			),
			cell(
				'concurrent-tabs-invalidation',
				[{ name: 'peerSemanticSha256', value: sha }],
				{
					rowCount: 1,
					semanticSha256: sha,
					invalidationCount: 12,
				},
			),
			cell('hung-sync-continuity', [
				{ name: 'exchangeStarted', value: true },
				{ name: 'exchangePending', value: true },
				{ name: 'sameTabRowId', value: 'a'.repeat(24) },
				{ name: 'peerRowId', value: 'b'.repeat(24) },
				{ name: 'sameTabRowOccurrences', value: 1 },
				{ name: 'peerRowOccurrences', value: 1 },
				{ name: 'claim', value: 'local-rpc-continuity-only' },
			]),
			cell('tab-close-continuity', [
				{ name: 'claim', value: 'surviving-tab-continuity-only' },
				{ name: 'cleanup', value: 'controlled-worker-close' },
			]),
			cell(
				'worker-termination-lock-handoff',
				[
					{ name: 'beforeRowCount', value: 1 },
					{ name: 'reopenedRowCount', value: 1 },
					{ name: 'beforeSemanticSha256', value: sha },
					{ name: 'reopenedSemanticSha256', value: sha },
				],
				{ rowCount: 2, semanticSha256: continuedSha },
			),
			cell(
				'persistent-profile-relaunch',
				[
					{ name: 'beforeRowCount', value: 1 },
					{ name: 'reopenedRowCount', value: 1 },
					{ name: 'beforeSemanticSha256', value: sha },
					{ name: 'reopenedSemanticSha256', value: sha },
				],
				{ rowCount: 2, semanticSha256: continuedSha },
			),
			cell('hidden-tab-continuity', [
				{ name: 'visibilityState', value: 'hidden' },
			]),
		],
		overall: 'provisional',
	};
}

test('browser evidence classifier fails closed', () => {
	const passed = validEvidence().cells[0];
	if (passed === undefined) throw new Error('Expected fixture cell');

	expect(classifyEvidence('chromium', [passed])).toBe('incomplete');
	expect(
		classifyEvidence('chromium', [{ ...passed, outcome: 'unsupported' }]),
	).toBe('incomplete');
	expect(classifyEvidence('chromium', [{ ...passed, outcome: 'failed' }])).toBe(
		'invalid',
	);
	expect(classifyEvidence('chromium', [passed, passed])).toBe('invalid');
	expect(
		Value.Check(BrowserEngineEvidenceSchema, {
			...validEvidence(),
			cells: [{ ...passed, mandatory: false }],
		}),
	).toBe(false);
});

test('browser evidence requires cell-specific witnesses before provisional', () => {
	const evidence = completeEvidence();
	expect(classifyEvidence('chromium', evidence.cells)).toBe('provisional');
	expect(() => assertBrowserEngineEvidence(evidence)).not.toThrow();

	for (const original of evidence.cells) {
		const cells = evidence.cells.map((cell) =>
			cell.id === original.id ? { ...cell, parameters: [], proofs: {} } : cell,
		);
		expect(classifyEvidence('chromium', cells)).toBe('invalid');
		expect(() =>
			assertBrowserEngineEvidence({ ...evidence, cells, overall: 'invalid' }),
		).toThrow(`passed cell '${original.id}'`);
	}
});

test('hung sync continuity requires two distinct writes witnessed exactly once', () => {
	const evidence = completeEvidence();
	const hung = evidence.cells.find(({ id }) => id === 'hung-sync-continuity');
	if (hung === undefined) throw new Error('Expected hung sync evidence cell');

	const cases = [
		{
			name: 'missing peer row ID',
			parameters: hung.parameters.filter(({ name }) => name !== 'peerRowId'),
		},
		{
			name: 'same row ID for both writes',
			parameters: hung.parameters.map((parameter) =>
				parameter.name === 'peerRowId'
					? { ...parameter, value: 'a'.repeat(24) }
					: parameter,
			),
		},
		{
			name: 'peer row ID is not an admitted row ID',
			parameters: hung.parameters.map((parameter) =>
				parameter.name === 'peerRowId'
					? { ...parameter, value: 'not-a-row-id' }
					: parameter,
			),
		},
		{
			name: 'peer row absent from snapshot',
			parameters: hung.parameters.map((parameter) =>
				parameter.name === 'peerRowOccurrences'
					? { ...parameter, value: 0 }
					: parameter,
			),
		},
		{
			name: 'peer row duplicated in snapshot',
			parameters: hung.parameters.map((parameter) =>
				parameter.name === 'peerRowOccurrences'
					? { ...parameter, value: 2 }
					: parameter,
			),
		},
		{
			name: 'exchange settled before snapshot',
			parameters: hung.parameters.map((parameter) =>
				parameter.name === 'exchangePending'
					? { ...parameter, value: false }
					: parameter,
			),
		},
	];

	for (const scenario of cases) {
		const cells = evidence.cells.map((cell) =>
			cell.id === hung.id ? { ...cell, parameters: scenario.parameters } : cell,
		);
		expect(classifyEvidence('chromium', cells), scenario.name).toBe('invalid');
		expect(() =>
			assertBrowserEngineEvidence({ ...evidence, cells, overall: 'invalid' }),
		).toThrow("passed cell 'hung-sync-continuity'");
	}
});

test('browser evidence rejects duplicate parameter names', () => {
	const evidence = completeEvidence();
	const cells = evidence.cells.map((cell) =>
		cell.id === 'hung-sync-continuity'
			? {
					...cell,
					parameters: [
						...cell.parameters,
						{ name: 'exchangePending', value: false },
					],
				}
			: cell,
	);

	expect(classifyEvidence('chromium', cells)).toBe('invalid');
	expect(() =>
		assertBrowserEngineEvidence({ ...evidence, cells, overall: 'invalid' }),
	).toThrow(
		"cell 'hung-sync-continuity' has duplicate parameters: exchangePending",
	);
});

test('browser evidence rejects feature and optional-cell overclaims', () => {
	const evidence = completeEvidence();
	expect(() =>
		assertBrowserEngineEvidence({
			...evidence,
			features: { ...evidence.features, opfs: false },
		}),
	).toThrow('passed feature admission requires every declared feature');
	const base = evidence.cells[0];
	if (base === undefined) throw new Error('Expected fixture cell');
	const optional = {
		...base,
		id: 'synthetic-page-freeze' as const,
		injection: 'cdp-freeze' as const,
	};
	expect(classifyEvidence('chromium', [...evidence.cells, optional])).toBe(
		'invalid',
	);
	expect(() =>
		assertBrowserEngineEvidence({
			...evidence,
			cells: [...evidence.cells, optional],
			overall: 'invalid',
		}),
	).toThrow('has no frozen v1 witness contract');
});

test('browser evidence assertion binds provenance and derived status', () => {
	const evidence = validEvidence();
	expect(() => assertBrowserEngineEvidence(evidence)).not.toThrow();
	expect(() =>
		assertBrowserEngineEvidence({ ...evidence, overall: 'provisional' }),
	).toThrow("overall must be 'incomplete'");
	expect(() =>
		assertBrowserEngineEvidence({
			...evidence,
			source: { ...evidence.source, clean: false },
		}),
	).toThrow('source.clean must agree');
	expect(() =>
		assertBrowserEngineEvidence({ ...evidence, durationMs: 999 }),
	).toThrow('run duration must equal');
});

test('browser evidence assertion rejects duplicate and overstated WebKit cells', () => {
	const evidence = validEvidence();
	const passed = evidence.cells[0];
	if (passed === undefined) throw new Error('Expected fixture cell');
	expect(() =>
		assertBrowserEngineEvidence({
			...evidence,
			cells: [passed, passed],
			overall: 'invalid',
		}),
	).toThrow("duplicate cell 'feature-admission'");
	expect(() =>
		assertBrowserEngineEvidence({
			...evidence,
			runtime: { ...evidence.runtime, engine: 'webkit' },
			cells: [
				...evidence.cells,
				{
					...passed,
					id: 'synthetic-page-freeze',
					injection: 'cdp-freeze',
				},
			],
		}),
	).toThrow("WebKit CDP cell 'synthetic-page-freeze' must be unsupported");
});
