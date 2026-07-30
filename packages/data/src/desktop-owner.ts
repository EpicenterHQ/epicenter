import type { Result } from 'wellcrafted/result';
import { epicenterPath, openBunEpicenter } from './bun.js';
import type { DesktopOperation, DesktopRequest } from './desktop-protocol.js';
import {
	applyRowDocumentUpdate,
	encodeRowDocumentState,
	type RowDocument,
} from './documents.js';
import {
	readTableEntriesPage,
	subscribeCommittedAddresses,
} from './epicenter.js';
import {
	type Inspection,
	type InspectionBounds,
	type InspectionError,
	openInspection,
} from './inspection.js';
import type { Address } from './protocol/index.js';
import { tableLens, valueLens } from './serialized-lens.js';

type OpenDocument = {
	surfaceId: string;
	document: RowDocument;
};

export const EPICENTER_SURFACE_NOT_OPEN_ERROR_NAME =
	'EpicenterSurfaceNotOpenError';

/** Open the one Bun-owned desktop Epicenter and its trusted-surface RPC owner. */
export async function createDesktopEpicenterOwner({
	directory,
}: {
	directory: string;
}) {
	const path = epicenterPath({ directory });
	const epicenter = await openBunEpicenter({ path });
	/**
	 * The surfaces that have opened and not yet disconnected.
	 *
	 * Membership is the whole of it. `open` adds a surface, `disconnect` removes
	 * it along with every document that surface opened, and an operation from a
	 * surface that is not a member is refused. There is no generation, token, or
	 * epoch to compare, and nothing on the wire carries a fencing token, so
	 * minting one here would only be a number nobody checks.
	 *
	 * Explicit disconnect is the only way out, which means a surface that dies
	 * abruptly does not leave. A WebView reload, crash, or kill leaves its id in
	 * this set and its {@link OpenDocument}s in `documents`, each holding a live
	 * row document, until the host process exits. Observation socket loss is the
	 * only related signal the host receives, and it carries no surface identity
	 * to attribute it to or proof that the surface died.
	 *
	 * That is a known retention cost rather than a correctness one: a stale
	 * member can issue nothing, because the surface that could have named it is
	 * gone. Socket close cannot simply become `disconnect`: transient carrier
	 * gaps are recoverable and the existing row-document handles must survive
	 * them. Reclamation therefore needs a real lease or terminal-death protocol,
	 * not an unload callback or a query parameter.
	 */
	const surfaces = new Set<string>();
	const documents = new Map<number, OpenDocument>();
	let operationTail = Promise.resolve();
	let nextDocumentId = 0;

	async function closeDocument(documentId: number): Promise<void> {
		const opened = documents.get(documentId);
		if (opened === undefined) return;
		documents.delete(documentId);
		await opened.document[Symbol.asyncDispose]();
	}

	async function executeOperation(
		surfaceId: string,
		operation: DesktopOperation,
	): Promise<unknown> {
		if (operation.kind === 'open') {
			surfaces.add(surfaceId);
			return undefined;
		}
		if (operation.kind === 'disconnect') {
			for (const [documentId, opened] of documents) {
				if (opened.surfaceId === surfaceId) await closeDocument(documentId);
			}
			surfaces.delete(surfaceId);
			return undefined;
		}
		if (!surfaces.has(surfaceId)) {
			const cause = new Error(
				'Desktop Epicenter holds no open surface for this request',
			);
			cause.name = EPICENTER_SURFACE_NOT_OPEN_ERROR_NAME;
			throw cause;
		}

		switch (operation.kind) {
			case 'table-create':
				return tableLens(epicenter, operation.definition).create(
					operation.fields,
				);
			case 'table-get':
				return tableLens(epicenter, operation.definition).get(
					operation.address.rowId,
				);
			case 'table-update':
				return tableLens(epicenter, operation.definition).update(
					operation.address.rowId,
					// The carrier named the two halves because JSON cannot hold an
					// `undefined`; the lens takes one patch, so they are put back
					// together here at the edge that has to speak both.
					{
						...operation.set,
						...Object.fromEntries(
							operation.unset.map((name) => [name, undefined]),
						),
					},
				);
			case 'table-delete':
				return tableLens(epicenter, operation.definition).delete(
					operation.address.rowId,
				);
			case 'table-entries-page':
				return tableLens(epicenter, operation.definition)[readTableEntriesPage](
					operation.after,
				);
			case 'value-get':
				return valueLens(epicenter, operation.definition).get();
			case 'value-set':
				return valueLens(epicenter, operation.definition).set(operation.value);
			case 'value-unset':
				return valueLens(epicenter, operation.definition).unset();
			case 'document-open': {
				const lens = tableLens(epicenter, operation.definition);
				const document = await lens.openDocument(operation.address.rowId);
				try {
					const documentId = ++nextDocumentId;
					documents.set(documentId, {
						surfaceId,
						document,
					});
					return {
						documentId,
						update: encodeBytes(encodeRowDocumentState(document)),
					};
				} catch (cause) {
					await document[Symbol.asyncDispose]();
					throw cause;
				}
			}
			case 'document-update': {
				const opened = documents.get(operation.documentId);
				if (opened === undefined) throw new Error('Row document is not open');
				applyRowDocumentUpdate(opened.document, decodeBytes(operation.update));
				return undefined;
			}
			case 'document-refresh': {
				const opened = documents.get(operation.documentId);
				if (opened === undefined) throw new Error('Row document is not open');
				return encodeBytes(encodeRowDocumentState(opened.document));
			}
			case 'document-pull': {
				const opened = documents.get(operation.documentId);
				if (opened === undefined) throw new Error('Row document is not open');
				return opened.document.pull();
			}
			case 'document-issue': {
				const opened = documents.get(operation.documentId);
				if (opened === undefined) throw new Error('Row document is not open');
				return opened.document.syncIssue();
			}
			case 'document-close':
				await closeDocument(operation.documentId);
				return undefined;
			default:
				return operation satisfies never;
		}
	}

	return Object.freeze({
		epicenter,
		/**
		 * Forward every committed batch to one attached surface carrier.
		 *
		 * The owner deliberately keeps no per-table interest registry and no
		 * per-surface filter. It does not know which Lenses a surface has bound,
		 * and asking it to would mean surfaces registering interest, the host
		 * holding that registration, and both agreeing about it forever. The
		 * client already knows exactly which handles exist, so it does the
		 * filtering and the host stays a pipe.
		 */
		subscribeInvalidations(
			listener: (changes: readonly Address[]) => void,
		): () => void {
			return epicenter[subscribeCommittedAddresses](listener);
		},
		/**
		 * Open one read-only relational inspection connection on this store.
		 *
		 * Deliberately a method on the owner object rather than a `DesktopOperation`.
		 * Application surfaces hold a message port and can only reach `execute`, so
		 * "applications receive no SQL" (ADR-0162) is a consequence of the object
		 * graph rather than a rule someone has to keep enforcing in a switch. Only
		 * the native host, which constructed this owner, can call it.
		 *
		 * The caller owns the returned connection and must close it.
		 */
		openInspection(
			bounds?: InspectionBounds,
		): Result<Inspection, InspectionError> {
			return openInspection(bounds === undefined ? { path } : { path, bounds });
		},
		execute(input: unknown): Promise<unknown> {
			const request = parseDesktopRequest(input);
			// A pull awaits the network; running it on the local queue would
			// stall every SQLite operation behind it. The document runtime owns
			// pull overlap and disposal safety.
			if (request.operation.kind === 'document-pull') {
				return Promise.resolve().then(() =>
					executeOperation(request.surfaceId, request.operation),
				);
			}
			const execution = operationTail.then(() =>
				executeOperation(request.surfaceId, request.operation),
			);
			operationTail = execution.then(
				() => undefined,
				() => undefined,
			);
			return execution;
		},
		async [Symbol.asyncDispose](): Promise<void> {
			await operationTail;
			for (const documentId of [...documents.keys()]) {
				await closeDocument(documentId);
			}
			surfaces.clear();
			await epicenter[Symbol.asyncDispose]();
		},
	});
}

export type DesktopEpicenterOwner = Awaited<
	ReturnType<typeof createDesktopEpicenterOwner>
>;

function parseDesktopRequest(input: unknown): DesktopRequest {
	if (
		typeof input !== 'object' ||
		input === null ||
		Array.isArray(input) ||
		!('surfaceId' in input) ||
		typeof input.surfaceId !== 'string' ||
		input.surfaceId.length === 0 ||
		!('operation' in input) ||
		typeof input.operation !== 'object' ||
		input.operation === null ||
		!('kind' in input.operation) ||
		typeof input.operation.kind !== 'string'
	) {
		throw new TypeError('Invalid desktop Epicenter request');
	}
	return input as DesktopRequest;
}

function encodeBytes(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

function decodeBytes(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, 'base64'));
}
