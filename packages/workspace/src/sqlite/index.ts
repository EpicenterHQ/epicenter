/**
 * Typed SQLite application records for the greenfield workspace API.
 *
 * This subpath deliberately excludes the legacy Yjs record implementation:
 * SQLite owns records, while Yjs remains a separate child-document concern.
 */

export {
	type AsyncTable,
	type AsyncTables,
	type AsyncWorkspace,
	asyncWorkspaceHandle,
	type TableCommitDelta,
	type WorkspaceCommitDelta,
	type WorkspaceWriteBatch,
} from './client.js';
export {
	APPLICATION_DATA_VERSION_LOCK_FORMAT,
	type ApplicationDataVersionLock,
	type ApplicationDataVersionLockEntry,
	parseApplicationDataVersionLock,
} from './data-version.js';
export {
	type ApplicationDatabase,
	type ApplicationDatabaseIdentityInspection,
	type ApplicationDatabaseOptions,
	type ApplicationLogicalSnapshot,
	type ApplicationMutationContext,
	type ApplicationMutationCoordinator,
	type ApplicationTable,
	type ApplicationTables,
	type ApplicationTransaction,
	inspectApplicationDatabaseIdentity,
	ReplicaInvariantViolationError,
} from './database.js';
export {
	type BlobPlaneContracts,
	type CompiledColumn,
	defineKv,
	defineTable,
	defineWorkspace,
	type Fields,
	type KvDefinition,
	type KvDefinitions,
	lockWorkspace,
	type RowFor,
	type TableDefinition,
	type TableDefinitions,
	type WorkspaceCandidate,
	type WorkspaceDefinition,
} from './definition.js';
export type {
	OpenedDocument,
	WorkspaceDocumentRuntime,
	WorkspaceDocumentSession,
} from './document-client.js';
export {
	type DocumentFormat,
	type DocumentHandle,
	document,
} from './document-format.js';
export type {
	OpenedWorkspace,
	StandaloneWorkspace,
	WorkspaceKvMount,
	WorkspaceReplica,
} from './open.js';
export {
	RECORDS_RECOVERY_CHECKPOINT_FORMAT,
	type RecordsRecoveryCheckpoint,
	RecordsRecoveryCheckpointSchema,
} from './recovery-checkpoint.js';
export {
	ReplicaAdmissionConflictError,
	ReplicaRecordsEpochMismatchError,
	type ReplicaSyncPort,
} from './replica.js';
export {
	type CreateHttpReplicaSyncPortOptions,
	createHttpReplicaSyncPort,
} from './replica-http.js';
