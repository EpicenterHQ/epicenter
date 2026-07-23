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
	LensReadError,
	type NonconformingRowError,
	type NonconformingValueError,
	parseLens,
	type RowFor,
	type TableDefinition,
	type ValueFor,
	type ValuesDefinition,
} from './lens.js';
export type {
	ProposalArtifactStatus,
	ProposalManifest,
	ProposalManifestEntry,
	ProposalSelection,
	ProposalSourceRecord,
} from './proposal-artifact.js';
export { parseProposalSelection } from './proposal-artifact.js';
export type {
	JsonObject,
	JsonValue,
	RecordAddress,
} from './protocol/v1/index.js';
export {
	type RecordDocumentConnectionTarget,
	recordDocumentConnectionTarget,
} from './record-document-connection.js';
export type {
	BoundLens,
	BoundLenses,
	RecordBlobLens,
	RecordEpicenter,
	RecordTableEntry,
	RecordTableLens,
	RecordTableScan,
	RecordValueLens,
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
export type { SyncCredentialProvider } from './sync-supervisor.js';
