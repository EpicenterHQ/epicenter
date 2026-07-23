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
		async execute(
			operation: BrowserReplicaStoreOperation,
		): Promise<BrowserReplicaOwnerResult> {
			switch (operation.kind) {
				case 'record':
					return owner.store.record(operation.address);
				case 'sync':
					return owner.store.sync();
				case 'sealed-request':
					return owner.store.sealedRequest();
				case 'owed-documents':
					return owner.store.owedDocuments(operation.limit);
				case 'owed-blobs':
					return owner.store.owedBlobs(operation.limit);
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
				case 'append-local-document':
					owner.store.appendLocalDocumentUpdate(
						operation.address,
						operation.update,
					);
					return undefined;
				case 'install-accepted-document':
					owner.store.installAcceptedDocumentUpdate(
						operation.address,
						operation.update,
					);
					return undefined;
				case 'inspect-document':
					return owner.store.inspectDocument(operation.address);
				case 'export-document':
					return owner.store.exportDocument(operation.address);
				case 'document-publication':
					return owner.store.documentPublication(
						operation.address,
						operation.stateVector,
					);
				case 'settle-document-publication':
					owner.store.settleDocumentPublication(
						operation.address,
						operation.proof,
						operation.captured,
					);
					return undefined;
				case 'capture-blob':
					return owner.blobs.capture(operation.address, operation.bytes);
				case 'inspect-blob':
					return owner.blobs.inspect(operation.address);
				case 'blob-publication':
					return owner.blobs.publication(operation.address);
				case 'settle-blob-publication':
					await owner.blobs.settle(operation.address, operation.acceptance);
					return undefined;
				case 'read-blob':
					return owner.blobs.read(operation.address);
				case 'sweep-blob-debris':
					await owner.blobs.sweepDebris();
					return undefined;
				case 'erase':
					owner.store.erase();
					await owner.blobs.sweepDebris();
					return undefined;
				case 'integrity-check':
					owner.integrityCheck();
					return undefined;
				case 'reopen':
					await owner.reopen();
					return undefined;
			}
		},
	};
}
