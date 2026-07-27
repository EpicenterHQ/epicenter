import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';

const CLOSED = { additionalProperties: false } as const;

const EvidenceEngineSchema = Type.Union([
	Type.Literal('chromium'),
	Type.Literal('webkit'),
]);

const EvidenceCellIdSchema = Type.Union([
	Type.Literal('feature-admission'),
	Type.Literal('crud-durability-reload'),
	Type.Literal('second-owner-refusal'),
	Type.Literal('hung-sync-continuity'),
	Type.Literal('worker-termination-lock-handoff'),
	Type.Literal('persistent-profile-relaunch'),
	Type.Literal('synthetic-page-freeze'),
	Type.Literal('synthetic-quota-refusal'),
]);

const mandatoryCellIds = [
	'feature-admission',
	'crud-durability-reload',
	'second-owner-refusal',
	'hung-sync-continuity',
	'worker-termination-lock-handoff',
	'persistent-profile-relaunch',
] as const;
const optionalCellIds = [
	'synthetic-page-freeze',
	'synthetic-quota-refusal',
] as const;

const EvidenceErrorSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		message: Type.String({ minLength: 1 }),
		stack: Type.Optional(Type.String()),
	},
	CLOSED,
);

const EvidenceProofsSchema = Type.Object(
	{
		rowCount: Type.Optional(Type.Integer({ minimum: 0 })),
		semanticSha256: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
		documentSha256: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
		storageUsageBytes: Type.Optional(Type.Integer({ minimum: 0 })),
		storageQuotaBytes: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	CLOSED,
);

const EvidenceParameterSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
	},
	CLOSED,
);

const EvidenceCellSchema = Type.Object(
	{
		id: EvidenceCellIdSchema,
		injection: Type.Union([
			Type.Literal('none'),
			Type.Literal('second-owner'),
			Type.Literal('worker-close'),
			Type.Literal('browser-relaunch'),
			Type.Literal('cdp-freeze'),
			Type.Literal('cdp-quota'),
		]),
		outcome: Type.Union([
			Type.Literal('passed'),
			Type.Literal('failed'),
			Type.Literal('unsupported'),
		]),
		startedAt: Type.String({ format: 'date-time' }),
		endedAt: Type.String({ format: 'date-time' }),
		durationMs: Type.Integer({ minimum: 0 }),
		parameters: Type.Array(EvidenceParameterSchema),
		proofs: EvidenceProofsSchema,
		reason: Type.Optional(Type.String({ minLength: 1 })),
		error: Type.Optional(EvidenceErrorSchema),
	},
	CLOSED,
);

export const BrowserEngineEvidenceSchema = Type.Object(
	{
		schemaVersion: Type.Literal('epicenter-browser-engine-evidence/v2'),
		kind: Type.Literal('epicenter-browser-engine-evidence'),
		scope: Type.Literal('pre-physical-browser-engine'),
		decisionEligible: Type.Literal(false),
		semanticWitnessScope: Type.Literal('within-run-only'),
		runId: Type.String({ minLength: 1 }),
		startedAt: Type.String({ format: 'date-time' }),
		endedAt: Type.String({ format: 'date-time' }),
		durationMs: Type.Integer({ minimum: 0 }),
		source: Type.Object(
			{
				commit: Type.String({ pattern: '^[0-9a-f]{40}$' }),
				clean: Type.Boolean(),
				dirtyPaths: Type.Array(Type.String({ minLength: 1 })),
				lockfileSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
				harnessSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
			},
			CLOSED,
		),
		runtime: Type.Object(
			{
				engine: EvidenceEngineSchema,
				playwrightVersion: Type.String({ minLength: 1 }),
				browserVersion: Type.String({ minLength: 1 }),
				userAgent: Type.String({ minLength: 1 }),
				platform: Type.String({ minLength: 1 }),
				architecture: Type.String({ minLength: 1 }),
				headless: Type.Literal(true),
				persistentProfile: Type.Literal(true),
				origin: Type.String({ format: 'uri' }),
			},
			CLOSED,
		),
		features: Type.Object(
			{
				secureContext: Type.Boolean(),
				dedicatedWorker: Type.Boolean(),
				opfs: Type.Boolean(),
				webLocks: Type.Boolean(),
				syncAccessHandle: Type.Boolean(),
				storageUsageBytes: Type.Optional(Type.Integer({ minimum: 0 })),
				storageQuotaBytes: Type.Optional(Type.Integer({ minimum: 0 })),
			},
			CLOSED,
		),
		cells: Type.Array(EvidenceCellSchema, { minItems: 1 }),
		limitations: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		overall: Type.Union([
			Type.Literal('invalid'),
			Type.Literal('incomplete'),
			Type.Literal('provisional'),
		]),
	},
	CLOSED,
);

export type BrowserEngineEvidence = Static<typeof BrowserEngineEvidenceSchema>;
export type EvidenceCell = BrowserEngineEvidence['cells'][number];
export type EvidenceCellId = EvidenceCell['id'];
export type EvidenceEngine = BrowserEngineEvidence['runtime']['engine'];

export function assertBrowserEngineEvidence(
	value: unknown,
): asserts value is BrowserEngineEvidence {
	if (!Value.Check(BrowserEngineEvidenceSchema, value)) {
		const issues = [...Value.Errors(BrowserEngineEvidenceSchema, value)]
			.slice(0, 5)
			.map(({ instancePath, message }) => `${instancePath || '/'}: ${message}`)
			.join('; ');
		throw new Error(`Invalid browser-engine evidence: ${issues}`);
	}
	const issues: string[] = [];
	if (value.source.clean !== (value.source.dirtyPaths.length === 0)) {
		issues.push('source.clean must agree with source.dirtyPaths');
	}
	if (durationBetween(value.startedAt, value.endedAt) !== value.durationMs) {
		issues.push('run duration must equal its timestamp interval');
	}
	const seen = new Set<EvidenceCellId>();
	for (const cell of value.cells) {
		if (seen.has(cell.id)) issues.push(`duplicate cell '${cell.id}'`);
		seen.add(cell.id);
		const duplicateParameters = duplicateParameterNames(cell);
		if (duplicateParameters.length > 0) {
			issues.push(
				`cell '${cell.id}' has duplicate parameters: ${duplicateParameters.join(', ')}`,
			);
		}
		if (durationBetween(cell.startedAt, cell.endedAt) !== cell.durationMs) {
			issues.push(
				`cell '${cell.id}' duration must equal its timestamp interval`,
			);
		}
		if (cell.injection !== evidenceInjectionFor(cell.id)) {
			issues.push(`cell '${cell.id}' has the wrong injection`);
		}
		if (cell.outcome === 'unsupported' && cell.reason === undefined) {
			issues.push(`unsupported cell '${cell.id}' requires a reason`);
		}
		if (cell.outcome !== 'unsupported' && cell.reason !== undefined) {
			issues.push(`cell '${cell.id}' may not retain an unsupported reason`);
		}
		if (cell.outcome === 'failed' && cell.error === undefined) {
			issues.push(`failed cell '${cell.id}' requires an error`);
		}
		if (cell.outcome !== 'failed' && cell.error !== undefined) {
			issues.push(`cell '${cell.id}' may not retain an error`);
		}
		if (cell.outcome === 'passed') {
			issues.push(...passedCellWitnessIssues(cell));
		}
		if (
			value.runtime.engine === 'webkit' &&
			optionalCellIds.includes(cell.id as (typeof optionalCellIds)[number]) &&
			cell.outcome !== 'unsupported'
		) {
			issues.push(`WebKit CDP cell '${cell.id}' must be unsupported`);
		}
	}
	const admission = value.cells.find(({ id }) => id === 'feature-admission');
	if (
		admission?.outcome === 'passed' &&
		Object.entries(value.features).some(
			([name, feature]) =>
				!name.endsWith('Bytes') && typeof feature === 'boolean' && !feature,
		)
	) {
		issues.push('passed feature admission requires every declared feature');
	}
	const expectedOverall = classifyEvidence(value.runtime.engine, value.cells);
	if (value.overall !== expectedOverall) {
		issues.push(`overall must be '${expectedOverall}' for the retained cells`);
	}
	if (issues.length > 0) {
		throw new Error(`Invalid browser-engine evidence: ${issues.join('; ')}`);
	}
}

export function classifyEvidence(
	_engine: EvidenceEngine,
	cells: readonly EvidenceCell[],
): BrowserEngineEvidence['overall'] {
	const ids = cells.map(({ id }) => id);
	if (new Set(ids).size !== ids.length) return 'invalid';
	if (cells.some((cell) => duplicateParameterNames(cell).length > 0))
		return 'invalid';
	if (cells.some(({ outcome }) => outcome === 'failed')) return 'invalid';
	if (
		cells.some(
			(cell) =>
				cell.outcome === 'passed' && passedCellWitnessIssues(cell).length > 0,
		)
	)
		return 'invalid';
	if (mandatoryCellIds.some((id) => !ids.includes(id))) return 'incomplete';
	if (
		cells.some(
			({ id, outcome }) =>
				isMandatoryEvidenceCell(id) && outcome === 'unsupported',
		)
	)
		return 'incomplete';
	return 'provisional';
}

export function isMandatoryEvidenceCell(id: EvidenceCellId): boolean {
	return mandatoryCellIds.includes(id as (typeof mandatoryCellIds)[number]);
}

export function evidenceInjectionFor(
	id: EvidenceCellId,
): EvidenceCell['injection'] {
	switch (id) {
		case 'second-owner-refusal':
			return 'second-owner';
		case 'worker-termination-lock-handoff':
			return 'worker-close';
		case 'persistent-profile-relaunch':
			return 'browser-relaunch';
		case 'synthetic-page-freeze':
			return 'cdp-freeze';
		case 'synthetic-quota-refusal':
			return 'cdp-quota';
		default:
			return 'none';
	}
}

function durationBetween(startedAt: string, endedAt: string): number {
	return Date.parse(endedAt) - Date.parse(startedAt);
}

function passedCellWitnessIssues(cell: EvidenceCell): string[] {
	if (!isMandatoryEvidenceCell(cell.id)) {
		return [
			`passed optional cell '${cell.id}' has no frozen v2 witness contract`,
		];
	}
	const issues: string[] = [];
	if (cell.proofs.rowCount === undefined || cell.proofs.rowCount < 1) {
		issues.push(`passed cell '${cell.id}' requires a positive rowCount`);
	}
	if (cell.proofs.semanticSha256 === undefined) {
		issues.push(`passed cell '${cell.id}' requires semanticSha256`);
	}
	switch (cell.id) {
		case 'crud-durability-reload':
			if (cell.proofs.documentSha256 === undefined) {
				issues.push(`passed cell '${cell.id}' requires documentSha256`);
			}
			if (!hasMatchingReopenWitness(cell)) {
				issues.push(
					`passed cell '${cell.id}' requires matching before, reopened, and final semantic witnesses`,
				);
			}
			break;
		case 'second-owner-refusal':
			if (
				parameter(cell, 'refusalMessage') !==
				'Browser Epicenter is already open in another tab for this origin'
			) {
				issues.push(`passed cell '${cell.id}' requires the owner refusal`);
			}
			break;
		case 'hung-sync-continuity':
			if (!hasHungSyncContinuityWitness(cell)) {
				issues.push(
					`passed cell '${cell.id}' requires a pending sync transport and one same-owner write witnessed exactly once`,
				);
			}
			break;
		case 'worker-termination-lock-handoff':
		case 'persistent-profile-relaunch':
			if (
				!hasMatchingReopenWitness(cell, false) ||
				!hasContinuationWriteWitness(cell)
			) {
				issues.push(
					`passed cell '${cell.id}' requires matching reopen witnesses and one continuation write`,
				);
			}
			break;
		default:
			break;
	}
	return issues;
}

function hasHungSyncContinuityWitness(cell: EvidenceCell): boolean {
	const sameTabRowId = parameter(cell, 'sameTabRowId');
	return (
		parameter(cell, 'syncStarted') === true &&
		parameter(cell, 'syncPending') === true &&
		isRowId(sameTabRowId) &&
		parameter(cell, 'sameTabRowOccurrences') === 1 &&
		parameter(cell, 'claim') === 'same-owner-local-rpc-continuity-only'
	);
}

function hasContinuationWriteWitness(cell: EvidenceCell): boolean {
	const beforeRowCount = parameter(cell, 'beforeRowCount');
	const reopenedRowCount = parameter(cell, 'reopenedRowCount');
	const reopenedSha256 = parameter(cell, 'reopenedSemanticSha256');
	return (
		typeof beforeRowCount === 'number' &&
		Number.isInteger(beforeRowCount) &&
		beforeRowCount === reopenedRowCount &&
		cell.proofs.rowCount === beforeRowCount + 1 &&
		cell.proofs.semanticSha256 !== reopenedSha256
	);
}

function hasMatchingReopenWitness(
	cell: EvidenceCell,
	matchFinal = true,
): boolean {
	const before = parameter(cell, 'beforeSemanticSha256');
	const reopened = parameter(cell, 'reopenedSemanticSha256');
	return (
		isSha256(before) &&
		before === reopened &&
		(!matchFinal || reopened === cell.proofs.semanticSha256)
	);
}

function parameter(
	cell: EvidenceCell,
	name: string,
): string | number | boolean | undefined {
	return cell.parameters.find((candidate) => candidate.name === name)?.value;
}

function duplicateParameterNames(cell: EvidenceCell): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const { name } of cell.parameters) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	return [...duplicates];
}

function isRowId(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-z]{24}$/.test(value);
}

function isSha256(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
