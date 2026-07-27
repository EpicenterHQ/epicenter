export {
	type ConformanceIssue,
	type ConstrainedUpdate,
	type CreateInputFor,
	DataReadError,
	defineLens,
	defineTable,
	defineValue,
	type FieldsFor,
	type Lens,
	type NonconformingRowError,
	type NonconformingValueError,
	optional,
	type RowFor,
	type TableDefinition,
	type TableDefinitions,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from './definitions.js';
export {
	acceptedDocumentOrigin,
	applyRowDocumentUpdate,
	type DocumentPublishOutcome,
	DocumentPullError,
	type DocumentPullResponse,
	type DocumentSyncIssue,
	encodeRowDocumentState,
	observeRowDocumentUpdates,
	type PublishDocument,
	type PullDocument,
	type RowDocument,
	type RowDocumentConnectionTarget,
} from './documents.js';
export {
	type BoundData,
	type CreateEpicenterOptions,
	createEpicenter,
	type Epicenter,
	type EpicenterSyncSession,
	type TableEntry,
	type TableLens,
	type TableScan,
	type ValueLens,
} from './epicenter.js';
export type {
	Address,
	RowAddress,
	ValueAddress,
} from './protocol/index.js';
export {
	type AuthorityRefusal,
	type OpenReplicaV1Options,
	openReplicaV1,
	REPLICA_V1_FORMAT_VERSION,
	type ReplicaV1,
	ReplicaV1Error,
	type ReplicaV1Metadata,
	type ScalarTransport,
	type TransportOutcome,
} from './replica/v1-replica.js';
export {
	createHttpScalarTransport,
	type HttpScalarTransportOptions,
	type SyncFetch,
} from './v1-http-transport.js';
export type {
	SyncCredentialProvider,
	SyncSchedule,
	SyncState,
	SyncStatus,
} from './v1-sync-supervisor.js';
