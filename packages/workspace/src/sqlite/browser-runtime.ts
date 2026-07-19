import { sha256Hex } from '@epicenter/row-sync';
import type { SqliteValue } from '@epicenter/sqlite';
import type { Static, TSchema } from 'typebox';
import {
	attachAuthenticatedDocumentConnection,
	type DocumentConnection,
	rowDocumentWebSocketUrl,
} from '../document-provider/connection/index.js';
import { createDocumentStore } from '../document-provider/persistence.js';
import { createRowDocumentRuntime } from '../document-provider/runtime/index.js';

import {
	accountBrowserPersistenceKey,
	deviceBrowserPersistenceKey,
	type WorkspaceAccount,
} from './account-runtime.js';
import {
	type BrowserRecordOperation,
	type BrowserRowSyncBinding,
	type BrowserRuntimeMessage,
	type BrowserRuntimeRequest,
	type BrowserWorkspaceManifest,
	serializeTableLenses,
} from './browser-runtime-protocol.js';
import type {
	LogicalWorkspaceCopy,
	LogicalWorkspaceExport,
} from './canonical-addition.js';
import type {
	WorkspaceSync,
	WorkspaceSyncSettlement,
	WorkspaceSyncStatus,
} from './canonical-sync-supervisor.js';
import { CurrentStateTransportInterruption } from './current-state-transport.js';
import type { WorkspaceHandle, WorkspaceTables } from './runtime.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

type DefinitionTables<TDefinition> =
	TDefinition extends WorkspaceDefinition<infer TTables> ? TTables : never;

type PendingRequest = {
	resolve(value: unknown): void;
	reject(cause: unknown): void;
};

type BoundWorkspace = {
	definition: WorkspaceDefinition;
	manifest: BrowserWorkspaceManifest;
	handle: WorkspaceHandle<WorkspaceDefinition>;
	/** The one storage-opening attempt; resolves with the ready handle. */
	opened: Promise<WorkspaceHandle<WorkspaceDefinition>>;
	notifyRowsDeleted(addresses: RowAddress[]): void;
	notifySyncStatus(status: WorkspaceSyncStatus): void;
	notifyReady(): void;
	waitUntilReady(): Promise<void>;
	rejectReadiness(cause: Error): void;
	revokeDocuments(cause: Error): Promise<void>;
	captureDurability(): Promise<void>;
	disposeDocuments(): Promise<void>;
	importDocuments(copy: LogicalWorkspaceCopy): Promise<void>;
};

type RowAddress = { table: string; rowId: string };

type InvalidationMessage = { type: 'records-changed'; workspaceId: string };

type BrowserRecordFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

type RuntimeBroadcastChannel = {
	onmessage: ((event: MessageEvent<unknown>) => void) | null;
	postMessage(message: unknown): void;
	close(): void;
};

export type BrowserWorkspaceTransport = {
	baseUrl: string;
	fetch?: BrowserRecordFetch;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	headers?: Readonly<Record<string, string>>;
	credentials?: RequestCredentials;
	/** Scalar poll cadence override; production keeps the 30s default. */
	pollIntervalMs?: number;
};

export type BrowserWorkspaceAccount =
	WorkspaceAccount<BrowserWorkspaceTransport>;

type CreateBrowserWorkspaceRuntimeOptions = {
	persistenceKey: string;
	transport?: BrowserWorkspaceTransport;
	createBroadcastChannel?(name: string): RuntimeBroadcastChannel | undefined;
	onRecordsChanged?(workspaceId: string): void;
	onBackgroundError?(cause: Error, workspaceId: string): void;
};

export function createDeviceBrowserWorkspaceRuntime({
	createBroadcastChannel,
	onRecordsChanged,
	onBackgroundError,
}: Omit<
	CreateBrowserWorkspaceRuntimeOptions,
	'persistenceKey' | 'transport'
> = {}) {
	const runtime = createBrowserRuntimeWithPersistence({
		persistenceKey: deviceBrowserPersistenceKey(),
		createBroadcastChannel,
		onRecordsChanged,
		onBackgroundError,
	});
	return Object.freeze({
		open: runtime.open,
		async capture(definition: WorkspaceDefinition) {
			await runtime.open(definition);
			await runtime.captureDurability(definition.id);
			return runtime.captureLocal(definition.id);
		},
		/** A Device export is the local capture; there is no authority to settle. */
		async export(
			definition: WorkspaceDefinition,
		): Promise<LogicalWorkspaceExport> {
			await runtime.open(definition);
			await runtime.captureDurability(definition.id);
			return {
				settlement: null,
				...(await runtime.captureLocal(definition.id)),
			};
		},
		async delete(definition: WorkspaceDefinition) {
			await runtime.open(definition);
			return runtime.deleteLocal(definition.id);
		},
		[Symbol.asyncDispose]: runtime[Symbol.asyncDispose],
	});
}

export function createAccountBrowserWorkspaceRuntime({
	account,
	createBroadcastChannel,
	onRecordsChanged,
	onBackgroundError,
}: Omit<
	CreateBrowserWorkspaceRuntimeOptions,
	'persistenceKey' | 'transport'
> & {
	account: BrowserWorkspaceAccount;
}) {
	const runtime = createBrowserRuntimeWithPersistence({
		persistenceKey: accountBrowserPersistenceKey(account),
		transport: account.transport,
		createBroadcastChannel,
		onRecordsChanged,
		onBackgroundError,
	});
	return Object.freeze({
		open: runtime.open,
		async add(definition: WorkspaceDefinition, copy: LogicalWorkspaceCopy) {
			await runtime.open(definition);
			await runtime.whenReady(definition.id);
			return runtime.addToAccount(definition.id, copy);
		},
		async export(
			definition: WorkspaceDefinition,
		): Promise<LogicalWorkspaceExport> {
			await runtime.open(definition);
			return runtime.exportAccount(definition.id);
		},
		[Symbol.asyncDispose]: runtime[Symbol.asyncDispose],
	});
}

/** Create the page-side client for one OPFS-owning records Worker. */
function createBrowserRuntimeWithPersistence({
	persistenceKey,
	transport: transportInput,
	createBroadcastChannel = defaultBroadcastChannel,
	onRecordsChanged = () => undefined,
	onBackgroundError = () => undefined,
}: CreateBrowserWorkspaceRuntimeOptions) {
	if (persistenceKey.length === 0) {
		throw new Error('Workspace persistence key must not be empty');
	}
	const persistenceHash = sha256Hex(persistenceKey);
	const transport = normalizeTransport(transportInput);
	const pending = new Map<number, PendingRequest>();
	const workspaces = new Map<string, BoundWorkspace>();
	const invalidationChannel = createBroadcastChannel(
		`epicenter-${persistenceHash}-records`,
	);
	let requestId = 0;
	let isDisposed = false;
	let worker: Worker | undefined;
	let workerFailure: Error | undefined;
	let ready: ReturnType<typeof Promise.withResolvers<void>> | undefined;

	function assertOpen(): void {
		if (isDisposed) throw new Error('Browser workspace runtime is disposed');
	}

	function emitRecordsChanged(workspaceId: string, broadcast: boolean): void {
		if (broadcast) {
			invalidationChannel?.postMessage({
				type: 'records-changed',
				workspaceId,
			} satisfies InvalidationMessage);
		}
		onRecordsChanged(workspaceId);
	}

	if (invalidationChannel) {
		invalidationChannel.onmessage = (event: MessageEvent<unknown>) => {
			if (!isInvalidationMessage(event.data)) return;
			const message = event.data;
			if (!workspaces.has(message.workspaceId)) return;
			emitRecordsChanged(message.workspaceId, false);
		};
	}

	function recordsWorker(): {
		worker: Worker;
		ready: ReturnType<typeof Promise.withResolvers<void>>;
	} {
		assertOpen();
		if (workerFailure) throw workerFailure;
		if (worker && ready) return { worker, ready };
		ready = Promise.withResolvers<void>();
		worker = new Worker(
			new URL('./browser-runtime-worker.ts', import.meta.url),
			{ type: 'module', name: `epicenter-${persistenceHash}` },
		);
		const ownedWorker = worker;
		const ownedReady = ready;
		ownedWorker.addEventListener(
			'message',
			(event: MessageEvent<BrowserRuntimeMessage>) => {
				const message = event.data;
				switch (message.type) {
					case 'ready':
						ownedReady.resolve();
						return;
					case 'records-changed':
						emitRecordsChanged(message.workspaceId, true);
						return;
					case 'rows-deleted':
						workspaces
							.get(message.workspaceId)
							?.notifyRowsDeleted(message.addresses);
						return;
					case 'sync-status':
						workspaces
							.get(message.workspaceId)
							?.notifySyncStatus(message.status);
						return;
					case 'background-error': {
						const cause = new Error(message.message);
						cause.name = message.name;
						onBackgroundError(cause, message.workspaceId);
						return;
					}
					case 'transport-request':
						void proxyRecordTransport(ownedWorker, message);
						return;
					case 'result':
						pending.get(message.id)?.resolve(message.value);
						pending.delete(message.id);
						return;
					case 'error': {
						const cause = new Error(message.message);
						cause.name = message.name;
						pending.get(message.id)?.reject(cause);
						pending.delete(message.id);
						return;
					}
					default:
						message satisfies never;
				}
			},
		);
		ownedWorker.addEventListener('error', (event) => {
			const cause = new Error(
				event.message || 'Browser workspace Worker failed',
			);
			workerFailure = cause;
			ownedReady.reject(cause);
			for (const request of pending.values()) request.reject(cause);
			pending.clear();
		});
		return { worker: ownedWorker, ready: ownedReady };
	}

	async function proxyRecordTransport(
		ownedWorker: Worker,
		message: Extract<BrowserRuntimeMessage, { type: 'transport-request' }>,
	): Promise<void> {
		try {
			if (!transport) {
				throw new Error('Browser workspace transport is not bound');
			}
			let response: Response;
			try {
				response = await transport.fetch(
					new URL(
						`api/workspaces/${encodeURIComponent(message.workspaceId)}/records/${message.action}`,
						transport.baseUrl,
					),
					{
						method: 'POST',
						headers: {
							...transport.headers,
							'content-type': 'application/json',
						},
						credentials: transport.credentials,
						body: JSON.stringify(message.body),
					},
				);
			} catch (cause) {
				throw new CurrentStateTransportInterruption(
					'offline',
					'Record authority is unreachable',
					{ cause },
				);
			}
			const body = await response.text();
			if (!response.ok) {
				if (response.status === 401 || response.status === 403) {
					throw new CurrentStateTransportInterruption(
						'authentication',
						`Record authority rejected authentication (${response.status})`,
					);
				}
				if (
					response.status === 408 ||
					response.status === 425 ||
					response.status === 429 ||
					response.status >= 500
				) {
					throw new CurrentStateTransportInterruption(
						'retrying',
						`Record authority is temporarily unavailable (${response.status})`,
					);
				}
				throw new Error(`Record sync HTTP ${response.status}: ${body}`);
			}
			let value: unknown;
			try {
				value = body === '' ? null : JSON.parse(body);
			} catch (cause) {
				throw new Error(
					`Record sync returned non-JSON HTTP ${response.status}`,
					{ cause },
				);
			}
			if (!isDisposed) {
				ownedWorker.postMessage({
					type: 'transport-result',
					transportId: message.transportId,
					value,
				});
			}
		} catch (cause) {
			if (!isDisposed) {
				ownedWorker.postMessage({
					type: 'transport-error',
					transportId: message.transportId,
					name: cause instanceof Error ? cause.name : 'Error',
					message: cause instanceof Error ? cause.message : String(cause),
					...(cause instanceof CurrentStateTransportInterruption
						? { pendingReason: cause.reason }
						: {}),
				});
			}
		}
	}

	function request<TResult>(
		manifest: BrowserWorkspaceManifest,
		operation: BrowserRecordOperation,
	): Promise<TResult> {
		assertOpen();
		const owner = recordsWorker();
		const send = (): Promise<TResult> => {
			assertOpen();
			const id = ++requestId;
			return new Promise<TResult>((resolve, reject) => {
				pending.set(id, {
					resolve(value) {
						resolve(value as TResult);
					},
					reject,
				});
				owner.worker.postMessage({
					id,
					manifest,
					operation,
				} satisfies BrowserRuntimeRequest);
			});
		};
		// Always chain on readiness, even once resolved: `then` callbacks run
		// in registration order, so every request posts in invocation order. A
		// ready-state fast path would let a post-ready request overtake one
		// still parked on this promise from before readiness.
		return owner.ready.promise.then(send);
	}

	function createHandle<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
		manifest: BrowserWorkspaceManifest,
	) {
		const rowsDeletedListeners = new Set<(addresses: RowAddress[]) => void>();
		const syncStatusListeners = new Set<
			(status: WorkspaceSyncStatus) => void
		>();
		let syncStatus: WorkspaceSyncStatus = { phase: 'syncing' };
		let isReady = manifest.rowSync === undefined;
		const readinessWaiters = new Set<
			ReturnType<typeof Promise.withResolvers<void>>
		>();

		function notifyReady(): void {
			if (isReady) return;
			isReady = true;
			for (const waiter of readinessWaiters) waiter.resolve();
			readinessWaiters.clear();
		}

		function markNotReady(): void {
			isReady = false;
		}

		function rejectReadiness(cause: Error): void {
			for (const waiter of readinessWaiters) waiter.reject(cause);
			readinessWaiters.clear();
		}

		function waitUntilReady(): Promise<void> {
			if (isReady) return Promise.resolve();
			if (syncStatus.phase === 'recovery-required') {
				return Promise.reject(new Error('Workspace requires lineage recovery'));
			}
			if (syncStatus.phase === 'upgrade-required') {
				return Promise.reject(
					new Error('Workspace protocol requires an upgrade'),
				);
			}
			const waiter = Promise.withResolvers<void>();
			readinessWaiters.add(waiter);
			return waiter.promise;
		}

		function getKv(key: string) {
			return request(manifest, { kind: 'kv-get', key });
		}

		function notifyRowsDeleted(addresses: RowAddress[]): void {
			for (const listener of rowsDeletedListeners) listener(addresses);
		}

		function notifySyncStatus(status: WorkspaceSyncStatus): void {
			syncStatus = status;
			if (status.phase === 'caught-up') notifyReady();
			if (status.phase === 'recovery-required') {
				rejectReadiness(new Error('Workspace requires lineage recovery'));
			}
			if (status.phase === 'upgrade-required') {
				rejectReadiness(new Error('Workspace protocol requires an upgrade'));
			}
			for (const listener of syncStatusListeners) listener(status);
		}

		const documents = createRowDocumentRuntime<DocumentConnection>({
			// The Worker owns the durable update log inside the same OPFS SQLite
			// store as scalar state; the page carries only load and append across
			// the message boundary, so a storage steal rejects document work the
			// same way it rejects scalar work.
			store: createDocumentStore({
				load: (address) =>
					request<readonly Uint8Array[]>(manifest, {
						kind: 'document-load',
						table: address.table,
						rowId: address.rowId,
					}),
				async append(address, update) {
					await request<void>(manifest, {
						kind: 'document-append',
						table: address.table,
						rowId: address.rowId,
						update,
					});
				},
			}),
			isLive: async ({ table, rowId }) =>
				(await request<Record<string, unknown> | undefined>(manifest, {
					kind: 'read-current-row',
					table,
					rowId,
				})) !== undefined,
			...(transport
				? {
						connect(address, document) {
							const connection = attachAuthenticatedDocumentConnection({
								document,
								url: rowDocumentWebSocketUrl({
									baseUrl: transport.baseUrl,
									workspaceId: definition.id,
									address,
								}),
								openWebSocket: transport.openWebSocket,
							});
							return {
								connection,
								dispose: connection.dispose,
							};
						},
					}
				: {}),
		});
		rowsDeletedListeners.add((addresses) => {
			for (const address of addresses) void documents.revoke(address);
		});

		const sync: WorkspaceSync | null = manifest.rowSync
			? Object.freeze({
					get status() {
						return syncStatus;
					},
					onStatusChange(listener: (status: WorkspaceSyncStatus) => void) {
						syncStatusListeners.add(listener);
						return () => syncStatusListeners.delete(listener);
					},
					settle(): Promise<WorkspaceSyncSettlement> {
						return request<WorkspaceSyncSettlement>(manifest, {
							kind: 'sync-settle',
						});
					},
					async captureRecovery() {
						// The Worker folds each row's locally durable compact document
						// state into the copy (ADR-0142); the page only waits for its
						// admitted appends to commit before the capture reads the log.
						await documents.captureDurabilityBarrier();
						return request<LogicalWorkspaceCopy | null>(manifest, {
							kind: 'sync-capture-recovery',
						});
					},
					async startFresh() {
						if (syncStatus.phase !== 'recovery-required') {
							throw new Error('Workspace does not require lineage recovery');
						}
						markNotReady();
						await request(manifest, { kind: 'sync-start-fresh' });
						notifyReady();
					},
				})
			: null;

		const tables = Object.fromEntries(
			Object.keys(definition.tables).map((table) => [
				table,
				Object.freeze({
					get(id: string) {
						return request(manifest, { kind: 'get', table, id });
					},
					list() {
						return request(manifest, { kind: 'list', table });
					},
					create(input: Record<string, unknown>) {
						return request(manifest, { kind: 'create', table, input });
					},
					update(id: string, changes: Record<string, unknown>) {
						return request(manifest, {
							kind: 'update',
							table,
							id,
							changes,
						});
					},
					async delete(id: string) {
						await request<void>(manifest, { kind: 'delete', table, id });
						notifyRowsDeleted([{ table, rowId: id }]);
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
				return getKv(key);
			},
			set(key: string, value: unknown) {
				return request(manifest, { kind: 'kv-set', key, value });
			},
			async unset(key: string) {
				await request(manifest, { kind: 'kv-unset', key });
			},
		});

		const handle = Object.freeze({
			id: definition.id,
			tables,
			kv: kv as never,
			sync,
			sql<TResultSchema extends TSchema>(
				query: string,
				parameters: readonly SqliteValue[],
				resultSchema: TResultSchema,
			): Promise<Static<TResultSchema>[]> {
				return request(manifest, {
					kind: 'sql',
					query,
					parameters,
					resultSchema,
				});
			},
		}) as unknown as WorkspaceHandle<TDefinition>;
		return {
			handle,
			notifyRowsDeleted,
			notifySyncStatus,
			notifyReady,
			waitUntilReady,
			rejectReadiness,
			revokeDocuments(cause: Error) {
				return documents.revokeAll(cause);
			},
			captureDurability: documents.captureDurabilityBarrier,
			disposeDocuments: documents[Symbol.asyncDispose],
			async importDocuments(copy: LogicalWorkspaceCopy) {
				for (const row of copy.rows) {
					if (row.document === undefined) continue;
					await documents.importUpdate(
						{ table: row.table, rowId: row.rowId },
						row.document,
					);
				}
			},
		};
	}

	return {
		/**
		 * Opens the workspace and resolves only with a ready handle. The stable
		 * Worker proxy and its FIFO request queue exist behind this promise;
		 * no half-open handle ever escapes. A failed acquisition (for example
		 * the named held-storage error) rejects and is terminal for this
		 * runtime: the Worker keeps the failure, every later `open` returns the
		 * same rejection, and recovery is an explicit reload.
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
			const manifest: BrowserWorkspaceManifest = {
				workspaceId: definition.id,
				storageKey: workspaceStorageKey(persistenceKey, definition.id),
				tables: serializeTableLenses(definition.tables),
				kv: JSON.parse(JSON.stringify(definition.kv)),
				rowSync: transport?.binding,
			};
			const binding = createHandle(definition, manifest);
			const bound: BoundWorkspace = {
				definition,
				manifest,
				...binding,
				opened: undefined as never,
			};
			workspaces.set(definition.id, bound);
			bound.opened = request<{ isReady: boolean }>(manifest, {
				kind: 'open',
			}).then(
				({ isReady }) => {
					if (isReady) bound.notifyReady();
					return binding.handle;
				},
				(cause) => {
					const error =
						cause instanceof Error ? cause : new Error(String(cause));
					void bound.revokeDocuments(error);
					bound.rejectReadiness(error);
					throw error;
				},
			);
			return bound.opened as Promise<WorkspaceHandle<TDefinition>>;
		},
		async captureLocal(workspaceId: string): Promise<LogicalWorkspaceCopy> {
			const bound = workspaces.get(workspaceId);
			if (!bound) {
				return Promise.reject(
					new Error(`Device workspace '${workspaceId}' is not open`),
				);
			}
			// The Worker folds durable document state into the copy.
			return request<LogicalWorkspaceCopy>(bound.manifest, {
				kind: 'logical-capture',
			});
		},
		async exportAccount(workspaceId: string): Promise<LogicalWorkspaceExport> {
			const bound = workspaces.get(workspaceId);
			if (!bound) {
				return Promise.reject(
					new Error(`Account workspace '${workspaceId}' is not open`),
				);
			}
			const sync = bound.handle.sync;
			if (!sync) {
				return Promise.reject(
					new Error(`Workspace '${workspaceId}' has no synchronization`),
				);
			}
			// Best effort: a pending settlement (offline, storage-limit) never
			// blocks export; the outcome reports the quality of the scalar cut.
			const settlement = await sync.settle();
			await bound.captureDurability();
			const copy = await request<LogicalWorkspaceCopy>(bound.manifest, {
				kind: 'capture-visible',
			});
			return { settlement, ...copy };
		},
		captureDurability(workspaceId: string): Promise<void> {
			const bound = workspaces.get(workspaceId);
			if (!bound) {
				return Promise.reject(
					new Error(`Workspace '${workspaceId}' is not open`),
				);
			}
			return bound.captureDurability();
		},
		whenReady(workspaceId: string): Promise<void> {
			const bound = workspaces.get(workspaceId);
			if (!bound) {
				return Promise.reject(
					new Error(`Workspace '${workspaceId}' is not open`),
				);
			}
			return bound.waitUntilReady();
		},
		async deleteLocal(workspaceId: string): Promise<void> {
			const bound = workspaces.get(workspaceId);
			if (!bound)
				throw new Error(`Device workspace '${workspaceId}' is not open`);
			// Revoke live handles first so already-captured edits drain into the
			// Worker's log; logical-delete then removes rows and document logs in
			// one owner-side transaction.
			await bound.revokeDocuments(
				new Error('Device workspace data was deleted'),
			);
			await request<void>(bound.manifest, { kind: 'logical-delete' });
		},
		async addToAccount(
			workspaceId: string,
			copy: LogicalWorkspaceCopy,
		): Promise<void> {
			const bound = workspaces.get(workspaceId);
			if (!bound) {
				return Promise.reject(
					new Error(`Account workspace '${workspaceId}' is not open`),
				);
			}
			await request(bound.manifest, { kind: 'logical-add', copy });
			await bound.importDocuments(copy);
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			worker?.terminate();
			const cause = new Error('Browser workspace runtime is disposed');
			// Revoke page-side row documents so retained handles fail loudly
			// instead of queueing persistence at a terminated Worker.
			for (const bound of workspaces.values()) {
				await bound.disposeDocuments();
				bound.rejectReadiness(cause);
			}
			ready?.reject(cause);
			for (const request of pending.values()) request.reject(cause);
			pending.clear();
			workspaces.clear();
			invalidationChannel?.close();
		},
	};
}

export type BrowserWorkspaceRuntime = ReturnType<
	typeof createDeviceBrowserWorkspaceRuntime
>;

function isInvalidationMessage(value: unknown): value is InvalidationMessage {
	if (typeof value !== 'object' || value === null || !('type' in value)) {
		return false;
	}
	const message = value as Record<string, unknown>;
	if (typeof message.workspaceId !== 'string') return false;
	return message.type === 'records-changed';
}

function defaultBroadcastChannel(
	name: string,
): RuntimeBroadcastChannel | undefined {
	return typeof BroadcastChannel === 'undefined'
		? undefined
		: new BroadcastChannel(name);
}

function normalizeTransport(
	input: CreateBrowserWorkspaceRuntimeOptions['transport'],
):
	| {
			binding: BrowserRowSyncBinding;
			baseUrl: string;
			fetch: BrowserRecordFetch;
			openWebSocket: BrowserWorkspaceTransport['openWebSocket'];
			headers: Record<string, string>;
			credentials: RequestCredentials;
	  }
	| undefined {
	if (!input) return undefined;
	const baseUrl = ensureTrailingSlash(new URL(input.baseUrl).href);
	const headers = Object.fromEntries(
		Object.entries(input.headers ?? {}).map(([name, value]) => {
			if (name.length === 0 || value.length === 0) {
				throw new Error('Record sync headers must not be empty');
			}
			return [name, value];
		}),
	);
	return {
		binding: { intervalMs: input.pollIntervalMs ?? 30_000 },
		baseUrl,
		fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
		openWebSocket: input.openWebSocket,
		headers,
		credentials: input.credentials ?? 'same-origin',
	};
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith('/') ? value : `${value}/`;
}

function workspaceStorageKey(
	persistenceKey: string,
	workspaceId: string,
): string {
	return sha256Hex(JSON.stringify([persistenceKey, workspaceId]));
}
