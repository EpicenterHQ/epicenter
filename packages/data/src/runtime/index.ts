export {
	type ConstrainedUpdate,
	type CreateInputFor,
	defineLens,
	defineTable,
	defineValues,
	type LensDefinition,
	type NonconformingRowError,
	type NonconformingValueError,
	type RowFor,
	type TableDefinition,
	type ValuesDefinition,
	type ValueTypeFor,
} from '../lens/index.js';
// Environment adapters stay on their own subpaths so no bundle pulls another
// environment's modules: `@epicenter/data/runtime/browser` opens the elected
// browser owner and `@epicenter/data/runtime/bun` opens the Bun replica.
export {
	type BoundLens,
	type CaptureError,
	type CreateEpicenterRuntimeOptions,
	createEpicenterRuntime,
	type EpicenterRuntime,
	type Publication,
	type TableLens,
	type TableRecordHandle,
	type ValuesLens,
	type ValuesRecordHandle,
} from './epicenter.js';
export {
	type BlobAlreadyCapturedError,
	type BlobSourceReadError,
	type RecordNotLiveError,
	type RevokedDocumentError,
	RuntimeError,
} from './errors.js';
export {
	type BlockedWork,
	type PublicationStatus,
	publicationStatus,
} from './publication-status.js';
export type { RowDocument } from './row-document.js';
export {
	type AuthorityCarrier,
	type CreateRuntimeSupervisorOptions,
	createRuntimeSupervisor,
	type RuntimeBackoff,
	type RuntimeSchedule,
	type RuntimeSupervisor,
	type SyncStatus,
} from './supervisor.js';
