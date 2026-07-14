/**
 * Typed SQLite application records for the greenfield workspace API.
 *
 * This subpath deliberately excludes the legacy Yjs record implementation:
 * SQLite owns records, while Yjs remains a separate child-document concern.
 */

export { nullable } from '../document/nullable.js';

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
export {
	BLOB_REF_KEYWORD,
	type BlobField,
	type BlobRef,
	type DocumentField,
	field,
} from './field.js';
export type {
	OpenedWorkspace,
	StandaloneWorkspace,
	WorkspaceKvMount,
	WorkspaceReplica,
} from './open.js';
export {
	type CollectPortableWorkspaceOptions,
	collectPortableWorkspace,
	PORTABLE_WORKSPACE_FORMAT,
	type PortableBlob,
	type PortableDocument,
	type PortableFileManifest,
	type PortableWorkspaceContent,
	type PortableWorkspaceManifest,
	planTablesApply,
	type TablesApplyMutation,
	type TablesApplyPlan,
} from './portable-workspace.js';
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
	type TablesAuthorityPort,
} from './replica-http.js';
export type {
	ServerWorkspaceAuthority,
	WorkspaceAuthority,
} from './workspace-authority.js';
export {
	parseWorkspaceVersionLock,
	WORKSPACE_VERSION_LOCK_FORMAT,
	type WorkspaceVersionLock,
	type WorkspaceVersionLockEntry,
} from './workspace-version.js';
