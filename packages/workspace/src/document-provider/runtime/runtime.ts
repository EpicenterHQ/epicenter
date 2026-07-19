import * as Y from '@y/y';
import {
	type DocumentPersistenceLease,
	type DocumentStore,
	type RowAddress,
	rowAddressKey,
} from '../persistence.js';

export type RowDocumentConnectionLease<TConnection> = {
	/** Restricted connection surface exposed through each document handle. */
	connection: TConnection;
	/** Stop this document's network lifecycle. */
	dispose(): void | Promise<void>;
};

export type RowDocument<TConnection = undefined> = {
	get: Y.Doc['get'];
	/** Group application-authored changes into one local Yjs transaction. */
	transact<TValue>(
		callback: (transaction: Y.Transaction) => TValue,
		origin?: unknown,
	): TValue;
	/** Wait only for the local persistence cut captured by this call. */
	whenDurable(): Promise<void>;
	/** Optional document-local network status and observation surface. */
	readonly connection: TConnection | undefined;
	[Symbol.dispose](): void;
};

type CachedDocument<TConnection> = {
	address: RowAddress;
	document: Y.Doc;
	persistence: DocumentPersistenceLease;
	connectionLease: RowDocumentConnectionLease<TConnection> | undefined;
	references: number;
	revoked: Error | undefined;
};

/**
 * Own independently loadable row documents above one workspace document store.
 *
 * The runtime caches by structured address. Persistence attaches before any
 * network provider, and a handle is never returned before local hydration.
 */
export function createRowDocumentRuntime<TConnection = never>({
	isLive,
	store,
	connect,
}: {
	isLive(address: RowAddress): boolean | Promise<boolean>;
	store: DocumentStore;
	connect?: (
		address: RowAddress,
		document: Y.Doc,
	) => RowDocumentConnectionLease<TConnection>;
}) {
	const cached = new Map<string, CachedDocument<TConnection>>();
	const opening = new Map<string, Promise<CachedDocument<TConnection>>>();
	const closing = new Map<string, Promise<void>>();
	const epochs = new Map<string, number>();
	let disposed = false;
	let disposal: Promise<void> | undefined;

	function requireRuntimeOpen(): void {
		if (disposed) throw new Error('Row document runtime is disposed');
	}

	function epochOf(key: string): number {
		return epochs.get(key) ?? 0;
	}

	function requireCurrent(key: string, epoch: number): void {
		if (epochOf(key) !== epoch) {
			throw new Error('Row document was revoked during an active operation');
		}
	}

	async function requireLive(address: RowAddress): Promise<void> {
		if (await isLive(copyAddress(address))) return;
		throw new Error(
			`Cannot open document for absent row '${address.table}.${address.rowId}'`,
		);
	}

	async function teardown(entry: CachedDocument<TConnection>): Promise<void> {
		let failure: unknown;
		try {
			await entry.connectionLease?.dispose();
		} catch (cause) {
			failure = cause;
		}
		try {
			await entry.persistence.dispose();
		} catch (cause) {
			failure ??= cause;
		} finally {
			entry.document.destroy();
		}
		if (failure !== undefined) throw failure;
	}

	function startTeardown(
		key: string,
		entry: CachedDocument<TConnection>,
	): Promise<void> {
		if (cached.get(key) === entry) cached.delete(key);
		const existing = closing.get(key);
		if (existing) return existing;
		const pending = teardown(entry);
		closing.set(key, pending);
		void pending
			.catch(() => undefined)
			.finally(() => {
				if (closing.get(key) === pending) closing.delete(key);
			});
		return pending;
	}

	async function createEntry(
		address: RowAddress,
		key: string,
		epoch: number,
	): Promise<CachedDocument<TConnection>> {
		await closing.get(key);
		requireCurrent(key, epoch);
		await requireLive(address);
		requireCurrent(key, epoch);

		const document = new Y.Doc({ gc: true });
		const persistence = store.attach(copyAddress(address), document);
		let connectionLease: RowDocumentConnectionLease<TConnection> | undefined;
		try {
			await persistence.whenLoaded;
			requireCurrent(key, epoch);
			await requireLive(address);
			requireCurrent(key, epoch);
			connectionLease = connect?.(copyAddress(address), document);
			const entry: CachedDocument<TConnection> = {
				address: copyAddress(address),
				document,
				persistence,
				connectionLease,
				references: 0,
				revoked: undefined,
			};
			cached.set(key, entry);
			return entry;
		} catch (cause) {
			try {
				await connectionLease?.dispose();
			} finally {
				try {
					await persistence.dispose();
				} finally {
					document.destroy();
				}
			}
			throw cause;
		}
	}

	function getOrCreate(
		address: RowAddress,
	): Promise<CachedDocument<TConnection>> {
		requireRuntimeOpen();
		const key = rowAddressKey(address);
		const existing = cached.get(key);
		if (existing) return Promise.resolve(existing);
		const pending = opening.get(key);
		if (pending) return pending;
		const epoch = epochOf(key);
		const created = createEntry(copyAddress(address), key, epoch);
		opening.set(key, created);
		void created
			.catch(() => undefined)
			.finally(() => {
				if (opening.get(key) === created) opening.delete(key);
			});
		return created;
	}

	function createHandle(
		entry: CachedDocument<TConnection>,
	): RowDocument<TConnection> {
		const key = rowAddressKey(entry.address);
		let disposed = false;
		entry.references += 1;

		function requireUsable(): void {
			if (disposed) throw new Error('Row document handle is disposed');
			if (entry.revoked) throw entry.revoked;
		}

		const handle: RowDocument<TConnection> = {
			get: ((...args: Parameters<Y.Doc['get']>) => {
				requireUsable();
				return entry.document.get(...args);
			}) as Y.Doc['get'],
			transact<TValue>(
				callback: (transaction: Y.Transaction) => TValue,
				origin?: unknown,
			): TValue {
				requireUsable();
				return entry.document.transact(callback, origin);
			},
			async whenDurable(): Promise<void> {
				requireUsable();
				await entry.persistence.whenDurable();
				requireUsable();
			},
			connection: entry.connectionLease?.connection,
			[Symbol.dispose](): void {
				if (disposed) return;
				disposed = true;
				entry.references -= 1;
				if (entry.references === 0 && entry.revoked === undefined) {
					void startTeardown(key, entry).catch(() => undefined);
				}
			},
		};
		return handle;
	}

	async function revokeEntry(
		address: RowAddress,
		cause?: Error,
	): Promise<void> {
		const key = rowAddressKey(address);
		epochs.set(key, epochOf(key) + 1);
		const pending = opening.get(key);
		const entry = cached.get(key);
		if (entry) {
			entry.revoked =
				cause ??
				new Error(
					`Row document was revoked because '${address.table}.${address.rowId}' is no longer live`,
				);
		}
		if (entry) await startTeardown(key, entry);
		await pending?.catch(() => undefined);
	}

	return {
		async open(address: RowAddress): Promise<RowDocument<TConnection>> {
			requireRuntimeOpen();
			const entry = await getOrCreate(copyAddress(address));
			requireRuntimeOpen();
			if (entry.revoked) throw entry.revoked;
			return createHandle(entry);
		},
		revoke(address: RowAddress, cause?: Error): Promise<void> {
			return revokeEntry(copyAddress(address), cause);
		},
		async revokeAll(cause?: Error): Promise<void> {
			const addresses = new Map<string, RowAddress>();
			for (const [key, entry] of cached) addresses.set(key, entry.address);
			for (const [key] of opening) {
				const parsed = JSON.parse(key) as [string, string];
				addresses.set(key, { table: parsed[0], rowId: parsed[1] });
			}
			await Promise.all(
				[...addresses.values()].map((address) =>
					revokeEntry(
						address,
						cause ?? new Error('Row document runtime was revoked'),
					),
				),
			);
		},
		/** Wait for the local durability cut of every open document. */
		captureDurabilityBarrier(): Promise<void> {
			requireRuntimeOpen();
			const cuts = [...cached.values()].map((entry) =>
				entry.persistence.whenDurable(),
			);
			return Promise.all(cuts).then(() => undefined);
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (disposal !== undefined) return disposal;
			disposed = true;
			disposal = (async () => {
				await Promise.allSettled(opening.values());
				const failures: unknown[] = [];
				for (const entry of [...cached.values()]) {
					entry.revoked = new Error('Row document runtime is disposed');
					try {
						await startTeardown(rowAddressKey(entry.address), entry);
					} catch (cause) {
						failures.push(cause);
					}
				}
				await Promise.allSettled(closing.values());
				if (failures.length > 0) {
					throw new AggregateError(
						failures,
						'Row document runtime disposal failed',
					);
				}
			})();
			return disposal;
		},
	};
}

function copyAddress(address: RowAddress): RowAddress {
	return { table: address.table, rowId: address.rowId };
}

export type RowDocumentRuntime = ReturnType<typeof createRowDocumentRuntime>;
