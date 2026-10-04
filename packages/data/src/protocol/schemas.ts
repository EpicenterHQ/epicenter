/**
 * Scalar synchronization wire V1.
 *
 * One lifetime-bound exchange converges independently durable scalar
 * addresses. Addresses are structured: a row is (namespace, table, rowId) and
 * a value is (namespace, value). There is no concatenated qualified key, no
 * cursor object, and no transport-grouping commit semantics.
 *
 * Paging uses one durable replica watermark. The first request of a scan
 * omits `through`; the authority samples it. Each installed page advances the
 * durable `after` (to the last returned sequence while `more`, to `through` on
 * the terminal page), so a crash restarts a fresh scan from durable progress
 * without reinstalling completed pages.
 */
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	DATA_ADMISSION_LIMITS,
	encodedJsonBytes,
	isAdmissibleChange,
	isAdmissibleRecord,
	isJsonValue,
	isMemberKey,
	isNamespaceKey,
	isRuntimeId,
} from './admission.js';

const CLOSED = { additionalProperties: false } as const;
const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveSequence = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});
const digest = Type.String({
	minLength: 64,
	maxLength: 64,
	pattern: '^[a-f0-9]{64}$',
});

export const NamespaceKeySchema = Type.String({
	minLength: 5,
	maxLength: DATA_ADMISSION_LIMITS.namespaceKeyBytes,
	pattern:
		'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?){2,}$',
});
export type NamespaceKey = Static<typeof NamespaceKeySchema>;

export const MemberKeySchema = Type.String({
	minLength: 1,
	maxLength: DATA_ADMISSION_LIMITS.memberKeyBytes,
	pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*(?:\\.[a-z0-9]+(?:-[a-z0-9]+)*)*$',
});
export type MemberKey = Static<typeof MemberKeySchema>;

const runtimeId = Type.String({
	minLength: 24,
	maxLength: 24,
	pattern: '^[a-z0-9]{24}$',
});

export const RowIdSchema = runtimeId;
export type RowId = Static<typeof RowIdSchema>;

export const ReplicaIdSchema = runtimeId;
export type ReplicaId = Static<typeof ReplicaIdSchema>;

/** Opaque equality-only authority lifetime identity. Never ordered. */
export const LifetimeIdSchema = runtimeId;
export type LifetimeId = Static<typeof LifetimeIdSchema>;

export type RowAddress = {
	kind: 'row';
	namespace: NamespaceKey;
	table: MemberKey;
	rowId: RowId;
};
export type ValueAddress = {
	kind: 'value';
	namespace: NamespaceKey;
	value: MemberKey;
};
export type ScalarAddress = RowAddress | ValueAddress;

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;
export type JsonObject = { [key: string]: JsonValue };

const jsonValueSchema = Type.Unsafe<JsonValue>({});
const jsonObjectSchema = Type.Unsafe<JsonObject>(
	Type.Object({}, { additionalProperties: true }),
);
const fieldKey = Type.String({
	minLength: 1,
	maxLength: DATA_ADMISSION_LIMITS.fieldKeyBytes,
});

const rowCreateSchema = Type.Object(
	{
		kind: Type.Literal('create'),
		namespace: NamespaceKeySchema,
		table: MemberKeySchema,
		rowId: RowIdSchema,
		fields: jsonObjectSchema,
	},
	CLOSED,
);
const rowUpdateSchema = Type.Object(
	{
		kind: Type.Literal('update'),
		namespace: NamespaceKeySchema,
		table: MemberKeySchema,
		rowId: RowIdSchema,
		fields: Type.Object(
			{
				set: jsonObjectSchema,
				unset: Type.Array(fieldKey, {
					maxItems: DATA_ADMISSION_LIMITS.unsetKeysPerChange,
				}),
			},
			CLOSED,
		),
	},
	CLOSED,
);
const rowDeleteSchema = Type.Object(
	{
		kind: Type.Literal('delete'),
		namespace: NamespaceKeySchema,
		table: MemberKeySchema,
		rowId: RowIdSchema,
	},
	CLOSED,
);
const valueSetSchema = Type.Object(
	{
		kind: Type.Literal('set'),
		namespace: NamespaceKeySchema,
		value: MemberKeySchema,
		payload: jsonValueSchema,
	},
	CLOSED,
);
const valueUnsetSchema = Type.Object(
	{
		kind: Type.Literal('unset'),
		namespace: NamespaceKeySchema,
		value: MemberKeySchema,
	},
	CLOSED,
);

export const ChangeSchema = Type.Union([
	rowCreateSchema,
	rowUpdateSchema,
	rowDeleteSchema,
	valueSetSchema,
	valueUnsetSchema,
]);
export type Change = Static<typeof ChangeSchema>;

const rowRecordSchema = Type.Object(
	{
		kind: Type.Literal('row'),
		namespace: NamespaceKeySchema,
		table: MemberKeySchema,
		rowId: RowIdSchema,
		changedSequence: positiveSequence,
		fields: jsonObjectSchema,
	},
	CLOSED,
);
const rowDeletedRecordSchema = Type.Object(
	{
		kind: Type.Literal('row-deleted'),
		namespace: NamespaceKeySchema,
		table: MemberKeySchema,
		rowId: RowIdSchema,
		changedSequence: positiveSequence,
	},
	CLOSED,
);
const valueRecordSchema = Type.Object(
	{
		kind: Type.Literal('value'),
		namespace: NamespaceKeySchema,
		value: MemberKeySchema,
		changedSequence: positiveSequence,
		payload: jsonValueSchema,
	},
	CLOSED,
);
const valueUnsetRecordSchema = Type.Object(
	{
		kind: Type.Literal('value-unset'),
		namespace: NamespaceKeySchema,
		value: MemberKeySchema,
		changedSequence: positiveSequence,
	},
	CLOSED,
);

export const RecordSchema = Type.Union([
	rowRecordSchema,
	rowDeletedRecordSchema,
	valueRecordSchema,
	valueUnsetRecordSchema,
]);
export type Record = Static<typeof RecordSchema>;

export const BatchSchema = Type.Object(
	{
		seq: positiveSequence,
		digest,
		changes: Type.Array(ChangeSchema, {
			minItems: 1,
			maxItems: DATA_ADMISSION_LIMITS.changesPerBatch,
		}),
	},
	CLOSED,
);
export type Batch = Static<typeof BatchSchema>;

export const ExchangeRequestSchema = Type.Object(
	{
		replicaId: ReplicaIdSchema,
		lifetimeId: Type.Union([LifetimeIdSchema, Type.Null()]),
		after: sequence,
		through: Type.Optional(positiveSequence),
		batch: Type.Optional(BatchSchema),
	},
	CLOSED,
);
export type ExchangeRequest = Static<typeof ExchangeRequestSchema>;

export const ReceiptSchema = Type.Object(
	{ seq: positiveSequence, digest },
	CLOSED,
);
export type Receipt = Static<typeof ReceiptSchema>;

const exchangeSuccessSchema = Type.Object(
	{
		lifetimeId: LifetimeIdSchema,
		receipt: Type.Optional(ReceiptSchema),
		through: sequence,
		records: Type.Array(RecordSchema, {
			maxItems: DATA_ADMISSION_LIMITS.recordsPerPage,
		}),
		more: Type.Boolean(),
	},
	CLOSED,
);
const batchConflictSchema = Type.Object(
	{ refusal: Type.Literal('batch-conflict'), lifetimeId: LifetimeIdSchema },
	CLOSED,
);
const storageLimitSchema = Type.Object(
	{ refusal: Type.Literal('storage-limit'), lifetimeId: LifetimeIdSchema },
	CLOSED,
);
const lifetimeMismatchSchema = Type.Object(
	{ refusal: Type.Literal('lifetime-mismatch'), lifetimeId: LifetimeIdSchema },
	CLOSED,
);
const checkpointAheadSchema = Type.Object(
	{ refusal: Type.Literal('checkpoint-ahead'), lifetimeId: LifetimeIdSchema },
	CLOSED,
);
const changeInadmissibleSchema = Type.Object(
	{
		refusal: Type.Literal('change-inadmissible'),
		lifetimeId: LifetimeIdSchema,
		seq: positiveSequence,
		digest,
		changeIndex: Type.Integer({
			minimum: 0,
			maximum: DATA_ADMISSION_LIMITS.changesPerBatch - 1,
		}),
		reason: Type.Literal('record-bound'),
	},
	CLOSED,
);

export const ExchangeResponseSchema = Type.Union([
	exchangeSuccessSchema,
	batchConflictSchema,
	storageLimitSchema,
	lifetimeMismatchSchema,
	checkpointAheadSchema,
	changeInadmissibleSchema,
]);
export type ExchangeResponse = Static<typeof ExchangeResponseSchema>;
export type ExchangeSuccess = Static<typeof exchangeSuccessSchema>;

export const ProtocolValidationError = defineErrors({
	Invalid: ({ boundary }: { boundary: string }) => ({
		message: `Invalid data protocol ${boundary}`,
		boundary,
	}),
});
export type ProtocolValidationError = InferErrors<
	typeof ProtocolValidationError
>;

export function parseNamespaceKey(
	value: unknown,
): Result<NamespaceKey, ProtocolValidationError> {
	return typeof value === 'string' && isNamespaceKey(value)
		? Ok(value)
		: ProtocolValidationError.Invalid({ boundary: 'namespace key' });
}

export function parseMemberKey(
	value: unknown,
): Result<MemberKey, ProtocolValidationError> {
	return typeof value === 'string' && isMemberKey(value)
		? Ok(value)
		: ProtocolValidationError.Invalid({ boundary: 'member key' });
}

export function parseRowId(
	value: unknown,
): Result<RowId, ProtocolValidationError> {
	return typeof value === 'string' && isRuntimeId(value)
		? Ok(value)
		: ProtocolValidationError.Invalid({ boundary: 'row id' });
}

export function parseReplicaId(
	value: unknown,
): Result<ReplicaId, ProtocolValidationError> {
	return typeof value === 'string' && isRuntimeId(value)
		? Ok(value)
		: ProtocolValidationError.Invalid({ boundary: 'replica id' });
}

export function parseLifetimeId(
	value: unknown,
): Result<LifetimeId, ProtocolValidationError> {
	return typeof value === 'string' && isRuntimeId(value)
		? Ok(value)
		: ProtocolValidationError.Invalid({ boundary: 'lifetime id' });
}

export function parseChange(
	value: unknown,
): Result<Change, ProtocolValidationError> {
	return Value.Check(ChangeSchema, value) && isAdmissibleChange(value)
		? Ok(structuredClone(value))
		: ProtocolValidationError.Invalid({ boundary: 'change' });
}

export function parseRecord(
	value: unknown,
): Result<Record, ProtocolValidationError> {
	return Value.Check(RecordSchema, value) && isAdmissibleRecord(value)
		? Ok(structuredClone(value))
		: ProtocolValidationError.Invalid({ boundary: 'record' });
}

export function parseExchangeRequest(
	value: unknown,
): Result<ExchangeRequest, ProtocolValidationError> {
	if (!Value.Check(ExchangeRequestSchema, value)) {
		return ProtocolValidationError.Invalid({ boundary: 'exchange request' });
	}
	if (
		// A null lifetime is discovery-only: an unbound replica may learn and
		// bind the active lifetime, never claim progress or carry mutation.
		// Every upload and every continuation is bound to one exact lifetime.
		(value.lifetimeId === null &&
			(value.after !== 0 ||
				value.through !== undefined ||
				value.batch !== undefined)) ||
		// A continuation resumes one uninterrupted scan: it carries the sampled
		// `through` and can never also carry a batch (uploads ride only the
		// first page of a scan).
		(value.through !== undefined &&
			(value.batch !== undefined || value.through <= value.after)) ||
		(value.batch !== undefined &&
			(!value.batch.changes.every(isAdmissibleChange) ||
				encodedJsonBytes(value.batch) >
					DATA_ADMISSION_LIMITS.encodedBatchBytes))
	) {
		return ProtocolValidationError.Invalid({ boundary: 'exchange request' });
	}
	return Ok(structuredClone(value));
}

export function parseExchangeResponse(
	value: unknown,
): Result<ExchangeResponse, ProtocolValidationError> {
	if (!Value.Check(ExchangeResponseSchema, value)) {
		return ProtocolValidationError.Invalid({ boundary: 'exchange response' });
	}
	if ('refusal' in value) return Ok(structuredClone(value));
	const last = value.records.at(-1);
	if (
		encodedJsonBytes(value) > DATA_ADMISSION_LIMITS.encodedPageBytes ||
		!value.records.every(isAdmissibleRecord) ||
		value.records.some((record) => record.changedSequence > value.through) ||
		value.records.some((record, index, records) => {
			const prior = records[index - 1];
			return (
				prior !== undefined && record.changedSequence <= prior.changedSequence
			);
		}) ||
		// `more` promises records remain in (last, through]; an empty page or a
		// page ending at `through` cannot make that promise, so a conforming
		// scan always terminates.
		(value.more &&
			(last === undefined || last.changedSequence >= value.through))
	) {
		return ProtocolValidationError.Invalid({ boundary: 'exchange response' });
	}
	return Ok(structuredClone(value));
}

export function parseJsonValue(
	value: unknown,
): Result<JsonValue, ProtocolValidationError> {
	return isJsonValue(value)
		? Ok(structuredClone(value))
		: ProtocolValidationError.Invalid({ boundary: 'JSON value' });
}
