import * as Y from '@y/y';

/** Stable row identity shared by metadata and document providers. */
export type RowAddress = {
	table: string;
	rowId: string;
};

/**
 * The asynchronous seam between renderer-owned live documents and the
 * owner-side SQLite update log. Carriers differ per runtime (in-process
 * calls, Worker messages, host HTTP) but the capability is always exactly
 * load and append; owner lifecycle (capture, deletion, compaction policy)
 * is never reachable through renderer persistence.
 */
export type DocumentPersistence = {
	/** Read one document's ordered durable updates for hydration. */
	load(address: RowAddress): Promise<readonly Uint8Array[]>;
	/** Append one locally observed updateV2; resolves after the owner commits. */
	append(address: RowAddress, update: Uint8Array): Promise<void>;
};

/** One attached document's local persistence lifetime. */
export type DocumentPersistenceLease = {
	/** Resolves after persisted state has been replayed into the document. */
	whenLoaded: Promise<void>;
	/** Waits for the owner-commit persistence cut captured by this call. */
	whenDurable(): Promise<void>;
	/** Stops persistence after every update already observed has committed. */
	dispose(): Promise<void>;
};

/** Workspace-scoped attachment of live documents to their durable logs. */
export type DocumentStore = {
	/** Attach one live Yjs document to its durable update log. */
	attach(address: RowAddress, document: Y.Doc): DocumentPersistenceLease;
};

const hydrationOrigin = Object.freeze({ kind: 'document-log-hydration' });

/** The one owner of the row-address invariant shared by every document seam. */
export function assertRowAddress(address: RowAddress): void {
	if (
		typeof address.table !== 'string' ||
		address.table.length === 0 ||
		typeof address.rowId !== 'string' ||
		address.rowId.length === 0
	) {
		throw new TypeError('Document row address must contain a table and row id');
	}
}

/** Stable structured-address cache key; asserts the address before keying. */
export function rowAddressKey(address: RowAddress): string {
	assertRowAddress(address);
	return JSON.stringify([address.table, address.rowId]);
}

/**
 * The one shared persistence attachment implementation.
 *
 * Every runtime attaches live row documents the same way; only the injected
 * load/append carrier differs. Semantics preserved from the proven stores:
 *
 * - The updateV2 listener attaches before hydration begins, so an edit that
 *   races hydration is captured and appended.
 * - Hydration replays with a private origin and is never re-appended.
 * - `whenLoaded` means local owner hydration only, never network state.
 * - `whenDurable()` is an invocation-time barrier over every update observed
 *   before the call; later updates never extend an earlier cut.
 * - Update bytes are copied before crossing the asynchronous seam.
 * - Appends run sequentially per lease; a failed append stops the chain so
 *   a successor can never commit in front of a causal gap, and `whenDurable`
 *   reports the failure instead of lying.
 * - `dispose()` stops the listener first, then drains admitted appends.
 */
export function createDocumentStore(
	persistence: DocumentPersistence,
): DocumentStore {
	const active = new Set<string>();

	function attach(
		address: RowAddress,
		document: Y.Doc,
	): DocumentPersistenceLease {
		const key = rowAddressKey(address);
		if (active.has(key)) {
			throw new Error('Document persistence is already attached for this row');
		}
		active.add(key);

		const stableAddress = { table: address.table, rowId: address.rowId };
		let stopped = false;
		let disposePromise: Promise<void> | undefined;

		const hydration = (async () => {
			const parts = await persistence.load(stableAddress);
			for (const part of parts) {
				Y.applyUpdateV2(document, new Uint8Array(part), hydrationOrigin);
			}
			if (!document.isLoaded) document.emit('load', [document]);
		})();
		void hydration.catch(() => undefined);
		let durabilityTail: Promise<void> = hydration;

		const handleUpdate = (update: Uint8Array, origin: unknown) => {
			if (stopped || origin === hydrationOrigin) return;
			const owned = new Uint8Array(update);
			// Chaining on a rejected tail intentionally skips the append: after
			// one failure, persisting successors would commit a causal gap.
			durabilityTail = durabilityTail.then(() =>
				persistence.append(stableAddress, owned),
			);
			void durabilityTail.catch(() => undefined);
		};

		document.on('updateV2', handleUpdate);

		return {
			whenLoaded: hydration,
			whenDurable() {
				return durabilityTail;
			},
			dispose() {
				if (disposePromise !== undefined) return disposePromise;
				stopped = true;
				document.off('updateV2', handleUpdate);
				const cut = durabilityTail;
				disposePromise = cut.finally(() => {
					active.delete(key);
				});
				return disposePromise;
			},
		};
	}

	return { attach };
}
