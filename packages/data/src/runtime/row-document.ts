import * as Y from '@y/y';

import { type Err, Ok, type Result, trySync } from 'wellcrafted/result';

import type { RecordAddress } from '../protocol/v1/index.js';
import type { ReplicaStore } from '../store/replica/index.js';
import { type DocumentPullError, RuntimeError } from './errors.js';

type UpdateListener = (update: Uint8Array, origin: unknown) => void;
const hydrationOrigin = Symbol('epicenter-runtime-document-hydration');
const acceptedOrigin = Symbol('epicenter-runtime-document-accepted');

type LiveDocumentEntry = {
	addressKey: string;
	document: Y.Doc;
	references: number;
	isRevoked: boolean;
	isDestroyed: boolean;
	persist: UpdateListener;
	/**
	 * The authority version this entry last installed, or `null` before its
	 * first successful pull. It is a live conditional-request hint, not durable
	 * state: a fresh entry simply spends one full body.
	 */
	knownDocumentVersion: string | null;
};

/**
 * Read the authority's accepted state for one address (ADR-0171).
 *
 * The runtime supplies it from the carrier it was opened with. A runtime
 * without an authority supplies nothing, and `pull()` declines.
 */
export type DocumentPuller = (
	address: RecordAddress,
	request: { knownDocumentVersion: string | null },
) => Promise<
	| { kind: 'state'; documentVersion: string; update: Uint8Array }
	| { kind: 'unchanged'; documentVersion: string }
	| { kind: 'none' }
>;

/**
 * A revocable borrower of one runtime-shared document.
 *
 * Y shared types returned by `get` are document-scoped live references, not
 * per-handle copies. Terminal revocation detaches the shared document from
 * persistence and the runtime registry; any retained raw type then belongs
 * only to that unreachable orphaned document.
 */
export type RowDocument = {
	get: Y.Doc['get'];
	getText(name?: string): ReturnType<Y.Doc['get']>;
	transact<T>(run: (transaction: Y.Transaction) => T, origin?: unknown): T;
	export(): Uint8Array;
	whenDurable(): Promise<void>;
	observe(listener: UpdateListener): () => void;
	/**
	 * Ask the authority for newer accepted state (ADR-0171).
	 *
	 * Opening means local readiness, not remote freshness, so an application
	 * decides when to refresh: immediately after first render, on focus, on a
	 * timer, or never. Overlapping and repeated pulls are safe, accepted bytes
	 * install durably before they become live, and they create no outbound
	 * publication obligation. Every failure leaves the document open and
	 * usable.
	 */
	pull(): Promise<Result<void, DocumentPullError>>;
	[Symbol.asyncDispose](): Promise<void>;
};

function key(address: RecordAddress): string {
	return JSON.stringify([
		address.namespace,
		address.collection,
		address.recordKey,
	]);
}

export function createRowDocumentRegistry({
	store,
	onLocalUpdate,
	pullFrom,
}: {
	store: ReplicaStore;
	onLocalUpdate(address: RecordAddress): void;
	/** Absent on a runtime with no authority, which makes `pull()` decline. */
	pullFrom?: DocumentPuller;
}) {
	const entries = new Map<string, LiveDocumentEntry>();
	let disposed = false;

	function destroy(entry: LiveDocumentEntry): void {
		if (entry.isDestroyed) return;
		entry.isDestroyed = true;
		entry.document.off('updateV2', entry.persist);
		if (entries.get(entry.addressKey) === entry) {
			entries.delete(entry.addressKey);
		}
		entry.document.destroy();
	}

	function revoke(entry: LiveDocumentEntry): void {
		if (entry.isRevoked) return;
		entry.isRevoked = true;
		destroy(entry);
	}

	function revokeAll(): void {
		for (const entry of [...entries.values()]) revoke(entry);
	}

	function hydrate(
		address: RecordAddress,
		addressKey: string,
	): LiveDocumentEntry {
		const document = new Y.Doc({ gc: true });
		try {
			const initial = store.exportDocument(address);
			if (initial !== undefined) {
				Y.applyUpdateV2(document, initial, hydrationOrigin);
			}
		} catch (cause) {
			document.destroy();
			throw cause;
		}
		const entry: LiveDocumentEntry = {
			addressKey,
			document,
			references: 0,
			isRevoked: false,
			isDestroyed: false,
			knownDocumentVersion: null,
			persist(update: Uint8Array, origin: unknown): void {
				if (origin === hydrationOrigin || origin === acceptedOrigin) return;
				if (entry.isRevoked) {
					throw RuntimeError.RevokedDocument({ address: addressKey }).error;
				}
				store.appendLocalDocumentUpdate(address, new Uint8Array(update));
				onLocalUpdate(address);
			},
		};
		document.on('updateV2', entry.persist);
		entries.set(addressKey, entry);
		return entry;
	}

	/**
	 * Install one pulled authority state, or explain why it could not be.
	 *
	 * Every fence is rechecked after the request resolves rather than before it
	 * is sent, because that is the only ordering a concurrent disposal,
	 * revocation, or authority replacement cannot slip through. The install
	 * itself is durable first and live second, and it uses the accepted origin
	 * so it never re-enters the local persist path as new owed work.
	 */
	async function pull(
		address: RecordAddress,
		entry: LiveDocumentEntry,
	): Promise<Result<void, DocumentPullError>> {
		if (pullFrom === undefined) {
			return RuntimeError.DocumentPullUnavailable({
				address: entry.addressKey,
			});
		}
		const answered = await tryPull(address, entry, pullFrom);
		if (answered.error !== null) return answered as Err<DocumentPullError>;
		const pulled = answered.data;
		if (pulled.kind !== 'state') {
			if (pulled.kind === 'unchanged') {
				entry.knownDocumentVersion = pulled.documentVersion;
			}
			return Ok(undefined);
		}
		if (disposed || entry.isRevoked || entry.isDestroyed) {
			return RuntimeError.RevokedDocument({ address: entry.addressKey });
		}
		const { error } = trySync({
			try: () => {
				store.installAcceptedDocumentUpdate(address, pulled.update);
				Y.applyUpdateV2(entry.document, pulled.update, acceptedOrigin);
			},
			catch: (cause) =>
				RuntimeError.DocumentPullFailed({ address: entry.addressKey, cause }),
		});
		if (error !== null) return { data: null, error };
		entry.knownDocumentVersion = pulled.documentVersion;
		return Ok(undefined);
	}

	async function tryPull(
		address: RecordAddress,
		entry: LiveDocumentEntry,
		puller: DocumentPuller,
	): Promise<Result<Awaited<ReturnType<DocumentPuller>>, DocumentPullError>> {
		try {
			return Ok(
				await puller(address, {
					knownDocumentVersion: entry.knownDocumentVersion,
				}),
			);
		} catch (cause) {
			return RuntimeError.DocumentPullFailed({
				address: entry.addressKey,
				cause,
			});
		}
	}

	function open(address: RecordAddress): RowDocument {
		if (disposed) throw new Error('Epicenter is disposed');
		const addressKey = key(address);
		const entry = entries.get(addressKey) ?? hydrate(address, addressKey);
		entry.references += 1;
		let handleDisposed = false;
		const listeners = new Set<UpdateListener>();

		function requireUsable(): void {
			if (handleDisposed) throw new Error('Row document handle is disposed');
			if (entry.isRevoked)
				throw RuntimeError.RevokedDocument({ address: addressKey }).error;
		}

		return Object.freeze({
			get: ((...args: Parameters<Y.Doc['get']>) => {
				requireUsable();
				return entry.document.get(...args);
			}) as Y.Doc['get'],
			getText(name?: string) {
				requireUsable();
				return entry.document.get(name);
			},
			transact<T>(run: (transaction: Y.Transaction) => T, origin?: unknown): T {
				requireUsable();
				return entry.document.transact(run, origin);
			},
			export(): Uint8Array {
				requireUsable();
				return new Uint8Array(Y.encodeStateAsUpdateV2(entry.document));
			},
			async whenDurable(): Promise<void> {
				// In-process appends commit synchronously inside persist; the
				// method exists so RPC-backed runtimes can honor real latency.
				requireUsable();
			},
			observe(listener: UpdateListener): () => void {
				requireUsable();
				listeners.add(listener);
				entry.document.on('updateV2', listener);
				return () => {
					listeners.delete(listener);
					entry.document.off('updateV2', listener);
				};
			},
			async pull(): Promise<Result<void, DocumentPullError>> {
				if (handleDisposed || entry.isRevoked || entry.isDestroyed) {
					return RuntimeError.RevokedDocument({ address: addressKey });
				}
				return await pull(address, entry);
			},
			async [Symbol.asyncDispose](): Promise<void> {
				if (handleDisposed) return;
				handleDisposed = true;
				for (const listener of listeners) {
					entry.document.off('updateV2', listener);
				}
				listeners.clear();
				entry.references -= 1;
				if (entry.references === 0) destroy(entry);
			},
		});
	}

	return {
		open,
		invalidate(address: RecordAddress): void {
			// Only the terminal tombstone revokes open handles; reversible unset
			// leaves the document chain and its handles intact (ADR-0160).
			const lanes = store.record(address);
			const terminal =
				lanes === null ||
				lanes.confirmed?.state === 'tombstone' ||
				lanes.sealed?.op === 'tombstone' ||
				lanes.pending?.op === 'tombstone';
			if (!terminal) return;
			const entry = entries.get(key(address));
			if (entry !== undefined) revoke(entry);
		},
		revokeAll,
		dispose(): void {
			if (disposed) return;
			disposed = true;
			revokeAll();
		},
	};
}
