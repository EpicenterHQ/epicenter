/**
 * Bun-hosted SQLite workspace doors.
 *
 * These doors open SQLite tables and may compose child-document runtimes, but
 * they do not accept the browser doors' root-document KV mount. KV composition
 * remains internal until a Bun-specific public lifecycle earns that surface.
 */

import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { RECORD_SYNC_PROTOCOL_MAJOR } from '@epicenter/record-sync';
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import type { WorkspaceServicePort } from './client.js';
import { createApplicationDatabase } from './database.js';
import {
	assertWorkspaceDefinition,
	type KvDefinitions,
	type TableDefinitions,
	type WorkspaceDefinition,
} from './definition.js';
import type {
	WorkspaceDocumentOpenerFor,
	WorkspaceDocumentRuntime,
	WorkspaceDocumentRuntimeOption,
} from './document-client.js';
import {
	type OpenWorkspaceFromServiceOptions,
	type OwnedWorkspaceServicePort,
	openWorkspaceFromService,
	type StandaloneWorkspace,
	type WorkspaceReplica,
} from './open.js';
import {
	createReplicaRuntime,
	type ReplicaSyncPort,
	startReplicaSyncSupervisor,
} from './replica.js';
import { createWorkspaceService } from './service.js';

export type { StandaloneWorkspace, WorkspaceReplica } from './open.js';
export {
	type ExportPortableWorkspaceOptions,
	exportPortableWorkspace,
	readPortableTables,
} from './portable-workspace-bun.js';
export {
	type ApplyPortableTablesOptions,
	type ApplyPortableTablesResult,
	applyPortableTables,
} from './tables-apply-bun.js';

export type OpenStandaloneWorkspaceOptions<
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
> = WorkspaceDocumentRuntimeOption<TDocumentRuntime> & {
	storage: { kind: 'bun'; path: string } | { kind: 'memory' };
	/** Receives post-commit observer failures. Must not throw. */
	onObserverError(error: unknown): void;
};

export type OpenWorkspaceReplicaOptions<
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
> = WorkspaceDocumentRuntimeOption<TDocumentRuntime> & {
	storage: { kind: 'bun'; path: string } | { kind: 'memory' };
	sync: ReplicaSyncPort;
	/** Receives automatic synchronization failures. Must not throw. */
	onSyncError(error: unknown): void;
	/** Receives post-commit observer failures. Must not throw. */
	onObserverError(error: unknown): void;
	pollIntervalMs?: number;
};

const ownedFilePaths = new Set<string>();

/** Open a standalone workspace whose authoritative SQLite runs in Bun. */
export async function openStandaloneWorkspace<
	TTables extends TableDefinitions,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
>(
	definition: WorkspaceDefinition<TTables>,
	options: OpenStandaloneWorkspaceOptions<TDocumentRuntime>,
): Promise<
	StandaloneWorkspace<
		TTables,
		undefined,
		WorkspaceDocumentOpenerFor<TDocumentRuntime>
	>
> {
	assertWorkspaceDefinition(definition);
	const { storage, onObserverError } = options;
	const filePath = storage.kind === 'bun' ? resolve(storage.path) : undefined;
	if (filePath && ownedFilePaths.has(filePath)) {
		throw new Error(`Workspace SQLite file already has an owner: ${filePath}`);
	}
	if (filePath) {
		mkdirSync(dirname(filePath), { recursive: true });
		ownedFilePaths.add(filePath);
	}
	let native: Database | undefined;
	let service: ReturnType<typeof createWorkspaceService> | undefined;
	let isDisposed = false;
	function close(): void {
		if (isDisposed) return;
		isDisposed = true;
		try {
			service?.[Symbol.dispose]();
		} finally {
			try {
				native?.close();
			} finally {
				if (filePath) ownedFilePaths.delete(filePath);
			}
		}
	}
	try {
		native = new Database(filePath ?? ':memory:', { create: true });
		native.exec('PRAGMA busy_timeout = 5000');
		if (filePath) native.exec('PRAGMA journal_mode = WAL');
		const database = createApplicationDatabase(
			definition,
			createBunSqliteAdapter(native),
			{ kind: 'standalone', onObserverError },
		);
		service = createWorkspaceService(database, {
			onObserverError,
		});
		const ownedService: OwnedWorkspaceServicePort = {
			request: service.request,
			observe: service.observe,
			async [Symbol.asyncDispose]() {
				close();
			},
		} satisfies WorkspaceServicePort & AsyncDisposable;
		const openOptions = {
			...options,
			service: ownedService,
			expectedKind: 'standalone',
			kv: undefined,
		} as unknown as OpenWorkspaceFromServiceOptions<
			'standalone',
			undefined,
			TDocumentRuntime
		>;
		return await openWorkspaceFromService<
			TTables,
			KvDefinitions,
			'standalone',
			undefined,
			TDocumentRuntime
		>(definition, openOptions);
	} catch (cause) {
		close();
		throw cause;
	}
}

/** Open this device's durable replica of one authoritative workspace. */
export async function openWorkspaceReplica<
	TTables extends TableDefinitions,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
>(
	definition: WorkspaceDefinition<TTables>,
	options: OpenWorkspaceReplicaOptions<TDocumentRuntime>,
): Promise<
	WorkspaceReplica<
		TTables,
		undefined,
		WorkspaceDocumentOpenerFor<TDocumentRuntime>
	>
> {
	assertWorkspaceDefinition(definition);
	const { storage, sync, onSyncError, onObserverError, pollIntervalMs } =
		options;
	const filePath = storage.kind === 'bun' ? resolve(storage.path) : undefined;
	if (filePath && ownedFilePaths.has(filePath)) {
		throw new Error(`Workspace SQLite file already has an owner: ${filePath}`);
	}
	if (filePath) {
		mkdirSync(dirname(filePath), { recursive: true });
		ownedFilePaths.add(filePath);
	}
	let native: Database | undefined;
	let service: ReturnType<typeof createWorkspaceService> | undefined;
	let stopScheduling: (() => void) | undefined;
	let supervisor: ReturnType<typeof startReplicaSyncSupervisor> | undefined;
	let disposePromise: Promise<void> | undefined;

	function dispose(): Promise<void> {
		disposePromise ??= (async () => {
			const cleanupErrors: unknown[] = [];
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
				service?.[Symbol.dispose]();
			} catch (error) {
				cleanupErrors.push(error);
			}
			try {
				native?.close();
			} catch (error) {
				cleanupErrors.push(error);
			} finally {
				if (filePath) ownedFilePaths.delete(filePath);
			}
			if (cleanupErrors.length > 0) {
				throw new AggregateError(
					cleanupErrors,
					'Workspace replica cleanup failed',
				);
			}
		})();
		return disposePromise;
	}

	try {
		native = new Database(filePath ?? ':memory:', { create: true });
		native.exec('PRAGMA busy_timeout = 5000');
		if (filePath) native.exec('PRAGMA journal_mode = WAL');
		const runtime = await createReplicaRuntime({
			definition,
			sqlite: createBunSqliteAdapter(native),
			sync,
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			createActorId: randomUUID,
			sha256: async (value) => createHash('sha256').update(value).digest('hex'),
			onObserverError,
		});
		service = createWorkspaceService(runtime.database, {
			onObserverError,
			readRecoveryCheckpoint: runtime.readRecoveryCheckpoint,
		});
		supervisor = startReplicaSyncSupervisor(runtime, {
			onError: onSyncError,
			pollIntervalMs,
		});
		stopScheduling = service.observe(() => supervisor?.request());
		const ownedService: OwnedWorkspaceServicePort = {
			request: service.request,
			observe: service.observe,
			[Symbol.asyncDispose]: dispose,
		};
		const openOptions = {
			...options,
			service: ownedService,
			expectedKind: 'replica',
			kv: undefined,
		} as unknown as OpenWorkspaceFromServiceOptions<
			'replica',
			undefined,
			TDocumentRuntime
		>;
		const workspace = await openWorkspaceFromService<
			TTables,
			KvDefinitions,
			'replica',
			undefined,
			TDocumentRuntime
		>(definition, openOptions);
		supervisor.request();
		return workspace;
	} catch (cause) {
		try {
			await dispose();
		} catch (cleanupCause) {
			throw new AggregateError(
				[cause, cleanupCause],
				'Workspace replica open and cleanup both failed',
				{ cause },
			);
		}
		throw cause;
	}
}
