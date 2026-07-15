/**
 * Workspace definitions and root Y.Doc construction.
 *
 * `defineWorkspace({ id, name, tables, kv })` is the app-facing entry point and
 * the one handle every runtime shares:
 *
 *   .create()            bare isomorphic doc for tests and advanced runtimes
 *   .connect(connection) local runtime: storage, optional sync, wipe, row
 *                        child-doc openers
 *
 * `createWorkspace({ id, tables, kv })` remains the low-level root constructor
 * for package internals and tests:
 *
 * ```ts
 * using workspace = createWorkspace({ id, tables, kv });
 * ```
 *
 * ## Storage
 *
 * Every table and the KV store are constructed as plaintext Yjs-backed
 * stores. The relay is trusted, so `createWorkspace` no longer derives or
 * activates client-side encryption keys.
 *
 * ## Disposal
 *
 * `using workspace` triggers `ydoc.destroy()`, which cascades through every
 * store's `ydoc.once('destroy', ...)` hook. No standalone dispose surface.
 *
 * ## Identity
 *
 * `options.id` is the identity input for both constructors, stamped onto the
 * Y.Doc as `guid`; `defineWorkspace` adds a display-only `name`. The app owns
 * its `id` namespace (e.g. `epicenter-fuji`), so this library never derives or
 * prefixes it. `workspace.ydoc.guid` is the canonical read, and downstream code
 * should read it rather than re-deriving the id.
 *
 * @module
 */

import { InstantString } from '@epicenter/field';
import { once } from 'wellcrafted/function';
import * as Y from 'yjs';
import { createDisposableCache } from '../cache/disposable-cache.js';
import { type ActionRegistry, defineActions } from '../shared/actions.js';
import type { Guid } from '../shared/id.js';
import { assertSafeSegment } from '../shared/safe-segment.js';
import { attachBroadcastChannel } from './attach-broadcast-channel.js';
import { attachIndexedDb } from './attach-indexed-db.js';
import { type ConnectionConfig, connectDoc } from './connect-doc.js';
import { docGuid } from './doc-guid.js';
import { KV_KEY, TableKey } from './keys.js';
import { createKv, type Kv, type KvDefinitions } from './kv.js';
import { onLocalUpdate } from './on-local-update.js';
import type { Collaboration } from './open-collaboration.js';
import { assertReferenceTargets } from './reference-check.js';
import {
	type BaseRow,
	type ChildDocDeclaration,
	type ChildDocDeclarations,
	createTable,
	type InferTableRow,
	type LayoutOf,
	type Table,
	type TableDefinition,
	type TableDefinitions,
	type Tables,
} from './table.js';
import { wipeBareStorage, wipeLocalStorage } from './wipe-local-storage.js';
import {
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index.js';

export type Workspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly ydoc: Y.Doc;
	readonly tables: WorkspaceTables<TTables>;
	readonly kv: Kv<TKv>;
	readonly actions: TActions;
	[Symbol.dispose](): void;
};

/**
 * `satisfies Workspace<...>` as a function: type-check a live workspace bundle
 * while preserving its exact inferred type.
 *
 * Use this when a runtime opener returns `{ ...workspace, ...runtimeExtras }`
 * and direct `satisfies Workspace<...>` would force the caller to restate table,
 * KV, action, or runtime generics that TypeScript can infer from the object.
 * Runtime behavior is identity: the same object is returned unchanged.
 */
export function satisfiesWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry,
	TWorkspace extends Workspace<TTables, TKv, TActions>,
>(workspace: TWorkspace): TWorkspace {
	return workspace;
}

export type CreateWorkspaceOptions<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	/**
	 * Stable workspace identifier. Stamped onto the Y.Doc as `guid`.
	 */
	id: string;

	/** Table definitions to materialize on the workspace root. */
	tables: TTables;

	/** KV definitions to materialize on the workspace root. Pass `{}` for none. */
	kv: TKv;
};

export type WorkspaceActionContext<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	readonly ydoc: Y.Doc;
	/**
	 * The root table handles, each carrying its `.docs.<field>.guid(rowId)`
	 * deriver. Action handlers close over the same guid-owning table path the
	 * rest of the workspace uses, so an action never re-derives a child-doc guid
	 * by hand. No `open`: actions run before any connection, so only the pure
	 * guid half is reachable here (the connected opener is layered later).
	 */
	readonly tables: WorkspaceTables<TTables>;
	readonly kv: Kv<TKv>;
};

export type DefineWorkspaceOptions<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry,
> = CreateWorkspaceOptions<TTables, TKv> & {
	/**
	 * Human-facing display label: the `${name}-*` materializer logger prefix and
	 * the "Sign in to enable <name>." message. A
	 * display name only, not an identity seed: it never feeds the guid, the node
	 * id, the Y.Doc `clientID`, or the action namespace, so the app's `id` owns
	 * the namespace and the `name` is free to be a friendly label.
	 */
	name: string;
	/**
	 * Build the action registry after tables and KV are live, so handlers can
	 * close over the handles they query or mutate.
	 */
	actions?: (workspace: WorkspaceActionContext<TTables, TKv>) => TActions;
};

type ChildDocHandle<TLayout extends (ydoc: Y.Doc) => object> =
	ReturnType<TLayout> & {
		readonly ydoc: Y.Doc;
		readonly guid: Guid;
		readonly whenLoaded: Promise<unknown>;
		readonly whenDisposed: Promise<unknown>;
		[Symbol.dispose](): void;
	};

/**
 * The guid-only entry every `.docs.<field>` exposes: derive a row's child-doc
 * guid without a connection. Pure (workspace id + table + row id + field), so it
 * is available on the unconnected root too, and any app-owned process derives
 * the same guid the browser opener uses.
 */
type RowDocGuid<TRowId extends string> = {
	guid(rowId: TRowId): Guid;
};

type RowChildDocCache<
	TRowId extends string,
	TLayout extends (ydoc: Y.Doc) => object,
> = RowDocGuid<TRowId> & {
	open(rowId: TRowId): ChildDocHandle<TLayout>;
};

/**
 * The guid-only `.docs` namespace present on every table handle, connected or
 * not. `{}` for a table that declared no child docs.
 */
type TableDocGuids<TTableDefinition extends TableDefinition<any, any>> =
	TTableDefinition extends TableDefinition<
		any,
		infer TDecls extends ChildDocDeclarations
	>
		? {
				[K in keyof TDecls]: RowDocGuid<InferTableRow<TTableDefinition>['id']>;
			}
		: {};

/**
 * The `.docs` namespace a connected table handle gains: one row child-doc cache
 * per declared layout, keyed by field name. Each entry adds `open(rowId)` to the
 * field's existing guid deriver. Lives one level below the table's CRUD methods,
 * so field names never collide with `set`, `open`, etc. Empty `{}` for a table
 * that declared no child docs. Teardown is owned by the workspace, not the
 * field: every cache cascades off the root `ydoc.destroy()`.
 */
type TableDocs<TTableDefinition extends TableDefinition<any, any>> =
	TTableDefinition extends TableDefinition<
		any,
		infer TDecls extends ChildDocDeclarations
	>
		? {
				[K in keyof TDecls]: RowChildDocCache<
					InferTableRow<TTableDefinition>['id'],
					LayoutOf<TDecls[K]>
				>;
			}
		: {};

/**
 * The root table map: each table handle plus its guid-only `.docs` namespace.
 * `defineWorkspace(...).connect(connection)` upgrades each `.docs.<field>` with
 * an `open(rowId)` opener (see {@link ConnectedTables}).
 */
export type WorkspaceTables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Tables<TTableDefinitions>[K] & {
		readonly docs: TableDocGuids<TTableDefinitions[K]>;
	};
};

export type ConnectedTables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Tables<TTableDefinitions>[K] & {
		readonly docs: TableDocs<TTableDefinitions[K]>;
	};
};

export type LocalPersistenceAttachment = {
	/** Resolves when persisted state has replayed into the doc. */
	readonly whenLoaded: Promise<unknown>;
	/** Resolves after the doc is destroyed and the storage handle is closed. */
	readonly whenDisposed: Promise<unknown>;
};

export type LocalPersistence = {
	/** Attach local storage to one doc: the root or a row child doc. */
	attach(ydoc: Y.Doc): LocalPersistenceAttachment;
	/** Remove every locally stored doc for one workspace guid family. */
	wipe(workspaceId: string): Promise<void>;
};

function browserLocalPersistence(): LocalPersistence {
	return {
		attach(ydoc) {
			attachBroadcastChannel(ydoc);
			return attachIndexedDb(ydoc);
		},
		wipe: wipeBareStorage,
	};
}

export type ConnectOptions<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry,
	TRuntime extends ConnectComposition,
> = {
	readonly persistence?: LocalPersistence;
	readonly compose?: (
		workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
	) => TRuntime;
};

/**
 * What a runtime `compose` callback sees: the connected workspace before its
 * infrastructure is soldered on. This is the one place `tables` is retyped from
 * guid-only ({@link WorkspaceTables}) to connected ({@link ConnectedTables}), so
 * every richer connected type builds additively on top of it instead of
 * re-omitting `tables` again.
 *
 * This is the connected workspace before infrastructure is attached, and it
 * also forms the base of {@link ConnectedWorkspace}. A runtime composer extends
 * this value directly.
 */
export type ConnectedWorkspaceContext<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = Omit<Workspace<TTables, TKv, TActions>, 'tables'> & {
	readonly tables: ConnectedTables<TTables>;
};

/**
 * The signed-in workspace `connect(connection)` returns: the connected context
 * plus its soldered-on infrastructure (local persistence, the collaboration
 * relay, and `wipe()`). Defined as `context + infra` to mirror
 * what `connect()` does at runtime: take the context, bolt on the connection
 * handles.
 */
export type ConnectedWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = ConnectedWorkspaceContext<TTables, TKv, TActions> & {
	readonly storage: ReturnType<typeof connectDoc>['idb'];
	readonly collaboration: Collaboration;
	wipe(): Promise<void>;
};

/**
 * What a `connect(connection, compose)` runtime builder returns: the final action
 * registry plus any runtime-only handles the app wants on the bundle.
 *
 * `actions` is required, not optional: a runtime builder is exactly where
 * browser-only actions get layered onto the base registry, and that returned
 * registry is the one the bundle exposes as its actions. Returning
 * `{ actions: workspace.actions }` (the base, unchanged) is the explicit way to
 * say "no new actions" — there is no implicit fallback to guess at.
 */
export type ConnectComposition<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly actions: TActions;
	[Symbol.dispose]?(): void;
};

type ConnectedWorkspaceWithRuntime<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TRuntime extends ConnectComposition,
> = ConnectedWorkspace<TTables, TKv, TRuntime['actions']> &
	Omit<TRuntime, 'actions' | typeof Symbol.dispose>;

/**
 * The local-first workspace `connect(null)` returns: the connected context
 * (child-doc openers included) plus bare local infrastructure and `wipe()`,
 * with no relay. Browser callers use guid-named IndexedDB plus the cross-tab
 * BroadcastChannel by default; Bun callers can inject disk persistence.
 * `collaboration` is a literal `undefined` field so a
 * `LocalWorkspace | ConnectedWorkspace` union narrows on it and shared UI
 * (the account popover's sync surface) can take `collaboration` optionally.
 */
export type LocalWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = ConnectedWorkspaceContext<TTables, TKv, TActions> & {
	readonly storage: LocalPersistenceAttachment;
	readonly collaboration: undefined;
	wipe(): Promise<void>;
};

type LocalWorkspaceWithRuntime<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TRuntime extends ConnectComposition,
> = LocalWorkspace<TTables, TKv, TRuntime['actions']> &
	Omit<TRuntime, 'actions' | typeof Symbol.dispose>;

export type WorkspaceDefinition<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly id: string;
	readonly tables: TTables;
	readonly kv: TKv;
	create(): Workspace<TTables, TKv, TActions>;
	connect(
		connection: ConnectionConfig | null,
	):
		| LocalWorkspace<TTables, TKv, TActions>
		| ConnectedWorkspace<TTables, TKv, TActions>;
	connect(
		connection: null,
		options: ConnectOptions<
			TTables,
			TKv,
			TActions,
			{ readonly actions: TActions }
		>,
	): LocalWorkspace<TTables, TKv, TActions>;
	connect<TRuntime extends ConnectComposition>(
		connection: ConnectionConfig | null,
		compose: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => TRuntime,
	):
		| LocalWorkspaceWithRuntime<TTables, TKv, TRuntime>
		| ConnectedWorkspaceWithRuntime<TTables, TKv, TRuntime>;
	connect<TRuntime extends ConnectComposition>(
		connection: null,
		options: ConnectOptions<TTables, TKv, TActions, TRuntime>,
	): LocalWorkspaceWithRuntime<TTables, TKv, TRuntime>;
};

/** The unconnected root workspace returned by `definition.create()`. */
export type WorkspaceFromDefinition<TDefinition> =
	TDefinition extends WorkspaceDefinition<
		infer TTables,
		infer TKv,
		infer TActions
	>
		? Workspace<TTables, TKv, TActions>
		: never;

/**
 * The context a definition's `connect` compose callback receives. The one
 * honest spelling for a named compose function:
 *
 * ```ts
 * function compose(workspace: ComposeContext<typeof myAppWorkspace>) { ... }
 * ```
 *
 * An inline compose arrow infers this contextually and never needs it.
 */
export type ComposeContext<TDefinition> =
	TDefinition extends WorkspaceDefinition<
		infer TTables,
		infer TKv,
		infer TActions
	>
		? ConnectedWorkspaceContext<TTables, TKv, TActions>
		: never;

/**
 * Build a fully wired workspace bundle:
 * `{ ydoc, tables, kv, actions, [Symbol.dispose] }`.
 *
 * Step by step:
 *   1. Construct `new Y.Doc({ guid: id, gc: true })`.
 *   2. For each table definition and for the KV slot: build a YKV store
 *      over `ydoc.getArray(...)`, hook `ydoc.once('destroy', dispose)`,
 *      and return the bare plaintext store.
 *   3. Wrap with `createTable` / `createKv` for the typed surfaces.
 *   4. `[Symbol.dispose]()` calls `ydoc.destroy()`, which fires every
 *      registered destroy hook in turn.
 */
export function createWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(options: CreateWorkspaceOptions<TTables, TKv>): Workspace<TTables, TKv, {}> {
	assertSafeSegment(options.id, 'workspace id');
	// Referential floor: every field.reference(table) column must name a table defined in
	// this same workspace. Throws here so a dangling target fails at construction, not
	// silently at query time. A no-op unless a table actually uses field.reference().
	assertReferenceTargets(options.tables);
	const ydoc = new Y.Doc({
		guid: options.id,
		gc: true,
	});

	/**
	 * Build one store for a single workspace slot (one table, or the KV
	 * singleton). Each store is a bare YKV over a raw `Y.Array`.
	 *
	 * Every store hooks `ydoc.once('destroy', ...)` so a single `ydoc.destroy()`
	 * (triggered by `using` scope exit or an explicit
	 * `[Symbol.dispose]()`) cascades through every store.
	 */
	function attachStore(arrayKey: string): ObservableKvStore<unknown> {
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(arrayKey);
		const ykv = new YKeyValueLww<unknown>(yarray);
		ydoc.once('destroy', () => ykv[Symbol.dispose]());
		return ykv;
	}

	const tables = Object.fromEntries(
		Object.entries(options.tables).map(([name, definition]) => {
			const table = createTable(attachStore(TableKey(name)), definition, name);
			// `.docs` carries one guid deriver per declared child-doc field, so the
			// workspace owns guid derivation end-to-end. The connected opener layers
			// `open(rowId)` onto these same entries (see `connectTableChildDocs`).
			const docs = Object.fromEntries(
				Object.keys(definition.docDecls).map((field) => [
					field,
					{
						guid: (rowId: string): Guid =>
							docGuid({
								workspaceId: options.id,
								collection: name,
								rowId,
								field,
							}),
					},
				]),
			);
			return [name, { ...table, docs }];
		}),
	) as WorkspaceTables<TTables>;

	const kv = createKv(attachStore(KV_KEY), options.kv);

	return satisfiesWorkspace({
		ydoc,
		tables,
		kv,
		actions: defineActions({}),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	});
}

/**
 * Define an isomorphic workspace model, then construct or connect it.
 *
 * `create()` constructs; `connect()` connects:
 *
 *   create()                     Bare root: Y.Doc + tables + KV + actions. No
 *                                persistence, no sync, no child-doc openers.
 *   connect(connection | null)   The browser preset. The connection IS the boot
 *                                decision (ADR-0088/ADR-0094): credentials wire
 *                                principal-scoped IndexedDB plus the WebSocket relay
 *                                (see `connectDoc`); `null` wires guid-named
 *                                IndexedDB plus the cross-tab channel with no
 *                                relay (`collaboration: undefined`, the union's
 *                                discriminant). Both wirings return the same
 *                                bundle shape: per-row child-doc openers
 *                                (`tables.notes.docs.body.open(rowId)`) and
 *                                `wipe()` included, so nothing downstream
 *                                branches on auth again.
 *   connect(connection, compose) The preset plus a runtime layer. `compose` runs
 *                                after the doc and child docs are built but
 *                                before infrastructure wires, so the action
 *                                registry it returns is the one the bundle
 *                                exposes (and, signed in, the one the relay
 *                                serves). That ordering is why `compose` is a
 *                                callback here, not a step you run after
 *                                `connect()`.
 * `connect()` is `create()` plus the browser storage/transport bundle
 * (`connectTableChildDocs` + relay or bare wiring).
 */
export function defineWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = {},
>(
	options: DefineWorkspaceOptions<TTables, TKv, TActions>,
): WorkspaceDefinition<TTables, TKv, TActions> {
	/**
	 * Bare root: Y.Doc + tables + KV + actions. No persistence, no sync, no
	 * child-doc openers. Tests and specialized runtimes may attach their own
	 * storage or transport around it.
	 *
	 * `createWorkspace` builds the doc, tables, and KV with an empty action
	 * registry; the action builder closes over that live root and the result is
	 * merged back onto the same object (which already owns `[Symbol.dispose]`).
	 * `connect()` reuses this as its root, so the action registry has exactly one
	 * construction site.
	 */
	function create(): Workspace<TTables, TKv, TActions> {
		const root = createWorkspace({
			id: options.id,
			tables: options.tables,
			kv: options.kv,
		});
		const actions =
			options.actions === undefined ? ({} as TActions) : options.actions(root);
		return satisfiesWorkspace({ ...root, actions });
	}

	function connect(
		connection: ConnectionConfig | null,
	):
		| LocalWorkspace<TTables, TKv, TActions>
		| ConnectedWorkspace<TTables, TKv, TActions>;
	function connect(
		connection: null,
		connectOptions: ConnectOptions<
			TTables,
			TKv,
			TActions,
			{ readonly actions: TActions }
		>,
	): LocalWorkspace<TTables, TKv, TActions>;
	function connect<TRuntime extends ConnectComposition>(
		connection: ConnectionConfig | null,
		compose: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => TRuntime,
	):
		| LocalWorkspaceWithRuntime<TTables, TKv, TRuntime>
		| ConnectedWorkspaceWithRuntime<TTables, TKv, TRuntime>;
	function connect<TRuntime extends ConnectComposition>(
		connection: null,
		connectOptions: ConnectOptions<TTables, TKv, TActions, TRuntime>,
	): LocalWorkspaceWithRuntime<TTables, TKv, TRuntime>;
	function connect(
		connection: ConnectionConfig | null,
		connectOptions:
			| ((
					workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
			  ) => ConnectComposition)
			| ConnectOptions<TTables, TKv, TActions, ConnectComposition> = {},
	) {
		const workspace = create();
		const localPersistence =
			typeof connectOptions === 'function'
				? browserLocalPersistence()
				: (connectOptions.persistence ?? browserLocalPersistence());
		const childStorageDisposals: Promise<unknown>[] = [];
		const compose: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => ConnectComposition =
			typeof connectOptions === 'function'
				? connectOptions
				: (connectOptions.compose ??
					((workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>) => ({
						actions: workspace.actions,
					})));

		// Connect the per-row child-doc openers, then run the caller's composer,
		// then solder infrastructure on. compose sees live tables/ydoc and the
		// base actions (carried on `workspace.actions`); the `actions` it returns
		// is the final local registry exposed on the workspace bundle. Omitting
		// compose serves the base actions unchanged. The child-doc caches cascade
		// off the root `ydoc.destroy()`; each opened body's storage disposal is
		// still registered here so `wipe()` can wait before deleting the guid
		// family from disk.
		const tables = connectTableChildDocs({
			ydoc: workspace.ydoc,
			tables: workspace.tables,
			definitions: options.tables,
			connection,
			localPersistence,
			registerChildStorage: (storage) => {
				childStorageDisposals.push(storage.whenDisposed);
			},
		});
		const runtime = compose({ ...workspace, tables });

		// `dispose` is reachable twice: `wipe()` calls it explicitly, then a `using`
		// binding calls it again at scope exit. Neither callee is safe to run twice
		// on its own (the app's `runtime[Symbol.dispose]` is arbitrary, and
		// `ydoc.destroy()` re-emits `destroy` on every call), so `once` collapses
		// the whole teardown to a single run.
		const dispose = once(() => {
			runtime[Symbol.dispose]?.();
			workspace[Symbol.dispose]();
		});

		// The connection is the boot decision (ADR-0094): `null` wires the bare
		// local infrastructure through the local persistence environment, with no
		// relay; credentials wire principal-scoped storage plus the relay. Both
		// arms return the same bundle shape, discriminated by `collaboration`.
		if (connection === null) {
			const storage = localPersistence.attach(workspace.ydoc);
			return satisfiesWorkspace({
				...workspace,
				...runtime,
				tables,
				actions: runtime.actions,
				storage,
				collaboration: undefined,
				async wipe() {
					dispose();
					await Promise.all([storage.whenDisposed, ...childStorageDisposals]);
					await localPersistence.wipe(options.id);
				},
				[Symbol.dispose]: dispose,
			});
		}

		const { idb, collaboration } = connectDoc(workspace.ydoc, connection);
		return satisfiesWorkspace({
			...workspace,
			...runtime,
			tables,
			actions: runtime.actions,
			storage: idb,
			collaboration,
			async wipe() {
				dispose();
				await Promise.all([
					idb.whenDisposed,
					collaboration.whenDisposed,
					...childStorageDisposals,
				]);
				await wipeLocalStorage({
					server: new URL(connection.baseURL).host,
					principalId: connection.principalId,
				});
			},
			[Symbol.dispose]: dispose,
		});
	}

	return {
		id: options.id,
		tables: options.tables,
		kv: options.kv,
		create,
		connect,
	};
}

/**
 * The bound child-doc runtime: give every declared `table.docs({ field })`
 * a connected `open(rowId)` opener layered onto the field's existing guid
 * deriver.
 *
 * A collaborative body (a chat transcript, a prose note, a code snippet) is its
 * own synced `Y.Doc`. Three concerns recur every time an app opens one, and this
 * function owns all three so apps declare only the shape:
 *
 *  - **lifecycle**: same `rowId` -> one shared `Y.Doc`; N opens require N
 *    disposes; a grace window survives route/pane swaps. One
 *    {@link createDisposableCache} per `(table, field)`, keyed by `rowId`.
 *  - **connection**: local IndexedDB persistence + cloud sync via the same
 *    {@link connectDoc} wiring the root uses. Sync is opened for its side
 *    effect; the `collaboration` handle is intentionally orphaned, and teardown
 *    cascades from `ydoc.destroy()` when the cache evicts the entry.
 *  - **shape**: the CRDT layout and its writer policy, owned by the declared
 *    `attach*(ydoc)` function (`attachPlainText`, `attachRichText`,
 *    `attachRecords`).
 *
 * The guid is only the room address: the cache keys by `rowId`, and the address
 * is derived through the field's existing {@link RowDocGuid} so derivation stays
 * single-owner (`createWorkspace`'s `.docs` loop), never re-grammared here.
 *
 * Teardown mirrors how the root's own stores release: each cache registers on
 * `ydoc.once('destroy', ...)`, so a single root `ydoc.destroy()` flushes every
 * child-doc cache alongside the tables and KV. The connected root also records
 * each opened body's storage disposal so `wipe()` can wait for child docs before
 * deleting the persisted guid family.
 */
function connectTableChildDocs<TTableDefinitions extends TableDefinitions>({
	ydoc,
	tables,
	definitions,
	connection,
	localPersistence,
	registerChildStorage,
}: {
	ydoc: Y.Doc;
	tables: WorkspaceTables<TTableDefinitions>;
	definitions: TTableDefinitions;
	/**
	 * Connection coordinates, or `null` for the bare local-first wiring:
	 * injected local persistence and no relay.
	 */
	connection: ConnectionConfig | null;
	localPersistence: LocalPersistence;
	registerChildStorage: (storage: LocalPersistenceAttachment) => void;
}): ConnectedTables<TTableDefinitions> {
	const connectedTables: Record<string, unknown> = {};

	for (const [collection, table] of Object.entries(tables)) {
		const definition = definitions[collection as keyof TTableDefinitions]!;
		const guidDerivers = table.docs as Record<string, RowDocGuid<string>>;
		// A body's only cross-doc writer: a local edit stamps a declared instant
		// column on the row. Read through `Table<BaseRow>` (not a hand-written
		// `{ update }` shape): `Object.entries` erased the per-table row type, and
		// the base-row view's `update` accepts a `Partial<{}>` patch, which is
		// exactly the dynamic `{ [touch]: instant }` we build here. `touch` is
		// checked against the real row type at the `.docs(...)` call site. The
		// returned `Result` is intentionally dropped: a recency bump is best-effort
		// and a rejected patch must not break the edit it followed.
		const { update: updateRow } = table as Table<BaseRow>;
		const docs: Record<string, unknown> = {};

		for (const [field, declaration] of Object.entries(definition.docDecls) as [
			string,
			ChildDocDeclaration,
		][]) {
			// Normalize the two declaration forms once: a bare layout function is
			// sugar for `{ layout, touch: undefined }`.
			const { layout, touch } =
				typeof declaration === 'function'
					? { layout: declaration, touch: undefined }
					: declaration;
			// Reuse the guid deriver the unconnected root already built for this
			// field, so derivation stays single-owner (`createWorkspace`'s `.docs`
			// loop). The cache keys by `rowId`; the guid is only the room address.
			const guidEntry = guidDerivers[field]!;
			const cache = createDisposableCache((rowId: string) => {
				const guid = guidEntry.guid(rowId);
				const bodyDoc = new Y.Doc({ guid, gc: true });
				// wiring the root uses (no action registry: the body's only writers
				// are the `attach*` layout and the server generation worker streaming
				// in); bare, it gets the same injected local persistence the bare root
				// gets.
				let storage: LocalPersistenceAttachment;
				if (connection) {
					({ idb: storage } = connectDoc(bodyDoc, connection));
				} else {
					storage = localPersistence.attach(bodyDoc);
				}
				registerChildStorage(storage);
				// Recency: a local edit bumps a column on the row. One observer per
				// shared body Y.Doc (built here, not per `open`), torn down on
				// eviction. `tx.local` scopes it to local edits, so remote/hydrated
				// updates never bump the row; writing the root row can't re-trigger
				// this child-doc observer, so there is no loop.
				const offLocalEdit = touch
					? onLocalUpdate(bodyDoc, () =>
							updateRow(rowId, { [touch]: InstantString.now() }),
						)
					: undefined;
				return {
					...layout(bodyDoc),
					/** The underlying Y.Doc, exposed for runtime attachments. */
					ydoc: bodyDoc,
					/** The doc's guid (its room id). */
					guid,
					/** Resolves when local storage state has replayed into the doc. */
					whenLoaded: storage.whenLoaded,
					/** Resolves after the body doc has destroyed its storage handle. */
					whenDisposed: storage.whenDisposed,
					[Symbol.dispose]() {
						offLocalEdit?.();
						bodyDoc.destroy();
					},
				};
			});
			// Flush this field's cache when the root doc is destroyed, exactly as
			// `createWorkspace` releases each table/KV store. The root never holds
			// these body docs as subdocs, so the hook is what cascades teardown.
			ydoc.once('destroy', () => cache[Symbol.dispose]());
			// The connected handle only ADDS `open(rowId)` to the field's existing
			// guid deriver; `open(rowId)` keys the cache by `rowId` directly.
			docs[field] = {
				...guidEntry,
				open(rowId: string) {
					return cache.open(rowId);
				},
			};
		}

		connectedTables[collection] = {
			...table,
			docs,
		};
	}

	return connectedTables as ConnectedTables<TTableDefinitions>;
}
