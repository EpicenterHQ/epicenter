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
	WorkspaceDocumentOpenerFor,
	WorkspaceDocumentRuntime,
	WorkspaceDocumentRuntimeOption,
} from './document-client.js';
import {
	type OpenedWorkspace,
	openWorkspaceFromService,
	type WorkspaceKvFor,
	type WorkspaceKvMount,
	type WorkspaceKvMountOption,
} from './open.js';
import { createHttpReplicaSyncPort } from './replica-http.js';
import {
	normalizeWorkspaceAuthority,
	type ServerWorkspaceAuthority,
	type WorkspaceAuthority,
	workspaceAuthorityHash,
} from './workspace-authority.js';

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

type OpenBrowserWorkspaceBaseOptions<
	TKvMount extends WorkspaceKvMount | undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined,
> = WorkspaceWorkerPortOptions &
	WorkspaceKvMountOption<TKvMount> &
	WorkspaceDocumentRuntimeOption<TDocumentRuntime> & {
		/** Create the one app-owned module Worker that imports this definition. */
		worker(): Worker;
	};

export type OpenBrowserLocalWorkspaceOptions<
	TKvMount extends WorkspaceKvMount | undefined = undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
> = OpenBrowserWorkspaceBaseOptions<TKvMount, TDocumentRuntime> & {
	authority: Extract<WorkspaceAuthority, { kind: 'local' }>;
	fetch?: never;
};

export type OpenBrowserServerWorkspaceOptions<
	TKvMount extends WorkspaceKvMount | undefined = undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
> = OpenBrowserWorkspaceBaseOptions<TKvMount, TDocumentRuntime> & {
	authority: ServerWorkspaceAuthority;
	/** Auth-owned HTTP boundary. Credentials never cross into the Worker. */
	fetch: BrowserWorkspaceFetch;
};

export type OpenBrowserWorkspaceOptions<
	TKvMount extends WorkspaceKvMount | undefined = undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
> =
	| OpenBrowserLocalWorkspaceOptions<TKvMount, TDocumentRuntime>
	| OpenBrowserServerWorkspaceOptions<TKvMount, TDocumentRuntime>
	| (OpenBrowserWorkspaceBaseOptions<TKvMount, TDocumentRuntime> & {
			authority: WorkspaceAuthority;
			/** Auth-owned HTTP available before the boot-time authority is narrowed. */
			fetch: BrowserWorkspaceFetch;
	  });

/**
 * Open one browser workspace through the shared authority composition.
 *
 * Signed-out data uses one standalone OPFS file. A synchronized replica uses a
 * deployment-and-principal-scoped filename, while its authenticated HTTP stays
 * on the page behind a MessagePort. The app Worker remains the sole SQLite and
 * synchronization owner in both modes.
 */
export function openBrowserWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TKvMount extends WorkspaceKvMount | undefined = undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: OpenBrowserLocalWorkspaceOptions<TKvMount, TDocumentRuntime>,
): Promise<
	OpenedWorkspace<
		TTables,
		WorkspaceKvFor<TKvMount, TKv>,
		'standalone',
		WorkspaceDocumentOpenerFor<TDocumentRuntime>
	>
>;
export function openBrowserWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TKvMount extends WorkspaceKvMount | undefined = undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: OpenBrowserServerWorkspaceOptions<TKvMount, TDocumentRuntime>,
): Promise<
	OpenedWorkspace<
		TTables,
		WorkspaceKvFor<TKvMount, TKv>,
		'replica',
		WorkspaceDocumentOpenerFor<TDocumentRuntime>
	>
>;
export function openBrowserWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TKvMount extends WorkspaceKvMount | undefined = undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: OpenBrowserWorkspaceBaseOptions<TKvMount, TDocumentRuntime> & {
		authority: WorkspaceAuthority;
		fetch: BrowserWorkspaceFetch;
	},
): Promise<
	| OpenedWorkspace<
			TTables,
			WorkspaceKvFor<TKvMount, TKv>,
			'standalone',
			WorkspaceDocumentOpenerFor<TDocumentRuntime>
	  >
	| OpenedWorkspace<
			TTables,
			WorkspaceKvFor<TKvMount, TKv>,
			'replica',
			WorkspaceDocumentOpenerFor<TDocumentRuntime>
	  >
>;
export async function openBrowserWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TKvMount extends WorkspaceKvMount | undefined = undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: OpenBrowserWorkspaceOptions<TKvMount, TDocumentRuntime>,
): Promise<
	| OpenedWorkspace<
			TTables,
			WorkspaceKvFor<TKvMount, TKv>,
			'standalone',
			WorkspaceDocumentOpenerFor<TDocumentRuntime>
	  >
	| OpenedWorkspace<
			TTables,
			WorkspaceKvFor<TKvMount, TKv>,
			'replica',
			WorkspaceDocumentOpenerFor<TDocumentRuntime>
	  >
> {
	assertWorkspaceDefinition(definition);
	const authority = normalizeWorkspaceAuthority(options.authority);
	const worker = options.worker();
	let stopSyncBridge: (() => void) | undefined;
	let initialization: BrowserWorkspaceWorkerInitialization;
	let transfer: Transferable[] = [];
	try {
		if (authority.kind === 'server') {
			const serverOptions = options as OpenBrowserServerWorkspaceOptions<
				TKvMount,
				TDocumentRuntime
			>;
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

	return authority.kind === 'server'
		? openWorkspaceFromService<
				TTables,
				TKv,
				'replica',
				TKvMount,
				TDocumentRuntime
			>(definition, {
				...options,
				service,
				expectedKind: 'replica',
			})
		: openWorkspaceFromService<
				TTables,
				TKv,
				'standalone',
				TKvMount,
				TDocumentRuntime
			>(definition, {
				...options,
				service,
				expectedKind: 'standalone',
			});
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
