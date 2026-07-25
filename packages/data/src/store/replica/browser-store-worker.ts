import {
	type BrowserReplicaOwner,
	openBrowserReplicaOwner,
} from './browser-owner.js';
import { createBrowserReplicaOwnerOperations } from './browser-owner-operations.js';
import type {
	BrowserReplicaOwnerOperation,
	BrowserReplicaOwnerResult,
} from './browser-owner-protocol.js';

type BrowserReplicaStoreRequest = {
	type: 'request';
	id: number;
	operation: BrowserReplicaOwnerOperation;
};

type BrowserReplicaStoreMessage =
	| { type: 'result'; id: number; value: BrowserReplicaOwnerResult }
	| { type: 'error'; id: number; name: string; message: string };

export type BrowserReplicaStoreWorkerScope = {
	postMessage(message: BrowserReplicaStoreMessage): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserReplicaStoreRequest }) => void,
	): void;
	close?(): void;
};

function serializeError(cause: unknown): { name: string; message: string } {
	if (cause instanceof Error) {
		return { name: cause.name, message: cause.message };
	}
	return { name: 'Error', message: String(cause) };
}

/**
 * Bind the raw replica store RPC surface to one dedicated-worker scope.
 *
 * This is the storage conformance harness, not the product path: it opens the
 * physical owner and answers store operations with no supervisor, carrier, or
 * runtime above it, so browser evidence can assert SQLite and OPFS behavior
 * directly. The application always opens `startBrowserReplicaOwnerWorker`.
 */
export function startBrowserReplicaStoreWorker(
	scope: BrowserReplicaStoreWorkerScope,
): void {
	let owner: BrowserReplicaOwner | undefined;
	let operations:
		| ReturnType<typeof createBrowserReplicaOwnerOperations>
		| undefined;
	let requestTail = Promise.resolve();

	async function execute(
		operation: BrowserReplicaOwnerOperation,
	): Promise<BrowserReplicaOwnerResult> {
		switch (operation.kind) {
			case 'open': {
				if (owner !== undefined)
					throw new Error('browser replica owner is already open');
				owner = await openBrowserReplicaOwner({
					limits: operation.limits,
					owner: operation.owner,
					...(operation.initialize === undefined
						? {}
						: { initialize: operation.initialize }),
					...(operation.storage ?? {}),
				});
				operations = createBrowserReplicaOwnerOperations(owner);
				return undefined;
			}
			case 'record':
			case 'visible-record':
			case 'visible-records-page':
			case 'is-visibly-live':
			case 'blocked-records-page':
			case 'publication-status':
			case 'runtime-table-update':
			case 'runtime-put-record':
			case 'runtime-delete-record':
			case 'runtime-value-write':
			case 'runtime-read-blob':
			case 'sync':
			case 'sealed-request':
			case 'owed-documents':
			case 'owed-blobs':
			case 'local-write':
			case 'seal':
			case 'reconstruct-sealed-request':
			case 'install-facts':
			case 'settle':
			case 'append-local-document':
			case 'install-accepted-document':
			case 'inspect-document':
			case 'export-document':
			case 'open-runtime-document':
			case 'refresh-runtime-document':
			case 'document-publication':
			case 'settle-document-publication':
			case 'capture-blob':
			case 'inspect-blob':
			case 'blob-publication':
			case 'settle-blob-publication':
			case 'read-blob':
			case 'sweep-blob-debris':
			case 'erase':
			case 'integrity-check':
			case 'reopen':
				if (operations === undefined)
					throw new Error('browser replica owner is not open');
				return operations.execute(operation);
			case 'dispose': {
				const opened = owner;
				owner = undefined;
				operations = undefined;
				await opened?.dispose();
				return undefined;
			}
		}
	}

	scope.addEventListener('message', ({ data: request }) => {
		requestTail = requestTail.then(async () => {
			try {
				const value = await execute(request.operation);
				scope.postMessage({ type: 'result', id: request.id, value });
				if (request.operation.kind === 'dispose') scope.close?.();
			} catch (cause) {
				const error = serializeError(cause);
				scope.postMessage({ type: 'error', id: request.id, ...error });
			}
		});
	});
}
