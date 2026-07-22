import type { BrowserReplicaOwner } from './browser-owner.js';
import type {
	BrowserReplicaOwnerResult,
	BrowserReplicaStoreOperation,
} from './browser-owner-protocol.js';

/** Bind the semantic RPC operations to one live browser replica owner. */
export function createBrowserReplicaOwnerOperations(
	owner: BrowserReplicaOwner,
) {
	return {
		execute(
			operation: BrowserReplicaStoreOperation,
		): BrowserReplicaOwnerResult {
			switch (operation.kind) {
				case 'record':
					return owner.store.record(operation.address);
				case 'sync':
					return owner.store.sync();
				case 'sealed-request':
					return owner.store.sealedRequest();
				case 'local-write':
					owner.store.localWrite(operation.intent);
					return undefined;
				case 'seal':
					return owner.store.seal();
				case 'reconstruct-sealed-request':
					return owner.store.reconstructSealedRequest();
				case 'install-facts':
					owner.store.installFacts(operation.page);
					return undefined;
				case 'settle':
					owner.store.settle(operation.response);
					return undefined;
				case 'erase':
					owner.store.erase();
					return undefined;
				case 'integrity-check':
					owner.integrityCheck();
					return undefined;
				case 'reopen':
					owner.reopen();
					return undefined;
			}
		},
	};
}
