/// <reference lib="dom" />

import * as Y from 'yjs';
import { createDisposableCache } from '../cache/disposable-cache.js';
import { attachBroadcastChannel } from '../document/attach-broadcast-channel.js';
import { attachIndexedDb } from '../document/attach-indexed-db.js';
import type { NodeId } from '../document/node-id.js';
import {
	type OnReconnectSignal,
	type OpenWebSocketFn,
	openCollaboration,
} from '../document/open-collaboration.js';
import { roomWsUrl } from '../document/transport.js';
import type { Guid } from '../shared/id.js';
import type { WorkspaceDefinition } from './definition.js';
import type {
	WorkspaceDocumentRuntime,
	WorkspaceDocumentSession,
} from './document-client.js';
import type { WorkspaceKvMount } from './open.js';
import {
	normalizeWorkspaceAuthority,
	type ServerWorkspaceAuthority,
	type WorkspaceAuthority,
	workspaceAuthorityHash,
} from './workspace-authority.js';

/** Auth-owned capabilities required to synchronize the Yjs workspace planes. */
export type BrowserWorkspaceDocumentSync = {
	readonly nodeId: NodeId;
	readonly openWebSocket: OpenWebSocketFn;
	readonly onReconnectSignal: OnReconnectSignal;
};

export type BrowserWorkspaceDocumentPlanes = AsyncDisposable & {
	readonly kv: WorkspaceKvMount;
	readonly documents: WorkspaceDocumentRuntime;
};

type BrowserWorkspaceDocumentPlaneOptions = {
	/** Grace period for reusing an unopened child room. Defaults to 5 seconds. */
	documentGcTime?: number;
};

/** Authority-qualified IndexedDB and BroadcastChannel name for one Yjs room. */
export async function browserWorkspaceDocumentDatabaseName(
	guid: string,
	authority: WorkspaceAuthority,
): Promise<string> {
	return `${guid}.${await browserWorkspaceDocumentAuthoritySuffix(authority)}`;
}

async function browserWorkspaceDocumentAuthoritySuffix(
	authority: WorkspaceAuthority,
): Promise<string> {
	const normalized = normalizeWorkspaceAuthority(authority);
	if (normalized.kind === 'local') return 'standalone';
	return `replica-${await workspaceAuthorityHash(normalized)}`;
}

/**
 * Own the browser KV document and every lazily opened child-document session.
 *
 * Local persistence is always hydrated before a handle reports readiness.
 * Server collaboration starts behind that hydration barrier but does not block
 * offline use while the network is unavailable.
 */
export async function createBrowserWorkspaceDocumentPlanes(
	definition: WorkspaceDefinition,
	options:
		| (BrowserWorkspaceDocumentPlaneOptions & {
				authority: Extract<WorkspaceAuthority, { kind: 'local' }>;
				sync?: never;
		  })
		| (BrowserWorkspaceDocumentPlaneOptions & {
				authority: ServerWorkspaceAuthority;
				sync: BrowserWorkspaceDocumentSync;
		  })
		| (BrowserWorkspaceDocumentPlaneOptions & {
				authority: WorkspaceAuthority;
				sync: BrowserWorkspaceDocumentSync;
		  }),
): Promise<BrowserWorkspaceDocumentPlanes> {
	const authority = normalizeWorkspaceAuthority(options.authority);
	const sync = 'sync' in options ? options.sync : undefined;
	const serverSync = authority.kind === 'server' ? sync : undefined;
	if (authority.kind === 'server' && !serverSync) {
		throw new TypeError(
			'A server workspace authority requires document synchronization',
		);
	}
	const authoritySuffix =
		await browserWorkspaceDocumentAuthoritySuffix(authority);
	const storageClosures = new Set<Promise<unknown>>();
	let disposed = false;

	function openRoom(guid: Guid): WorkspaceDocumentSession {
		if (disposed) throw new Error('Workspace document runtime is disposed');
		const doc = new Y.Doc({ guid, gc: true });
		const databaseName = `${guid}.${authoritySuffix}`;
		const storage = attachIndexedDb(doc, { databaseName });
		storageClosures.add(storage.whenDisposed);
		void storage.whenDisposed.finally(() =>
			storageClosures.delete(storage.whenDisposed),
		);
		attachBroadcastChannel(doc, databaseName);
		if (authority.kind === 'server') {
			if (!serverSync) {
				throw new TypeError(
					'A server workspace authority requires document synchronization',
				);
			}
			openCollaboration(doc, {
				url: roomWsUrl({
					baseURL: authority.baseURL,
					guid,
					nodeId: serverSync.nodeId,
				}),
				openWebSocket: serverSync.openWebSocket,
				onReconnectSignal: serverSync.onReconnectSignal,
				waitFor: storage.whenLoaded,
			});
		}
		return {
			doc,
			whenReady: storage.whenLoaded,
			[Symbol.dispose]() {
				doc.destroy();
			},
		};
	}

	const kvSession = openRoom(definition.kvDocumentGuid as Guid);
	const sessions = createDisposableCache((guid: Guid) => openRoom(guid), {
		gcTime: options.documentGcTime,
	});
	let disposePromise: Promise<void> | undefined;
	const dispose = async (): Promise<void> => {
		if (disposePromise) return disposePromise;
		disposed = true;
		sessions[Symbol.dispose]();
		kvSession[Symbol.dispose]();
		disposePromise = Promise.all([...storageClosures]).then(() => undefined);
		return disposePromise;
	};

	return {
		kv: { doc: kvSession.doc, whenHydrated: kvSession.whenReady },
		documents: {
			open(guid) {
				return sessions.open(guid);
			},
		},
		[Symbol.asyncDispose]: dispose,
	};
}
