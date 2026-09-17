/**
 * What a developer gets from `@epicenter/data`.
 *
 * The store, the transport that carries it, and the vocabulary a data
 * definition is declared in. Openers live at their own entry points, because
 * one imports `bun:sqlite` and the other imports `idb`, and neither belongs in
 * a barrel the other has to load.
 *
 * The entry points: `.` for the surface, `./definition` for inert schema
 * vocabulary, `./browser` for the opener, `./sync` for the transport,
 * `./artifact` for the files a person keeps, `./direct` for the construction
 * seam, and `./memory` for test support. The superseded stack that used to answer at `./legacy` was deleted
 * along with its consumers (ADR-0227), so a developer arriving here finds one
 * store rather than a choice between two.
 *
 * Every opener takes the definition, because its id names the store it opens
 * (ADR-0229). The subpath already says which runtime, so the identifier does
 * not repeat it.
 *
 * The transport answers at `./sync` and nowhere else. This barrel used to
 * re-export all of it as well, which no consumer ever used: every one of them
 * imports `@epicenter/data/sync` by name.
 *
 * ## What is deliberately not here
 *
 * A barrel is a promise, and this one used to promise fourteen names nobody
 * asked for. The durable port's vocabulary (`DurableOp`, `DurablePort`,
 * `DurableSnapshot`, `OutboxEntry`, `PersistenceStatus`) is an internal
 * conformance concern between `persistence.ts` and its two ports, which import
 * it by relative path; `SNAPSHOT_FOLD_THRESHOLD` is the fold's own number. The
 * structural types an application never names (`TableHandle`, `KvHandle`,
 * `StoredData`, `DocumentPressure`, `DataDocument`, `SyncCapability`) are
 * reachable through `ReplicaData`/`ReplicaData` for anyone who needs one, and adapters like
 * `@epicenter/svelte`'s declare the slice they touch instead. The store's own
 * error constructors (`StoreError`, `StoreUnusableError`) are what a store
 * THROWS, not what a caller builds.
 *
 * All of them had zero importers outside this package. Add one back when
 * something outside actually names it.
 */

export type {
	ConformanceIssue,
	ContentCodec,
	DataDefinition,
	JsonObject,
	JsonValue,
	RowOf,
} from './definition/index.js';
export {
	ContentError,
	compileData,
	DataDefinitionParseError,
	defineData,
	defineTable,
	field,
	plainText,
} from './definition/index.js';
export type { PersistenceCapability } from './store/persistence.js';
export type {
	ApplyFailedError,
	DatabaseAccount,
	DataDocument,
	DeclaredData,
	NonconformingRow,
	ReplicaData,
	ReplicaDocument,
	Row,
	RowAbsentError,
	TypedTableHandle,
} from './store/store.js';
