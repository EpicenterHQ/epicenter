import { SnapshotRowSchema } from '@epicenter/record-sync';
import { type Static, type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';
import { RecordsRecoveryCheckpointSchema } from './recovery-checkpoint.js';

const CLOSED = { additionalProperties: false } as const;
const requestId = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});
const nonEmptyString = Type.String({ minLength: 1 });
const jsonRecord = Type.Record(Type.String(), Type.Unknown());
type WireRow = { id: string } & Record<string, unknown>;
const row = Type.Unsafe<WireRow>(
	Type.Object({ id: nonEmptyString }, { additionalProperties: true }),
);

const tableListOptions = Type.Object(
	{
		where: Type.Optional(jsonRecord),
		orderBy: Type.Optional(nonEmptyString),
		desc: Type.Optional(Type.Boolean()),
		limit: Type.Optional(
			Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		),
		offset: Type.Optional(
			Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		),
	},
	CLOSED,
);

const workspaceMutation = Type.Union([
	Type.Object(
		{ kind: Type.Literal('create'), table: nonEmptyString, row: jsonRecord },
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('patch'),
			table: nonEmptyString,
			rowId: nonEmptyString,
			cells: jsonRecord,
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('remove'),
			table: nonEmptyString,
			rowId: nonEmptyString,
		},
		CLOSED,
	),
]);

export const WorkspaceServiceRequestSchema = Type.Union([
	Type.Object({ kind: Type.Literal('describe') }, CLOSED),
	Type.Object({ kind: Type.Literal('readTablesSnapshot') }, CLOSED),
	Type.Object({ kind: Type.Literal('readRecoveryCheckpoint') }, CLOSED),
	Type.Object(
		{
			kind: Type.Literal('get'),
			table: nonEmptyString,
			rowId: nonEmptyString,
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('list'),
			table: nonEmptyString,
			options: Type.Optional(tableListOptions),
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('has'),
			table: nonEmptyString,
			rowId: nonEmptyString,
		},
		CLOSED,
	),
	Type.Object({ kind: Type.Literal('count'), table: nonEmptyString }, CLOSED),
	Type.Object(
		{
			kind: Type.Literal('sql'),
			query: nonEmptyString,
			parameters: Type.Array(
				Type.Union([Type.String(), Type.Number(), Type.Null()]),
			),
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('mutate'),
			mutations: Type.Array(workspaceMutation, { minItems: 1 }),
		},
		CLOSED,
	),
]);

export type WorkspaceServiceRequest = Static<
	typeof WorkspaceServiceRequestSchema
>;
export type WorkspaceMutation = Static<typeof workspaceMutation>;
export type TableListOptions = Static<typeof tableListOptions>;

export const WorkspaceServiceResponseSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal('workspace'),
			workspaceKind: Type.Union([
				Type.Literal('standalone'),
				Type.Literal('replica'),
			]),
			workspaceId: nonEmptyString,
			recordsDescriptor: nonEmptyString,
			recordsSchemaHash: nonEmptyString,
		},
		CLOSED,
	),
	Type.Object(
		{ kind: Type.Literal('row'), row: Type.Union([row, Type.Null()]) },
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('tablesSnapshot'),
			rows: Type.Array(SnapshotRowSchema),
		},
		CLOSED,
	),
	Type.Object({ kind: Type.Literal('rows'), rows: Type.Array(row) }, CLOSED),
	Type.Object({ kind: Type.Literal('boolean'), value: Type.Boolean() }, CLOSED),
	Type.Object(
		{
			kind: Type.Literal('count'),
			value: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		},
		CLOSED,
	),
	Type.Object(
		{ kind: Type.Literal('sql'), rows: Type.Array(jsonRecord) },
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('recoveryCheckpoint'),
			checkpoint: RecordsRecoveryCheckpointSchema,
		},
		CLOSED,
	),
	Type.Object(
		{ kind: Type.Literal('mutation'), results: Type.Array(Type.Unknown()) },
		CLOSED,
	),
]);

export type WorkspaceServiceResponse = Static<
	typeof WorkspaceServiceResponseSchema
>;

const tableCommitDelta = Type.Object(
	{
		upserted: Type.Array(row),
		removed: Type.Array(nonEmptyString),
	},
	CLOSED,
);

export type WorkspaceCommitDelta = {
	tables: Readonly<
		Record<
			string,
			{
				upserted: readonly WireRow[];
				removed: readonly string[];
			}
		>
	>;
};

export type WorkspaceInvalidation = {
	tables: Readonly<Record<string, readonly string[]>>;
};

export const WorkspaceInvalidationSchema = Type.Unsafe<WorkspaceInvalidation>(
	Type.Object(
		{
			tables: Type.Record(Type.String(), Type.Array(nonEmptyString)),
		},
		CLOSED,
	),
);

export const WorkspaceCommitDeltaSchema = Type.Unsafe<WorkspaceCommitDelta>(
	Type.Object(
		{
			tables: Type.Record(Type.String(), tableCommitDelta),
		},
		CLOSED,
	),
);

export const WORKSPACE_WORKER_PROTOCOL =
	'epicenter.workspace-worker/1' as const;
export const WORKSPACE_INVALIDATION_PROTOCOL =
	'epicenter.workspace-invalidation/1' as const;

export const WorkspaceInvalidationMessageSchema = Type.Object(
	{
		protocol: Type.Literal(WORKSPACE_INVALIDATION_PROTOCOL),
		senderId: nonEmptyString,
		invalidation: WorkspaceInvalidationSchema,
	},
	CLOSED,
);

export type WorkspaceInvalidationMessage = Static<
	typeof WorkspaceInvalidationMessageSchema
>;

const serializedWorkerError = Type.Object(
	{ name: nonEmptyString, message: Type.String() },
	CLOSED,
);

export const WorkspaceWorkerCommandSchema = Type.Union([
	Type.Object(
		{
			protocol: Type.Literal(WORKSPACE_WORKER_PROTOCOL),
			type: Type.Literal('request'),
			requestId,
			request: WorkspaceServiceRequestSchema,
		},
		CLOSED,
	),
	Type.Object(
		{
			protocol: Type.Literal(WORKSPACE_WORKER_PROTOCOL),
			type: Type.Literal('dispose'),
			requestId,
		},
		CLOSED,
	),
]);

export type WorkspaceWorkerCommand = Static<
	typeof WorkspaceWorkerCommandSchema
>;

export const WorkspaceWorkerEventSchema = Type.Union([
	Type.Object(
		{
			protocol: Type.Literal(WORKSPACE_WORKER_PROTOCOL),
			type: Type.Literal('reply'),
			requestId,
			ok: Type.Literal(true),
			response: WorkspaceServiceResponseSchema,
		},
		CLOSED,
	),
	Type.Object(
		{
			protocol: Type.Literal(WORKSPACE_WORKER_PROTOCOL),
			type: Type.Literal('reply'),
			requestId,
			ok: Type.Literal(false),
			error: serializedWorkerError,
		},
		CLOSED,
	),
	Type.Object(
		{
			protocol: Type.Literal(WORKSPACE_WORKER_PROTOCOL),
			type: Type.Literal('delta'),
			delta: WorkspaceCommitDeltaSchema,
		},
		CLOSED,
	),
	Type.Object(
		{
			protocol: Type.Literal(WORKSPACE_WORKER_PROTOCOL),
			type: Type.Literal('fatal'),
			error: serializedWorkerError,
		},
		CLOSED,
	),
	Type.Object(
		{
			protocol: Type.Literal(WORKSPACE_WORKER_PROTOCOL),
			type: Type.Literal('disposed'),
			requestId,
		},
		CLOSED,
	),
]);

export type WorkspaceWorkerEvent = Static<typeof WorkspaceWorkerEventSchema>;
export type SerializedWorkerError = Static<typeof serializedWorkerError>;

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object') return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Array.isArray(value)
		? value.every((child) => isJsonValue(child, ancestors))
		: (Object.getPrototypeOf(value) === Object.prototype ||
				Object.getPrototypeOf(value) === null) &&
			Object.values(value).every((child) => isJsonValue(child, ancestors));
	ancestors.delete(value);
	return valid;
}

function parseJsonMessage<TSchemaValue extends TSchema>(
	schema: TSchemaValue,
	value: unknown,
	label: string,
): Static<TSchemaValue> {
	if (!isJsonValue(value) || !Value.Check(schema, value)) {
		throw new Error(`Invalid ${label}`);
	}
	return value as Static<TSchemaValue>;
}

export function parseWorkspaceWorkerCommand(
	value: unknown,
): WorkspaceWorkerCommand {
	return parseJsonMessage(
		WorkspaceWorkerCommandSchema,
		value,
		'workspace worker command',
	);
}

export function parseWorkspaceWorkerEvent(
	value: unknown,
): WorkspaceWorkerEvent {
	return parseJsonMessage(
		WorkspaceWorkerEventSchema,
		value,
		'workspace worker event',
	);
}

export function parseWorkspaceInvalidation(
	value: unknown,
): WorkspaceInvalidation {
	return parseJsonMessage(
		WorkspaceInvalidationSchema,
		value,
		'workspace invalidation',
	);
}

export function parseWorkspaceInvalidationMessage(
	value: unknown,
): WorkspaceInvalidationMessage {
	return parseJsonMessage(
		WorkspaceInvalidationMessageSchema,
		value,
		'workspace invalidation message',
	);
}
