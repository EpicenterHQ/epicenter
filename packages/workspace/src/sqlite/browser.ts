import {
	type BrowserWorkspaceDocumentPlanes,
	type BrowserWorkspaceDocumentSync,
	createBrowserWorkspaceDocumentPlanes,
} from './browser-document-runtime.js';
import {
	type LocalWorkspaceInspection,
	parseWorkspaceInspectionEvent,
	WORKSPACE_INSPECTION_PROTOCOL,
	type WorkspaceInspectionEvent,
} from './browser-inspection.js';
import { attachBrowserReplicaSyncPort } from './browser-replica-sync-bridge.js';
import {
	BROWSER_WORKSPACE_RUNTIME_PROTOCOL,
	type BrowserWorkspaceWorkerInitialization,
} from './browser-runtime-protocol.js';
import {
	createWorkspaceWorkerPort,
	type WorkspaceWorkerPortOptions,
} from './browser-transport.js';
import {
	assertWorkspaceDefinition,
	type KvDefinitions,
	type TableDefinitions,
	type WorkspaceDefinition,
} from './definition.js';
import type {
	WorkspaceDocumentOpener,
	WorkspaceDocumentRuntime,
} from './document-client.js';
import {
	type OpenedWorkspace,
	openWorkspaceFromService,
	type WorkspaceKvMount,
} from './open.js';
import { createHttpReplicaSyncPort } from './replica-http.js';
import {
	normalizeWorkspaceAuthority,
	type ServerWorkspaceAuthority,
	type WorkspaceAuthority,
	workspaceAuthorityHash,
} from './workspace-authority.js';

export type { BrowserWorkspaceDocumentSync } from './browser-document-runtime.js';
export type { LocalWorkspaceInspection } from './browser-inspection.js';
export type {
	StandaloneWorkspace,
	WorkspaceKvMount,
	WorkspaceReplica,
} from './open.js';

export type BrowserWorkspaceFetch = (
	input: Request | string | URL,
	init?: RequestInit,
) => Promise<Response>;

type OpenBrowserWorkspaceBaseOptions = WorkspaceWorkerPortOptions & {
	/** Create the one app-owned module Worker that imports this definition. */
	worker(): Worker;
};

export type OpenBrowserLocalWorkspaceOptions =
	OpenBrowserWorkspaceBaseOptions & {
		authority: Extract<WorkspaceAuthority, { kind: 'local' }>;
		fetch?: never;
		documentSync?: never;
	};

export type OpenBrowserServerWorkspaceOptions =
	OpenBrowserWorkspaceBaseOptions & {
		authority: ServerWorkspaceAuthority;
		/** Auth-owned HTTP boundary. Credentials never cross into the Worker. */
		fetch: BrowserWorkspaceFetch;
		/** Auth-owned WebSocket boundary for the KV and child-document rooms. */
		documentSync: BrowserWorkspaceDocumentSync;
	};

export type OpenBrowserWorkspaceOptions =
	| OpenBrowserLocalWorkspaceOptions
	| OpenBrowserServerWorkspaceOptions
	| (OpenBrowserWorkspaceBaseOptions & {
			authority: WorkspaceAuthority;
			/** Auth-owned HTTP available before the boot-time authority is narrowed. */
			fetch: BrowserWorkspaceFetch;
			documentSync: BrowserWorkspaceDocumentSync;
	  });

/**
 * Open one browser workspace through the shared authority composition.
 *
 * Signed-out data uses one standalone OPFS file. A synchronized replica uses a
 * deployment-and-principal-scoped filename. Authenticated HTTP and WebSocket
 * creation stay on the page. The app Worker owns SQLite and record sync; the
 * page-owned document runtime owns KV and child-document sync.
 */
export function openBrowserWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: OpenBrowserLocalWorkspaceOptions,
): Promise<
	OpenedWorkspace<TTables, TKv, 'standalone', WorkspaceDocumentOpener>
>;
export function openBrowserWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: OpenBrowserServerWorkspaceOptions,
): Promise<OpenedWorkspace<TTables, TKv, 'replica', WorkspaceDocumentOpener>>;
export function openBrowserWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: OpenBrowserWorkspaceBaseOptions & {
		authority: WorkspaceAuthority;
		fetch: BrowserWorkspaceFetch;
		documentSync: BrowserWorkspaceDocumentSync;
	},
): Promise<
	| OpenedWorkspace<TTables, TKv, 'standalone', WorkspaceDocumentOpener>
	| OpenedWorkspace<TTables, TKv, 'replica', WorkspaceDocumentOpener>
>;
export async function openBrowserWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: OpenBrowserWorkspaceOptions,
): Promise<
	| OpenedWorkspace<TTables, TKv, 'standalone', WorkspaceDocumentOpener>
	| OpenedWorkspace<TTables, TKv, 'replica', WorkspaceDocumentOpener>
> {
	assertWorkspaceDefinition(definition);
	const authority = normalizeWorkspaceAuthority(options.authority);
	const documentSync = options.documentSync;
	let documentPlanes: BrowserWorkspaceDocumentPlanes;
	if (authority.kind === 'server') {
		if (!documentSync) {
			throw new TypeError(
				'A server workspace authority requires document synchronization',
			);
		}
		documentPlanes = await createBrowserWorkspaceDocumentPlanes(definition, {
			authority,
			sync: documentSync,
		});
	} else {
		documentPlanes = await createBrowserWorkspaceDocumentPlanes(definition, {
			authority,
		});
	}
	let worker: Worker;
	try {
		worker = options.worker();
	} catch (cause) {
		await documentPlanes[Symbol.asyncDispose]();
		throw cause;
	}
	let stopSyncBridge: (() => void) | undefined;
	let initialization: BrowserWorkspaceWorkerInitialization;
	let transfer: Transferable[] = [];
	try {
		if (authority.kind === 'server') {
			const serverOptions = options as OpenBrowserServerWorkspaceOptions;
			const channel = new MessageChannel();
			stopSyncBridge = attachBrowserReplicaSyncPort(
				channel.port1,
				createHttpReplicaSyncPort({
					baseUrl: authority.baseURL,
					fetch: serverOptions.fetch,
				}),
			);
			initialization = {
				protocol: BROWSER_WORKSPACE_RUNTIME_PROTOCOL,
				type: 'initialize',
				workspaceKind: 'replica',
				databaseName: await browserWorkspaceDatabaseName(definition, authority),
				syncPort: channel.port2,
			};
			transfer = [channel.port2];
		} else {
			initialization = {
				protocol: BROWSER_WORKSPACE_RUNTIME_PROTOCOL,
				type: 'initialize',
				workspaceKind: 'standalone',
				databaseName: await browserWorkspaceDatabaseName(definition, authority),
			};
		}
		worker.postMessage(initialization, transfer);
	} catch (cause) {
		stopSyncBridge?.();
		worker.terminate();
		await documentPlanes[Symbol.asyncDispose]();
		throw cause;
	}

	const workerService = createWorkspaceWorkerPort(worker, {
		startupTimeoutMs: options.startupTimeoutMs,
		disposeTimeoutMs: options.disposeTimeoutMs,
		onObserverError: options.onObserverError,
	});
	let disposePromise: Promise<void> | undefined;
	const service = {
		request: workerService.request,
		observe: workerService.observe,
		[Symbol.asyncDispose]() {
			disposePromise ??= Promise.resolve(
				workerService[Symbol.asyncDispose](),
			).finally(() => stopSyncBridge?.());
			return disposePromise;
		},
	};

	try {
		const opened =
			authority.kind === 'server'
				? await openWorkspaceFromService<
						TTables,
						TKv,
						'replica',
						WorkspaceKvMount,
						WorkspaceDocumentRuntime
					>(definition, {
						service,
						expectedKind: 'replica',
						kv: documentPlanes.kv,
						documents: documentPlanes.documents,
					})
				: await openWorkspaceFromService<
						TTables,
						TKv,
						'standalone',
						WorkspaceKvMount,
						WorkspaceDocumentRuntime
					>(definition, {
						service,
						expectedKind: 'standalone',
						kv: documentPlanes.kv,
						documents: documentPlanes.documents,
					});
		let browserDispose: Promise<void> | undefined;
		return {
			...opened,
			[Symbol.asyncDispose]() {
				browserDispose ??= Promise.all([
					opened[Symbol.asyncDispose](),
					documentPlanes[Symbol.asyncDispose](),
				]).then(() => undefined);
				return browserDispose;
			},
		};
	} catch (cause) {
		try {
			await documentPlanes[Symbol.asyncDispose]();
		} catch (cleanupCause) {
			throw new AggregateError(
				[cause, cleanupCause],
				'Browser workspace open failed and document cleanup also failed',
				{ cause },
			);
		}
		throw cause;
	}
}

/** Deterministic OPFS filename without exposing the principal id on disk. */
export async function browserWorkspaceDatabaseName(
	definition: WorkspaceDefinition,
	authority: WorkspaceAuthority,
): Promise<string> {
	assertWorkspaceDefinition(definition);
	const normalized = normalizeWorkspaceAuthority(authority);
	if (normalized.kind === 'local') {
		return `${definition.workspaceId}.standalone.sqlite3`;
	}
	return `${definition.workspaceId}.replica-${await workspaceAuthorityHash(normalized)}.sqlite3`;
}

export type InspectBrowserWorkspaceOptions = {
	/** Create the app-owned inspector Worker that imports this definition. */
	worker(): Worker;
	authority: WorkspaceAuthority;
	timeoutMs?: number;
};

/** Inspect one locked OPFS namespace without creating or initializing it. */
export async function inspectBrowserWorkspace(
	definition: WorkspaceDefinition,
	{
		worker: createWorker,
		authority,
		timeoutMs = 10_000,
	}: InspectBrowserWorkspaceOptions,
): Promise<LocalWorkspaceInspection> {
	assertWorkspaceDefinition(definition);
	const normalizedAuthority = normalizeWorkspaceAuthority(authority);
	const workspaceKind =
		normalizedAuthority.kind === 'local' ? 'standalone' : 'replica';
	const databaseName = await browserWorkspaceDatabaseName(
		definition,
		normalizedAuthority,
	);
	const worker = createWorker();
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		function cleanup(): void {
			if (timer) clearTimeout(timer);
			worker.removeEventListener('message', onMessage);
			worker.removeEventListener('error', onError);
			worker.removeEventListener('messageerror', onMessageError);
			worker.terminate();
		}
		function fail(error: Error): void {
			cleanup();
			reject(error);
		}
		function onMessage(event: MessageEvent<unknown>): void {
			let message: WorkspaceInspectionEvent;
			try {
				message = parseWorkspaceInspectionEvent(event.data);
			} catch (cause) {
				fail(
					new Error('Workspace inspector sent an invalid protocol message', {
						cause,
					}),
				);
				return;
			}
			if (message.type === 'error') {
				const error = new Error(message.error.message);
				error.name = message.error.name;
				fail(error);
				return;
			}
			if (
				message.workspaceKind !== workspaceKind ||
				message.workspaceId !== definition.workspaceId ||
				message.recordsDescriptor !== definition.recordsDescriptor ||
				message.recordsSchemaHash !== definition.recordsSchemaHash
			) {
				fail(
					new Error('Workspace inspector definition does not match the client'),
				);
				return;
			}
			cleanup();
			resolve(message.inspection);
		}
		function onError(event: ErrorEvent): void {
			fail(new Error(event.message || 'Workspace inspector crashed'));
		}
		function onMessageError(): void {
			fail(new Error('Workspace inspector response could not be deserialized'));
		}

		worker.addEventListener('message', onMessage);
		worker.addEventListener('error', onError);
		worker.addEventListener('messageerror', onMessageError);
		worker.postMessage({
			protocol: WORKSPACE_INSPECTION_PROTOCOL,
			type: 'inspect',
			workspaceKind,
			databaseName,
		});
		if (timeoutMs > 0) {
			timer = setTimeout(
				() => fail(new Error('Workspace inspector timed out')),
				timeoutMs,
			);
		}
	});
}
