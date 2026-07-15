/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * This root entrypoint is the current production Yjs-record API. The
 * greenfield records contract is exported from `@epicenter/workspace/sqlite`;
 * its tables use one `{ fields, documents }` declaration.
 * Keep examples below as migration context until their consumers move.
 *
 * `@epicenter/workspace` builds typed Yjs-backed workspaces: tables, KV,
 * plain/rich text, and an action registry. Runtime openers wire the
 * workspace's `Y.Doc` to IndexedDB persistence and WebSocket sync via
 * `openCollaboration`, which consumes the server-owned presence channel and
 * exposes the live-peer surface (`peers.list()`).
 *
 * @example
 * ```typescript
 * import {
 *   attachRichText,
 *   type ConnectionConfig,
 *   defineTable,
 *   defineWorkspace,
 * } from '@epicenter/workspace';
 * import { field } from '@epicenter/field';
 *
 * const posts = defineTable({
 *   id: field.string(),
 *   title: field.string(),
 * }).docs({ body: attachRichText });
 *
 * const notesWorkspace = defineWorkspace({
 *   id: 'notes',
 *   name: 'notes',
 *   tables: { posts },
 *   kv: {},
 * });
 *
 * declare const connection: ConnectionConfig;
 * using workspace = notesWorkspace.connect(connection);
 * using body = workspace.tables.posts.docs.body.open('post-1');
 * await body.whenLoaded;
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// ACTION SYSTEM
// ════════════════════════════════════════════════════════════════════════════

export type { Action, ActionRegistry } from './shared/actions';
export {
	defineActions,
	defineMutation,
	defineQuery,
	invokeAction,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// NODE IDENTITY
// ════════════════════════════════════════════════════════════════════════════

export type { AgentId } from './document/agent-id.js';
export { asAgentId } from './document/agent-id.js';
export type { NodeId } from './document/node-id.js';
export {
	asNodeId,
	createNodeId,
	createNodeIdAsync,
} from './document/node-id.js';

// ════════════════════════════════════════════════════════════════════════════
// ID + DATE PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export {
	CalendarDateString,
	DateTimeString,
	InstantString,
} from '@epicenter/field';
export { IanaTimeZone } from './shared/iana-time-zone';
export type { Guid, Id } from './shared/id';
export { generateId } from './shared/id';

// ════════════════════════════════════════════════════════════════════════════
// EMPTINESS AXIS (nullable: substrate value policy)
// ════════════════════════════════════════════════════════════════════════════

export { nullable } from './document/nullable';

// ════════════════════════════════════════════════════════════════════════════
// TIMING
// ════════════════════════════════════════════════════════════════════════════

export { debounce } from './shared/debounce.js';

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export {
	createDisposableCache,
	type DisposableCache,
} from './cache/disposable-cache.js';
export { attachBroadcastChannel } from './document/attach-broadcast-channel.js';
export { attachIndexedDb } from './document/attach-indexed-db.js';
export { attachLocalStorage } from './document/attach-local-storage.js';
export { attachPlainText } from './document/attach-plain-text.js';
export {
	attachRecords,
	type RecordsHandle,
} from './document/attach-records.js';
export { attachRichText } from './document/attach-rich-text.js';
export { type ConnectionConfig, connectDoc } from './document/connect-doc.js';
export { defineKv } from './document/define-kv.js';
export { defineTable } from './document/define-table.js';
// `docGuid` is intentionally NOT exported: child-doc guid derivation is an
// internal workspace detail. Callers reach it through the table path,
// `tables.<table>.docs.<field>.guid(rowId)`, which is the public contract.
export type { SyncStatus } from './document/internal/sync-supervisor.js';
export type {
	InferKvValue,
	Kv,
	KvDefinitions,
} from './document/kv.js';
export { onLocalUpdate } from './document/on-local-update.js';
export {
	type Collaboration,
	type OnReconnectSignal,
	type OpenCollaborationConfig,
	type OpenWebSocketFn,
	openCollaboration,
} from './document/open-collaboration.js';
export type { Peer } from './document/presence-protocol.js';
export {
	type BaseRow,
	type InferTableRow,
	type ReadonlyTable,
	type Table,
	TableNewerWriterError,
	TableParseError,
	type TableReadError,
	type TableScan,
	type Tables,
	TableWriteError,
} from './document/table.js';
// Transport URL builder.
//
// `roomWsUrl({ baseURL, guid, nodeId })` builds the WebSocket URL for the
// principal-authenticated `/api/rooms/:roomId` endpoint. Browser apps and other
// app-owned runtimes use this one builder.
export { type RoomWsUrlOptions, roomWsUrl } from './document/transport.js';
export {
	wipeBareStorage,
	wipeLocalStorage,
} from './document/wipe-local-storage.js';
export {
	type ComposeContext,
	type ConnectComposition,
	type ConnectedTables,
	type ConnectedWorkspace,
	type ConnectedWorkspaceContext,
	type ConnectOptions,
	type CreateWorkspaceOptions,
	createWorkspace,
	type DefineWorkspaceOptions,
	defineWorkspace,
	type LocalPersistence,
	type LocalPersistenceAttachment,
	type LocalWorkspace,
	satisfiesWorkspace,
	type Workspace,
	type WorkspaceActionContext,
	type WorkspaceDefinition,
	type WorkspaceFromDefinition,
	type WorkspaceTables,
} from './document/workspace.js';
