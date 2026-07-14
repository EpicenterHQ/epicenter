import { RECORD_SYNC_PROTOCOL_MAJOR } from '@epicenter/record-sync';
import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/record-sync/browser';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
	parseWorkspaceInspectionCommand,
	WORKSPACE_INSPECTION_PROTOCOL,
	type WorkspaceInspectionEvent,
} from './browser-inspection.js';
import { createBrowserReplicaSyncPort } from './browser-replica-sync-bridge.js';
import { parseBrowserWorkspaceWorkerInitialization } from './browser-runtime-protocol.js';
import {
	exposeWorkspaceService,
	type WorkerWorkspaceService,
	type WorkspaceWorkerScope,
} from './browser-transport.js';
import type { WorkspaceCommitDelta } from './client.js';
import {
	createApplicationDatabase,
	inspectApplicationDatabaseIdentity,
} from './database.js';
import {
	assertWorkspaceDefinition,
	type TableDefinitions,
	type WorkspaceDefinition,
} from './definition.js';
import { createInvalidationRefreshQueue } from './invalidation-queue.js';
import {
	createReplicaRuntime,
	type ReplicaSyncPort,
	startReplicaSyncSupervisor,
} from './replica.js';
import { createWorkspaceService } from './service.js';
import {
	parseWorkspaceInvalidationMessage,
	WORKSPACE_INVALIDATION_PROTOCOL,
	WORKSPACE_WORKER_PROTOCOL,
	type WorkspaceInvalidation,
	type WorkspaceWorkerEvent,
} from './service-protocol.js';

type ServeStandaloneWorkspaceWorkerOptions = {
	/** OPFS filename selected by the page-side browser runtime. */
	databaseName?: string;
	/** Receives worker-side observer, broadcast, and cleanup failures. */
	onError(error: unknown): void;
};

type ServeWorkspaceReplicaWorkerOptions = {
	sync: ReplicaSyncPort;
	disposeSync?: () => void;
	/** OPFS filename selected by the page-side browser runtime. */
	databaseName?: string;
	/** Receives retryable or paused synchronization failures. */
	onSyncError(error: unknown): void;
	/** Receives worker-side observer, broadcast, and cleanup failures. */
	onError(error: unknown): void;
	pollIntervalMs?: number;
};

type BrowserWorkspaceWorkerScope = WorkspaceWorkerScope & {
	postMessage(message: WorkspaceInspectionEvent): void;
};

function postInspectionError(
	scope: BrowserWorkspaceWorkerScope,
	cause: unknown,
): void {
	const error =
		cause instanceof Error
			? { name: cause.name || 'Error', message: cause.message }
			: { name: 'Error', message: String(cause) };
	scope.postMessage({
		protocol: WORKSPACE_INSPECTION_PROTOCOL,
		type: 'error',
		error,
	});
}

async function inspectOpfsWorkspace(
	definition: WorkspaceDefinition,
	workspaceKind: 'standalone' | 'replica',
	databaseName: string,
) {
	const root = await navigator.storage.getDirectory();
	try {
		await root.getFileHandle(opfsDatabaseName(definition, databaseName));
	} catch (cause) {
		if (cause instanceof DOMException && cause.name === 'NotFoundError') {
			return { status: 'absent' } as const;
		}
		throw cause;
	}

	if (!globalThis.crossOriginIsolated || !globalThis.SharedArrayBuffer) {
		throw new Error(
			'OPFS SQLite requires cross-origin isolation with COOP and COEP headers',
		);
	}
	const sqlite3 = await sqlite3InitModule();
	if (!sqlite3.capi.sqlite3_vfs_find('opfs')) {
		throw new Error('SQLite opfs VFS is unavailable');
	}

	let native: (BrowserSqliteDatabase & { close(): void }) | undefined;
	try {
		native = new sqlite3.oo1.DB(
			opfsDatabasePath(definition, databaseName),
			'r',
			'opfs',
		) as unknown as BrowserSqliteDatabase & { close(): void };
		return inspectApplicationDatabaseIdentity(
			definition,
			createBrowserSqliteAdapter(native),
			workspaceKind,
		);
	} finally {
		native?.close();
	}
}

type ServeWorkspaceWorkerOptions =
	| ({ workspaceKind: 'standalone' } & ServeStandaloneWorkspaceWorkerOptions)
	| ({ workspaceKind: 'replica' } & ServeWorkspaceReplicaWorkerOptions);

function report(onError: (error: unknown) => void, error: unknown): void {
	try {
		onError(error);
	} catch {
		// A broken error sink must not crash the database worker.
	}
}

function invalidationFor(delta: WorkspaceCommitDelta): WorkspaceInvalidation {
	return {
		tables: Object.fromEntries(
			Object.entries(delta.tables).map(([table, change]) => [
				table,
				[...change.upserted.map((row) => row.id), ...change.removed],
			]),
		),
	};
}

async function openOpfsWorkspaceService<TTables extends TableDefinitions>(
	definition: WorkspaceDefinition<TTables>,
	options: ServeWorkspaceWorkerOptions,
): Promise<WorkerWorkspaceService> {
	assertWorkspaceDefinition(definition);
	const { onError, workspaceKind } = options;
	if (!globalThis.crossOriginIsolated || !globalThis.SharedArrayBuffer) {
		throw new Error(
			'OPFS SQLite requires cross-origin isolation with COOP and COEP headers',
		);
	}
	const sqlite3 = await sqlite3InitModule();
	if (!sqlite3.capi.sqlite3_vfs_find('opfs')) {
		throw new Error('SQLite opfs VFS is unavailable');
	}
	let native: (BrowserSqliteDatabase & { close(): void }) | undefined;
	let channel: BroadcastChannel | undefined;
	let service: ReturnType<typeof createWorkspaceService> | undefined;
	let stopChanges: (() => void) | undefined;
	let refreshQueue:
		| ReturnType<typeof createInvalidationRefreshQueue>
		| undefined;
	let isDisposed = false;
	let disposePromise: Promise<void> | undefined;
	let stopScheduling: (() => void) | undefined;
	let supervisor: ReturnType<typeof startReplicaSyncSupervisor> | undefined;

	async function disposeResources(): Promise<void> {
		isDisposed = true;
		const cleanupErrors: unknown[] = [];
		try {
			channel?.close();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			stopScheduling?.();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await supervisor?.dispose();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			if (workspaceKind === 'replica') options.disposeSync?.();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await refreshQueue?.dispose();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			stopChanges?.();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			service?.[Symbol.dispose]();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			native?.close();
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, 'OPFS workspace cleanup failed');
		}
	}

	try {
		native = new sqlite3.oo1.DB(
			opfsDatabasePath(definition, options.databaseName),
			'c',
			'opfs',
		) as unknown as BrowserSqliteDatabase & { close(): void };
		channel = new BroadcastChannel(
			`epicenter.sqlite/${opfsDatabaseName(definition, options.databaseName)}`,
		);
		const senderId = crypto.randomUUID();
		native.exec({ sql: 'PRAGMA busy_timeout = 5000' });
		const sqlite = createBrowserSqliteAdapter(native);
		const replicaRuntime =
			workspaceKind === 'replica'
				? await createReplicaRuntime({
						definition,
						sqlite,
						sync: options.sync,
						protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
						createActorId: () => crypto.randomUUID(),
						sha256,
						onObserverError: (error) => report(onError, error),
					})
				: undefined;
		const database =
			replicaRuntime?.database ??
			createApplicationDatabase(definition, sqlite, {
				kind: 'standalone',
				onObserverError: (error) => report(onError, error),
			});
		const openedService = createWorkspaceService(database, {
			onObserverError: (error) => report(onError, error),
			readRecoveryCheckpoint: replicaRuntime?.readRecoveryCheckpoint,
		});
		service = openedService;
		if (workspaceKind === 'replica' && replicaRuntime) {
			supervisor = startReplicaSyncSupervisor(replicaRuntime, {
				onError: options.onSyncError,
				pollIntervalMs: options.pollIntervalMs,
			});
			stopScheduling = openedService.observe(() => supervisor?.request());
			supervisor.request();
		}
		refreshQueue = createInvalidationRefreshQueue({
			tables: new Set(Object.keys(definition.tables)),
			refresh: openedService.refresh,
			onError: (error) => report(onError, error),
		});
		stopChanges = openedService.observeChanges((delta, source) => {
			if (source !== 'commit' || isDisposed) return;
			channel?.postMessage({
				protocol: WORKSPACE_INVALIDATION_PROTOCOL,
				senderId,
				invalidation: invalidationFor(delta),
			});
		});
		channel.addEventListener('message', (event: MessageEvent<unknown>) => {
			if (isDisposed) return;
			try {
				const message = parseWorkspaceInvalidationMessage(event.data);
				if (message.senderId !== senderId) {
					refreshQueue?.enqueue(message.invalidation);
				}
			} catch (error) {
				report(onError, error);
			}
		});
	} catch (cause) {
		try {
			await disposeResources();
		} catch (cleanupCause) {
			throw new AggregateError(
				[cause, cleanupCause],
				'OPFS workspace initialization and cleanup both failed',
				{ cause },
			);
		}
		throw cause;
	}
	const openedService = service;
	if (!openedService)
		throw new Error('OPFS workspace service did not initialize');

	return {
		request: openedService.request,
		observe: openedService.observe,
		[Symbol.asyncDispose]() {
			disposePromise ??= disposeResources();
			return disposePromise;
		},
	};
}

function opfsDatabasePath(
	definition: WorkspaceDefinition,
	databaseName?: string,
): string {
	return `/${opfsDatabaseName(definition, databaseName)}`;
}

function opfsDatabaseName(
	definition: WorkspaceDefinition,
	databaseName?: string,
): string {
	const name = databaseName ?? `${definition.workspaceId}.sqlite3`;
	if (!/^[A-Za-z0-9._-]+\.sqlite3$/.test(name)) {
		throw new Error('Invalid OPFS workspace database name');
	}
	return name;
}

export type ServeBrowserWorkspaceWorkerOptions = {
	/**
	 * Receives retryable or paused synchronization failures. Do not pass the
	 * Worker global `reportError`: it emits a fatal `error` event.
	 */
	onSyncError(error: unknown): void;
	/** Receives worker-side protocol, observer, broadcast, and cleanup failures. */
	onError(error: unknown): void;
	pollIntervalMs?: number;
};

/**
 * Start the one app-owned Worker used by the shared browser runtime.
 *
 * The page selects standalone or principal-scoped replica storage exactly once
 * at boot. Replica HTTP crosses a MessagePort so OAuth credentials stay owned
 * by the page's auth client while SQLite and synchronization stay Worker-owned.
 */
export function serveBrowserWorkspaceWorker<TTables extends TableDefinitions>(
	definition: WorkspaceDefinition<TTables>,
	options: ServeBrowserWorkspaceWorkerOptions,
	scope: BrowserWorkspaceWorkerScope = self as unknown as BrowserWorkspaceWorkerScope,
): void {
	assertWorkspaceDefinition(definition);
	let isInitialized = false;
	let syncBridge: ReturnType<typeof createBrowserReplicaSyncPort> | undefined;
	scope.addEventListener('message', (event) => {
		if (isInitialized) return;
		try {
			let inspectionCommand:
				| ReturnType<typeof parseWorkspaceInspectionCommand>
				| undefined;
			try {
				inspectionCommand = parseWorkspaceInspectionCommand(event.data);
			} catch {
				// The same entry also accepts the runtime initialization protocol.
			}
			if (inspectionCommand) {
				isInitialized = true;
				inspectOpfsWorkspace(
					definition,
					inspectionCommand.workspaceKind,
					inspectionCommand.databaseName,
				).then(
					(inspection) => {
						scope.postMessage({
							protocol: WORKSPACE_INSPECTION_PROTOCOL,
							type: 'result',
							workspaceId: definition.workspaceId,
							recordsDescriptor: definition.recordsDescriptor,
							recordsSchemaHash: definition.recordsSchemaHash,
							workspaceKind: inspectionCommand.workspaceKind,
							inspection,
						});
					},
					(cause: unknown) => postInspectionError(scope, cause),
				);
				return;
			}
			const initialization = parseBrowserWorkspaceWorkerInitialization(
				event.data,
			);
			isInitialized = true;
			if (initialization.workspaceKind === 'standalone') {
				exposeWorkspaceService(
					scope,
					openOpfsWorkspaceService(definition, {
						databaseName: initialization.databaseName,
						onError: options.onError,
						workspaceKind: 'standalone',
					}),
				);
				return;
			}
			syncBridge = createBrowserReplicaSyncPort(initialization.syncPort);
			exposeWorkspaceService(
				scope,
				openOpfsWorkspaceService(definition, {
					databaseName: initialization.databaseName,
					sync: syncBridge,
					disposeSync: () => syncBridge?.[Symbol.dispose](),
					onSyncError: options.onSyncError,
					onError: options.onError,
					pollIntervalMs: options.pollIntervalMs,
					workspaceKind: 'replica',
				}),
			);
		} catch (cause) {
			isInitialized = true;
			syncBridge?.[Symbol.dispose]();
			try {
				options.onError(cause);
			} catch {
				// A broken error sink must not hide the protocol failure.
			}
			const error =
				cause instanceof Error
					? { name: cause.name || 'Error', message: cause.message }
					: { name: 'Error', message: String(cause) };
			scope.postMessage({
				protocol: WORKSPACE_WORKER_PROTOCOL,
				type: 'fatal',
				error,
			} satisfies WorkspaceWorkerEvent);
		}
	});
}

async function sha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}
