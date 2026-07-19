import type { SqliteValue } from '@epicenter/sqlite';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { createDocumentStore } from '../document-provider/persistence.js';
import { createRowDocumentRuntime } from '../document-provider/runtime/index.js';
import {
	isWorkspaceStorageMovedError,
	WORKSPACE_STORAGE_MOVED_ERROR_NAME,
} from './browser-runtime-protocol.js';
import {
	type DesktopRecordOperation,
	type DesktopRecordRequest,
	type DesktopWorkspaceResponse,
	decodeDesktopRecordResult,
	decodeDocumentBytes,
	desktopWorkspaceUrl,
	encodeDocumentBytes,
} from './desktop-protocol.js';
import type { WorkspaceHandle, WorkspaceTables } from './runtime.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

type DefinitionTables<TDefinition> =
	TDefinition extends WorkspaceDefinition<infer TTables> ? TTables : never;

type SurfaceOpenedMessage = {
	type: 'workspace-surface-opened';
	workspaceId: string;
	surfaceId: string;
	generation: number;
};

type DesktopRuntimeBroadcastChannel = {
	onmessage: ((event: MessageEvent<unknown>) => void) | null;
	postMessage(message: unknown): void;
	close(): void;
};

type BoundWorkspace = {
	definition: WorkspaceDefinition;
	handle: WorkspaceHandle<WorkspaceDefinition>;
	/** The one host open handshake; resolves with the ready handle. */
	opened: Promise<WorkspaceHandle<WorkspaceDefinition>>;
	/** Set once this surface was displaced; every later operation throws it. */
	moved: Error | undefined;
	/** Host-issued claim generation; larger generations are newer surfaces. */
	generation: number | undefined;
	invalidated: Promise<never>;
	markMoved(cause: Error, notify?: boolean): void;
	disposeDocuments(): Promise<void>;
};

export type CreateDesktopWorkspaceRuntimeOptions = {
	baseUrl?: string;
	fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	createBroadcastChannel?(
		name: string,
	): DesktopRuntimeBroadcastChannel | undefined;
	onRecordsChanged?(workspaceId: string): void;
	/**
	 * Fired once per workspace when this surface is displaced by a newer one
	 * (newest surface wins). The cause satisfies
	 * `isWorkspaceStorageMovedError`, so apps flip the same blocking moved
	 * screen the browser runtime uses.
	 */
	onBackgroundError?(cause: Error, workspaceId: string): void;
};

/**
 * Same-origin WebView client for one Bun-owned static workspace catalog.
 *
 * One runtime instance is one surface. Exactly one surface owns a workspace
 * at a time: opening it here displaces any older surface, and being displaced
 * rejects this runtime's pending and future operations for that workspace
 * with the named moved error. There is no cross-window data relay.
 */
export function createDesktopWorkspaceRuntime({
	baseUrl = location.origin,
	fetch: fetchInput = globalThis.fetch,
	createBroadcastChannel = defaultBroadcastChannel,
	onRecordsChanged = () => undefined,
	onBackgroundError = () => undefined,
}: CreateDesktopWorkspaceRuntimeOptions = {}) {
	const origin = new URL(baseUrl).origin;
	const surfaceId = crypto.randomUUID();
	const workspaces = new Map<string, BoundWorkspace>();
	// The channel carries exactly one lifecycle signal: a newer surface opened
	// a workspace, so a displaced sibling window can flip its moved screen
	// immediately instead of on its next rejected request.
	const surfaceChannel = createBroadcastChannel(
		'epicenter-desktop-workspace-surfaces',
	);
	let disposed = false;

	if (surfaceChannel) {
		surfaceChannel.onmessage = (event: MessageEvent<unknown>) => {
			const message = parseSurfaceOpenedMessage(event.data);
			if (!message || message.surfaceId === surfaceId) return;
			const bound = workspaces.get(message.workspaceId);
			if (
				!bound ||
				bound.moved ||
				message.generation <= (bound.generation ?? 0)
			) {
				return;
			}
			const moved = new Error(
				`Workspace '${message.workspaceId}' moved to a newer window`,
			);
			moved.name = WORKSPACE_STORAGE_MOVED_ERROR_NAME;
			bound.markMoved(moved);
		};
	}

	const request = async <TResult>(
		workspaceId: string,
		operation: DesktopRecordOperation,
	): Promise<TResult> => {
		assertOpen();
		const bound = workspaces.get(workspaceId);
		if (!bound) throw new Error(`Workspace '${workspaceId}' is not open`);
		if (bound.moved) throw bound.moved;
		const response = (async () => {
			const fetched = await fetchInput(
				desktopWorkspaceUrl(origin, workspaceId),
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({
						surfaceId,
						operation,
					} satisfies DesktopRecordRequest),
				},
			);
			const envelope = (await fetched.json()) as DesktopWorkspaceResponse;
			if (!fetched.ok || envelope.error !== null) {
				const failure = new Error(
					envelope.error?.message ?? `Desktop workspace HTTP ${fetched.status}`,
				);
				if (envelope.error?.name) failure.name = envelope.error.name;
				if (isWorkspaceStorageMovedError(failure)) {
					workspaces.get(workspaceId)?.markMoved(failure);
				}
				throw failure;
			}
			assertOpen();
			if (workspaces.get(workspaceId) !== bound || bound.moved) {
				throw bound.moved ?? new Error(`Workspace '${workspaceId}' is closed`);
			}
			if (
				operation.kind === 'create' ||
				operation.kind === 'update' ||
				operation.kind === 'delete' ||
				operation.kind === 'kv-set' ||
				operation.kind === 'kv-unset'
			) {
				onRecordsChanged(workspaceId);
			}
			return decodeDesktopRecordResult(operation, envelope.data) as TResult;
		})();
		return Promise.race([response, bound.invalidated]);
	};

	function assertOpen(): void {
		if (disposed) throw new Error('Desktop workspace runtime is disposed');
	}

	function createHandle<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
	): Omit<BoundWorkspace, 'definition' | 'opened'> & {
		handle: WorkspaceHandle<TDefinition>;
	} {
		const invalidated = Promise.withResolvers<never>();
		// A surface can remain current for its entire lifetime, so suppress the
		// process-level unhandled-rejection warning until a request races this
		// lifecycle promise.
		void invalidated.promise.catch(() => undefined);
		const documents = createRowDocumentRuntime({
			// The host owns the durable update log inside the workspace's
			// store.sqlite3; this surface carries only load and append over the
			// same-origin records route.
			store: createDocumentStore({
				async load(address) {
					const parts = await request<string[]>(definition.id, {
						kind: 'document-load',
						table: address.table,
						rowId: address.rowId,
					});
					return parts.map(decodeDocumentBytes);
				},
				async append(address, update) {
					await request<void>(definition.id, {
						kind: 'document-append',
						table: address.table,
						rowId: address.rowId,
						update: encodeDocumentBytes(update),
					});
				},
			}),
			isLive: async ({ table, rowId }) =>
				(await request<Record<string, unknown> | undefined>(definition.id, {
					kind: 'read-current-row',
					table,
					rowId,
				})) !== undefined,
		});
		const tables = Object.fromEntries(
			Object.keys(definition.tables).map((table) => [
				table,
				Object.freeze({
					get(id: string) {
						return request(definition.id, { kind: 'get', table, id });
					},
					list() {
						return request(definition.id, { kind: 'list', table });
					},
					create(input: Record<string, unknown>) {
						return request(definition.id, {
							kind: 'create',
							table,
							input,
						});
					},
					update(id: string, changes: Record<string, unknown>) {
						const set: Record<string, unknown> = {};
						const unset: string[] = [];
						for (const [name, value] of Object.entries(changes)) {
							if (value === undefined) unset.push(name);
							else set[name] = value;
						}
						return request(definition.id, {
							kind: 'update',
							table,
							id,
							set,
							unset,
						});
					},
					async delete(id: string) {
						await request<void>(definition.id, {
							kind: 'delete',
							table,
							id,
						});
						await documents.revoke({ table, rowId: id });
					},
					document: Object.freeze({
						open(rowId: string) {
							return documents.open({ table, rowId });
						},
					}),
				}),
			]),
		) as unknown as WorkspaceTables<DefinitionTables<TDefinition>>;

		const kv = Object.freeze({
			get(key: string) {
				return request(definition.id, { kind: 'kv-get', key });
			},
			set(key: string, value: unknown) {
				return request(definition.id, { kind: 'kv-set', key, value });
			},
			async unset(key: string) {
				await request<void>(definition.id, { kind: 'kv-unset', key });
			},
		});

		const handle = Object.freeze({
			id: definition.id,
			tables,
			kv: kv as never,
			async sql<TResultSchema extends TSchema>(
				query: string,
				parameters: readonly SqliteValue[],
				resultSchema: TResultSchema,
			): Promise<Static<TResultSchema>[]> {
				const rows = await request<unknown[]>(definition.id, {
					kind: 'sql',
					query,
					parameters,
				});
				for (const [index, row] of rows.entries()) {
					if (!Value.Check(resultSchema, row)) {
						throw new TypeError(
							`Desktop SQL row ${index} does not satisfy the result schema`,
						);
					}
				}
				return rows as Static<TResultSchema>[];
			},
		}) as unknown as WorkspaceHandle<TDefinition>;
		return {
			handle,
			moved: undefined,
			generation: undefined,
			invalidated: invalidated.promise,
			markMoved(cause: Error, notify = true) {
				const bound = workspaces.get(definition.id);
				if (!bound || bound.moved) return;
				bound.moved = cause;
				invalidated.reject(cause);
				void documents.revokeAll(cause);
				if (notify) onBackgroundError(cause, definition.id);
			},
			disposeDocuments: documents[Symbol.asyncDispose],
		};
	}

	return Object.freeze({
		/**
		 * Opens the workspace and resolves only after the host confirms its
		 * SQLite owner is acquired and this surface owns the workspace. A
		 * failed handshake rejects and unbinds, so a later `open` performs a
		 * fresh handshake against the host.
		 */
		open<TDefinition extends WorkspaceDefinition>(
			definition: TDefinition,
		): Promise<WorkspaceHandle<TDefinition>> {
			assertOpen();
			const existing = workspaces.get(definition.id);
			if (existing) {
				if (existing.definition !== definition) {
					throw new Error(
						`Workspace '${definition.id}' is already bound to another definition in this runtime`,
					);
				}
				return existing.opened as Promise<WorkspaceHandle<TDefinition>>;
			}
			const binding = createHandle(definition);
			const bound: BoundWorkspace = {
				definition,
				...binding,
				opened: undefined as never,
			};
			workspaces.set(definition.id, bound);
			bound.opened = request<number>(definition.id, { kind: 'open' }).then(
				(generation) => {
					bound.generation = generation;
					surfaceChannel?.postMessage({
						type: 'workspace-surface-opened',
						workspaceId: definition.id,
						surfaceId,
						generation,
					} satisfies SurfaceOpenedMessage);
					return binding.handle;
				},
				(cause) => {
					if (workspaces.get(definition.id) === bound) {
						workspaces.delete(definition.id);
					}
					throw cause;
				},
			);
			return bound.opened as Promise<WorkspaceHandle<TDefinition>>;
		},
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			const cause = new Error('Desktop workspace runtime is disposed');
			for (const bound of workspaces.values()) {
				bound.markMoved(cause, false);
			}
			surfaceChannel?.close();
			const failures: unknown[] = [];
			for (const bound of workspaces.values()) {
				try {
					await bound.disposeDocuments();
				} catch (failure) {
					failures.push(failure);
				}
			}
			workspaces.clear();
			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					'Desktop row-document disposal failed',
				);
			}
		},
	});
}

export type DesktopWorkspaceRuntime = ReturnType<
	typeof createDesktopWorkspaceRuntime
>;

function parseSurfaceOpenedMessage(
	value: unknown,
): SurfaceOpenedMessage | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const message = value as Record<string, unknown>;
	if (
		message.type !== 'workspace-surface-opened' ||
		typeof message.workspaceId !== 'string' ||
		typeof message.surfaceId !== 'string' ||
		typeof message.generation !== 'number' ||
		!Number.isSafeInteger(message.generation) ||
		message.generation < 1
	) {
		return undefined;
	}
	return {
		type: 'workspace-surface-opened',
		workspaceId: message.workspaceId,
		surfaceId: message.surfaceId,
		generation: message.generation,
	};
}

function defaultBroadcastChannel(
	name: string,
): DesktopRuntimeBroadcastChannel | undefined {
	return typeof BroadcastChannel === 'undefined'
		? undefined
		: new BroadcastChannel(name);
}
