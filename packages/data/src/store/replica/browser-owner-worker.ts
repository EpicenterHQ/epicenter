import {
	type BrowserReplicaOwner,
	openBrowserReplicaOwner,
} from './browser-owner.js';
import { createBrowserReplicaOwnerOperations } from './browser-owner-operations.js';
import type {
	BrowserReplicaOwnerMessage,
	BrowserReplicaOwnerOperation,
	BrowserReplicaOwnerRequest,
	BrowserReplicaOwnerResult,
} from './browser-owner-protocol.js';

export type BrowserReplicaOwnerWorkerScope = {
	postMessage(message: BrowserReplicaOwnerMessage): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserReplicaOwnerRequest }) => void,
	): void;
	close?(): void;
};

function serializeError(cause: unknown): { name: string; message: string } {
	if (cause instanceof Error) {
		return { name: cause.name, message: cause.message };
	}
	return { name: 'Error', message: String(cause) };
}

/** Bind the semantic replica RPC surface to one dedicated-worker scope. */
export function startBrowserReplicaOwnerWorker(
	scope: BrowserReplicaOwnerWorkerScope,
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
					...(operation.initialize === undefined
						? {}
						: { initialize: operation.initialize }),
					...(operation.storage ?? {}),
				});
				operations = createBrowserReplicaOwnerOperations(owner);
				return undefined;
			}
			case 'record':
			case 'sync':
			case 'sealed-request':
			case 'local-write':
			case 'seal':
			case 'reconstruct-sealed-request':
			case 'install-facts':
			case 'settle':
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
