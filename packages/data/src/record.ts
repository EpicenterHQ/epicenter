export type { RowDocument } from './documents.js';
export {
	type CompiledTableDefinition,
	type CompiledValueDefinition,
	type ConformanceIssue,
	type ConstrainedUpdate,
	type CreateInputFor,
	defineLens,
	defineTable,
	defineValues,
	type FieldsFor,
	type LensDefinition,
	LensParseError,
	type LensReadError,
	type NonconformingRowError,
	type NonconformingValueError,
	parseLens,
	type RowFor,
	type TableDefinition,
	type ValueFor,
	type ValuesDefinition,
} from './lens.js';
export type {
	JsonObject,
	JsonValue,
	RecordAddress,
} from './protocol/v1/index.js';
export {
	type BoundLens,
	type BoundLenses,
	type CreateRecordEpicenterOptions,
	createRecordEpicenter,
	type RecordBlobLens,
	type RecordEpicenter,
	type RecordTableEntry,
	type RecordTableLens,
	type RecordTableScan,
	type RecordValueLens,
} from './record-epicenter.js';
export {
	createHttpRecordSyncSession,
	createHttpRecordSyncTransport,
	type RecordBlobHttpBody,
} from './record-sync-http.js';
export {
	RecordAuthorityLifetimeMismatchError,
	type RecordSyncSession,
	type RecordSyncState,
	type RecordSyncStatus,
	type RecordSyncTransport,
} from './record-sync-supervisor.js';
export type {
	FirstAttachmentChoice,
	ReplicaAttachment,
	ReplicaParkedWorkPage,
	ReplicaWorkSummary,
} from './store/replica/index.js';
