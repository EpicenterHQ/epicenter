import { publicationStatus } from '../../runtime/publication-status.js';
import type { BrowserReplicaOwner } from './browser-owner.js';
import type {
	BrowserReplicaOwnerResult,
	BrowserReplicaStoreOperation,
} from './browser-owner-protocol.js';

function terminal(
	lanes: ReturnType<BrowserReplicaOwner['store']['record']>,
): boolean {
	return (
		lanes?.confirmed?.state === 'tombstone' ||
		lanes?.sealed?.op === 'tombstone' ||
		lanes?.pending?.op === 'tombstone'
	);
}

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
				case 'attachment':
					return owner.store.attachment();
				case 'is-logically-empty':
					return owner.store.isLogicallyEmpty();
				case 'visible-record':
					return owner.store.visibleRecord(operation.address);
				case 'visible-records-page':
					return owner.store.visibleRecordsPage(
						operation.namespace,
						operation.collection,
						operation.afterRecordKey,
						operation.limit,
					);
				case 'is-visibly-live':
					return owner.store.isVisiblyLive(operation.address);
				case 'blocked-records-page':
					return owner.store.blockedRecordsPage(
						operation.after,
						operation.limit,
					);
				case 'publication-status':
					return publicationStatus(owner.store, owner.blobs, operation.address);
				case 'runtime-table-update':
					if (!owner.store.isVisiblyLive(operation.intent.address)) {
						return { kind: 'record-not-live' };
					}
					owner.store.localWrite(operation.intent);
					return {
						kind: 'written',
						visible: owner.store.visibleRecord(operation.intent.address),
					};
				case 'runtime-delete-record':
					if (terminal(owner.store.record(operation.address))) return undefined;
					owner.store.localWrite({
						address: operation.address,
						op: 'tombstone',
					});
					return undefined;
				case 'runtime-value-write':
					if (terminal(owner.store.record(operation.intent.address))) {
						return { kind: 'record-not-live' };
					}
					owner.store.localWrite(operation.intent);
					return { kind: 'written' };
				case 'runtime-read-blob':
					if (!owner.store.isVisiblyLive(operation.address)) return null;
					{
						const bytes = await owner.blobs.read(operation.address);
						return owner.store.isVisiblyLive(operation.address) ? bytes : null;
					}
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
				case 'open-runtime-document':
					if (!owner.store.isVisiblyLive(operation.address)) {
						return { kind: 'record-not-live' };
					}
					{
						const update = owner.store.exportDocument(operation.address);
						return {
							kind: 'ready',
							...(update === undefined ? {} : { update }),
						};
					}
				case 'refresh-runtime-document': {
					const lanes = owner.store.record(operation.address);
					const terminal =
						lanes === null ||
						lanes.confirmed?.state === 'tombstone' ||
						lanes.sealed?.op === 'tombstone' ||
						lanes.pending?.op === 'tombstone';
					if (terminal) return { kind: 'terminal' };
					const update = owner.store.exportDocument(operation.address);
					return {
						kind: 'preserved',
						...(update === undefined ? {} : { update }),
					};
				}
				case 'document-publication':
					return owner.store.documentPublication(operation.address);
				case 'settle-document-publication':
					return owner.store.settleDocumentPublication(
						operation.address,
						operation.proof,
						operation.captured,
					);
				case 'capture-blob':
					return owner.blobs.capture(operation.address, operation.bytes);
				case 'inspect-blob':
					return owner.blobs.inspect(operation.address);
				case 'blob-publication':
					return owner.blobs.publication(operation.address);
				case 'settle-blob-publication':
					return owner.blobs.settle(operation.address, operation.acceptance);
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
