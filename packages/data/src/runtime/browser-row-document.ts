import * as Y from '@y/y';

import type { RecordAddress } from '../protocol/v1/index.js';
import type { BrowserReplicaCandidateOperation } from '../store/replica/browser-owner-protocol.js';
import { RuntimeError } from './errors.js';
import type { RowDocument } from './row-document.js';

type UpdateListener = (update: Uint8Array, origin: unknown) => void;
const hydrationOrigin = Symbol('epicenter-browser-document-hydration');

type BrowserDocumentEntry = {
	address: RecordAddress;
	addressKey: string;
	document: Y.Doc;
	references: number;
	isDestroyed: boolean;
	revocation: Error | undefined;
	persist: UpdateListener;
	persistenceTail: Promise<void>;
};

function key(address: RecordAddress): string {
	return JSON.stringify([
		address.namespace,
		address.collection,
		address.recordKey,
	]);
}

function revokedError(addressKey: string): Error {
	return RuntimeError.RevokedDocument({ address: addressKey }).error;
}

/**
 * Own one page-local live Y.Doc and one owner-confirmed persistence tail per
 * record address. The elected worker remains the only durable-state owner.
 */
export function createBrowserRowDocumentRegistry({
	request,
}: {
	request<TResult>(
		operation: BrowserReplicaCandidateOperation,
	): Promise<TResult>;
}) {
	const entries = new Map<string, BrowserDocumentEntry>();
	const opening = new Map<string, Promise<BrowserDocumentEntry | null>>();
	let isDisposed = false;
	let generation = 0;
	let generationFailure: Error | undefined;

	function destroy(entry: BrowserDocumentEntry): void {
		if (entry.isDestroyed) return;
		entry.isDestroyed = true;
		entry.document.off('updateV2', entry.persist);
		if (entries.get(entry.addressKey) === entry) {
			entries.delete(entry.addressKey);
		}
		entry.document.destroy();
	}

	function revoke(entry: BrowserDocumentEntry, cause: Error): void {
		if (entry.revocation !== undefined) return;
		entry.revocation = cause;
		destroy(entry);
	}

	async function hydrate(
		address: RecordAddress,
		addressKey: string,
		openingGeneration: number,
	): Promise<BrowserDocumentEntry | null> {
		const opened = await request<
			{ kind: 'ready'; update?: Uint8Array } | { kind: 'record-not-live' }
		>({ kind: 'open-runtime-document', address });
		if (opened.kind === 'record-not-live') return null;
		if (isDisposed) throw new Error('Epicenter is disposed');
		if (openingGeneration !== generation) {
			throw generationFailure ?? revokedError(addressKey);
		}
		const existing = entries.get(addressKey);
		if (existing !== undefined) return existing;

		const document = new Y.Doc({ gc: true });
		const entry: BrowserDocumentEntry = {
			address: structuredClone(address),
			addressKey,
			document,
			references: 0,
			isDestroyed: false,
			revocation: undefined,
			persistenceTail: Promise.resolve(),
			persist(update: Uint8Array, origin: unknown): void {
				if (origin === hydrationOrigin) return;
				if (entry.revocation !== undefined) throw entry.revocation;
				const copied = new Uint8Array(update);
				const append = async () => {
					await request<void>({
						kind: 'append-local-document',
						address: entry.address,
						update: copied,
					});
				};
				const tail = entry.persistenceTail.then(append);
				entry.persistenceTail = tail;
				void tail.catch((cause: unknown) => {
					const failure =
						cause instanceof Error
							? cause
							: new Error('Browser document persistence failed', { cause });
					revoke(entry, failure);
				});
			},
		};
		document.on('updateV2', entry.persist);
		try {
			if (opened.update !== undefined) {
				Y.applyUpdateV2(document, opened.update, hydrationOrigin);
			}
		} catch (cause) {
			document.off('updateV2', entry.persist);
			document.destroy();
			throw cause;
		}
		entries.set(addressKey, entry);
		return entry;
	}

	async function entryFor(
		address: RecordAddress,
	): Promise<BrowserDocumentEntry | null> {
		const addressKey = key(address);
		const existing = entries.get(addressKey);
		if (existing !== undefined) return existing;
		const pending = opening.get(addressKey);
		if (pending !== undefined) return pending;
		const created = hydrate(address, addressKey, generation);
		let finalized!: Promise<BrowserDocumentEntry | null>;
		finalized = created.finally(() => {
			if (opening.get(addressKey) === finalized) opening.delete(addressKey);
		});
		opening.set(addressKey, finalized);
		return finalized;
	}

	async function open(address: RecordAddress): Promise<RowDocument | null> {
		if (isDisposed) throw new Error('Epicenter is disposed');
		const entry = await entryFor(address);
		if (entry === null) return null;
		const openedEntry = entry;
		openedEntry.references += 1;
		let isHandleDisposed = false;
		const listeners = new Set<UpdateListener>();

		function requireUsable(): void {
			if (isHandleDisposed) throw new Error('Row document handle is disposed');
			if (openedEntry.revocation !== undefined) throw openedEntry.revocation;
			if (openedEntry.isDestroyed) throw revokedError(openedEntry.addressKey);
		}

		return Object.freeze({
			get: ((...args: Parameters<Y.Doc['get']>) => {
				requireUsable();
				return openedEntry.document.get(...args);
			}) as Y.Doc['get'],
			getText(name?: string) {
				requireUsable();
				return openedEntry.document.get(name);
			},
			transact<T>(run: (transaction: Y.Transaction) => T, origin?: unknown): T {
				requireUsable();
				return openedEntry.document.transact(run, origin);
			},
			export(): Uint8Array {
				requireUsable();
				return new Uint8Array(Y.encodeStateAsUpdateV2(openedEntry.document));
			},
			async whenDurable(): Promise<void> {
				requireUsable();
				const barrier = openedEntry.persistenceTail;
				await barrier;
				requireUsable();
			},
			observe(listener: UpdateListener): () => void {
				requireUsable();
				listeners.add(listener);
				openedEntry.document.on('updateV2', listener);
				return () => {
					listeners.delete(listener);
					openedEntry.document.off('updateV2', listener);
				};
			},
			async [Symbol.asyncDispose](): Promise<void> {
				if (isHandleDisposed) return;
				isHandleDisposed = true;
				for (const listener of listeners) {
					openedEntry.document.off('updateV2', listener);
				}
				listeners.clear();
				openedEntry.references -= 1;
				if (openedEntry.references !== 0) return;
				try {
					await openedEntry.persistenceTail;
				} finally {
					if (openedEntry.references === 0) destroy(openedEntry);
				}
			},
		});
	}

	async function invalidate(address: RecordAddress): Promise<void> {
		const entry = entries.get(key(address));
		if (entry === undefined || entry.revocation !== undefined || isDisposed) {
			return;
		}
		try {
			const refreshed = await request<
				{ kind: 'terminal' } | { kind: 'preserved'; update?: Uint8Array }
			>({ kind: 'refresh-runtime-document', address });
			if (entry.revocation !== undefined || isDisposed) return;
			if (refreshed.kind === 'terminal') {
				revoke(entry, revokedError(entry.addressKey));
				return;
			}
			if (refreshed.update !== undefined) {
				Y.applyUpdateV2(entry.document, refreshed.update, hydrationOrigin);
			}
		} catch (cause) {
			const failure =
				cause instanceof Error
					? cause
					: new Error('Browser document refresh failed', { cause });
			revoke(entry, failure);
			throw failure;
		}
	}

	async function invalidateAll(): Promise<void> {
		await Promise.all(
			[...entries.values()].map((entry) => invalidate(entry.address)),
		);
	}

	function revokeAll(cause?: Error): void {
		generation += 1;
		generationFailure = cause;
		opening.clear();
		for (const entry of [...entries.values()]) {
			revoke(entry, cause ?? revokedError(entry.addressKey));
		}
	}

	async function dispose(): Promise<void> {
		if (isDisposed) return;
		isDisposed = true;
		const tails = [...entries.values()].map((entry) => entry.persistenceTail);
		revokeAll(new Error('Epicenter is disposed'));
		await Promise.all(tails);
	}

	return { open, invalidate, invalidateAll, revokeAll, dispose };
}
