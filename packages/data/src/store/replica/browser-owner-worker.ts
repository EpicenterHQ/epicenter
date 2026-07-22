import {
	type BrowserReplicaOwner,
	openBrowserReplicaOwner,
} from './browser-owner.js';
import type {
	BrowserReplicaOwnerMessage,
	BrowserReplicaOwnerOperation,
	BrowserReplicaOwnerRequest,
	BrowserReplicaOwnerResult,
} from './browser-owner-protocol.js';
import type { ReplicaStore } from './replica-store.js';

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

function requireStore(owner: BrowserReplicaOwner | undefined): ReplicaStore {
	if (owner === undefined) throw new Error('browser replica owner is not open');
	return owner.store;
}

/** Bind the semantic replica RPC surface to one dedicated-worker scope. */
export function startBrowserReplicaOwnerWorker(
	scope: BrowserReplicaOwnerWorkerScope,
): void {
	let owner: BrowserReplicaOwner | undefined;
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
				return undefined;
			}
			case 'record':
				return requireStore(owner).record(operation.address);
			case 'sync':
				return requireStore(owner).sync();
			case 'sealed-request':
				return requireStore(owner).sealedRequest();
			case 'local-write':
				requireStore(owner).localWrite(operation.intent);
				return undefined;
			case 'seal':
				return requireStore(owner).seal();
			case 'reconstruct-sealed-request':
				return requireStore(owner).reconstructSealedRequest();
			case 'install-facts':
				requireStore(owner).installFacts(operation.page);
				return undefined;
			case 'settle':
				requireStore(owner).settle(operation.response);
				return undefined;
			case 'erase':
				requireStore(owner).erase();
				return undefined;
			case 'integrity-check':
				if (owner === undefined)
					throw new Error('browser replica owner is not open');
				owner.integrityCheck();
				return undefined;
			case 'reopen':
				if (owner === undefined)
					throw new Error('browser replica owner is not open');
				owner.reopen();
				return undefined;
			case 'dispose': {
				const opened = owner;
				owner = undefined;
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
