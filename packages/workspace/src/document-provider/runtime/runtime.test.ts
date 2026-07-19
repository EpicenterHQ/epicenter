/**
 * Row Document Runtime Tests
 *
 * Verifies hydration, caching, persistence durability, imports, revocation,
 * and disposal across independently addressed Yjs row documents.
 *
 * Key behaviors:
 * - Concurrent opens and imports never create overlapping leases per address
 * - Durability barriers include admitted live and transient document work
 * - Revocation and disposal stop in-flight lifecycle operations
 */
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import type {
	DocumentPersistenceLease,
	DocumentStore,
	RowAddress,
} from '../persistence.js';
import {
	createRowDocumentRuntime,
	type RowDocumentConnectionLease,
} from './runtime.js';

const noteA = { table: 'notes', rowId: 'a' } satisfies RowAddress;
const noteB = { table: 'notes', rowId: 'b' } satisfies RowAddress;

describe('provider-owned row document runtime', () => {
	test('concurrent opens share one hydrated document and one connection', async () => {
		const fixture = setup();
		const firstOpen = fixture.runtime.open(noteA);
		const secondOpen = fixture.runtime.open({ ...noteA });
		await waitFor(() => fixture.store.attaches === 1);

		expect(fixture.store.attaches).toBe(1);
		expect(fixture.connections).toBe(0);
		fixture.store.resolveLoad(noteA);
		const [first, second] = await Promise.all([firstOpen, secondOpen]);
		expect(fixture.connections).toBe(1);
		expect(first.get('content')).toBe(second.get('content'));

		first[Symbol.dispose]();
		await flush();
		expect(fixture.events).toEqual([]);
		second[Symbol.dispose]();
		await waitFor(() => fixture.events.length === 3);
		expect(fixture.events).toEqual([
			'connection:notes/a',
			'persistence:notes/a',
			'document:notes/a',
		]);
	});

	test('delegates the hydration and immediate-edit race to the attached store', async () => {
		const seeded = createUpdate('persisted', 'stored');
		const fixture = setup({
			onAttach(address, document) {
				if (address.rowId !== noteA.rowId) return;
				document.get('immediate').insert(0, 'local');
				fixture.store.setHydration(noteA, seeded);
			},
		});
		let opened = false;
		const opening = fixture.runtime.open(noteA).then((document) => {
			opened = true;
			return document;
		});
		await flush();
		expect(opened).toBe(false);
		expect(fixture.connections).toBe(0);

		fixture.store.resolveLoad(noteA);
		using document = await opening;
		expect(document.get('persisted').toString()).toBe('stored');
		expect(document.get('immediate').toString()).toBe('local');
		expect(fixture.store.updates).toHaveLength(1);
		expect(fixture.connections).toBe(1);
	});

	test('whenDurable is only the local DocumentStore barrier', async () => {
		const fixture = setup();
		const opening = fixture.runtime.open(noteA);
		fixture.store.resolveLoad(noteA);
		using document = await opening;
		document.get('content').insert(0, 'local');

		await document.whenDurable();

		expect(fixture.store.durabilityCuts).toBe(1);
		expect(fixture.remoteSettles).toBe(0);
	});

	test('passes through the restricted document-local connection surface', async () => {
		const fixture = setup();
		const opening = fixture.runtime.open(noteA);
		fixture.store.resolveLoad(noteA);
		using document = await opening;

		expect(document.connection?.status).toBe('connected');
		expect(document.connection).toBe(fixture.connectionSurfaces[0]);
	});

	test('revoke stops one address and revokeAll stops every remaining address', async () => {
		const fixture = setup();
		const firstOpen = fixture.runtime.open(noteA);
		const secondOpen = fixture.runtime.open(noteB);
		fixture.store.resolveLoad(noteA);
		fixture.store.resolveLoad(noteB);
		const first = await firstOpen;
		const second = await secondOpen;

		await fixture.runtime.revoke(noteA);
		expect(() => first.get('content')).toThrow('no longer live');
		expect(() => first.transact(() => undefined)).toThrow('no longer live');
		await expect(first.whenDurable()).rejects.toThrow('no longer live');
		expect(second.get('content')).toBeDefined();

		await fixture.runtime.revokeAll();
		expect(() => second.get('content')).toThrow('runtime was revoked');
		first[Symbol.dispose]();
		second[Symbol.dispose]();
	});

	test('refuses an absent row before persistence or networking', async () => {
		const fixture = setup({ live: (address) => address.rowId !== 'absent' });

		await expect(
			fixture.runtime.open({ table: 'notes', rowId: 'absent' }),
		).rejects.toThrow("absent row 'notes.absent'");
		expect(fixture.store.attaches).toBe(0);
		expect(fixture.connections).toBe(0);
	});

	test('importing a not-open document leaves no connection, cache entry, or lease', async () => {
		const fixture = setup();
		fixture.store.resolveLoad(noteA);

		await fixture.runtime.importUpdate(
			noteA,
			createUpdate('content', 'imported'),
		);

		// The import is persistence-only: no network connection was opened and
		// the transient store lease was disposed once the bytes were durable.
		expect(fixture.connections).toBe(0);
		expect(fixture.events).toEqual(['persistence:notes/a']);
		expect(fixture.store.durabilityCuts).toBe(1);

		// Nothing was cached: a later open hydrates through a fresh attachment.
		using document = await fixture.runtime.open(noteA);
		expect(fixture.store.attaches).toBe(2);
		expect(fixture.connections).toBe(1);
		expect(document.get('content')).toBeDefined();
	});

	test('importing an already-open document applies through it without a second attach', async () => {
		const fixture = setup();
		const opening = fixture.runtime.open(noteA);
		fixture.store.resolveLoad(noteA);
		using document = await opening;

		await fixture.runtime.importUpdate(
			noteA,
			createUpdate('content', 'imported'),
		);

		expect(document.get('content').toString()).toBe('imported');
		expect(fixture.store.attaches).toBe(1);
		expect(fixture.connections).toBe(1);
	});

	test('opening waits for a transient import to release its persistence lease', async () => {
		const fixture = setup();
		fixture.store.resolveLoad(noteA);
		fixture.store.blockDurability(noteA);
		const importing = fixture.runtime.importUpdate(
			noteA,
			createUpdate('content', 'imported'),
		);
		await waitFor(() => fixture.store.durabilityCuts === 1);

		const opening = fixture.runtime.open(noteA);
		await flush();
		expect(fixture.store.attaches).toBe(1);
		expect(fixture.store.activeLeases).toBe(1);
		expect(fixture.store.maximumActiveLeases).toBe(1);

		fixture.store.resolveDurability(noteA);
		await importing;
		using document = await opening;

		expect(fixture.store.attaches).toBe(2);
		expect(fixture.store.maximumActiveLeases).toBe(1);
		expect(document.get('content')).toBeDefined();
	});

	test('captureDurabilityBarrier includes a transient import admitted before the cut', async () => {
		const fixture = setup();
		fixture.store.resolveLoad(noteA);
		fixture.store.blockDurability(noteA);
		const importing = fixture.runtime.importUpdate(
			noteA,
			createUpdate('content', 'imported'),
		);
		await waitFor(() => fixture.store.durabilityCuts === 1);

		let captured = false;
		const barrier = fixture.runtime.captureDurabilityBarrier().then(() => {
			captured = true;
		});
		await flush();
		expect(captured).toBe(false);

		fixture.store.resolveDurability(noteA);
		await Promise.all([importing, barrier]);
		expect(captured).toBe(true);
	});

	test('runtime disposal waits for a transient import and prevents it from applying after disposal starts', async () => {
		const fixture = setup();
		const importing = fixture.runtime.importUpdate(
			noteA,
			createUpdate('content', 'imported'),
		);
		await waitFor(() => fixture.store.attaches === 1);

		let disposed = false;
		const disposal = fixture.runtime[Symbol.asyncDispose]().then(() => {
			disposed = true;
		});
		await flush();
		expect(disposed).toBe(false);

		fixture.store.resolveLoad(noteA);
		await expect(importing).rejects.toThrow('runtime is disposed');
		await disposal;

		expect(disposed).toBe(true);
		expect(fixture.store.updates).toHaveLength(0);
		expect(fixture.store.activeLeases).toBe(0);
		expect(fixture.events).toEqual(['persistence:notes/a']);
	});

	test('revocation waits for a transient import and prevents it from applying after the epoch changes', async () => {
		const fixture = setup();
		const importing = fixture.runtime.importUpdate(
			noteA,
			createUpdate('content', 'imported'),
		);
		await waitFor(() => fixture.store.attaches === 1);

		let revoked = false;
		const revocation = fixture.runtime.revoke(noteA).then(() => {
			revoked = true;
		});
		await flush();
		expect(revoked).toBe(false);

		fixture.store.resolveLoad(noteA);
		await expect(importing).rejects.toThrow(
			'revoked during an active operation',
		);
		await revocation;

		expect(revoked).toBe(true);
		expect(fixture.store.updates).toHaveLength(0);
		expect(fixture.store.activeLeases).toBe(0);
	});

	test('importing a document for an absent row is refused before persistence', async () => {
		const fixture = setup({ live: (address) => address.rowId !== 'absent' });

		await expect(
			fixture.runtime.importUpdate(
				{ table: 'notes', rowId: 'absent' },
				createUpdate('content', 'imported'),
			),
		).rejects.toThrow("absent row 'notes.absent'");
		expect(fixture.store.attaches).toBe(0);
	});

	test('structured addresses do not collide in the cache', async () => {
		const fixture = setup();
		const firstAddress = { table: 'a', rowId: 'b\0c' };
		const secondAddress = { table: 'a\0b', rowId: 'c' };
		const firstOpen = fixture.runtime.open(firstAddress);
		const secondOpen = fixture.runtime.open(secondAddress);
		fixture.store.resolveLoad(firstAddress);
		fixture.store.resolveLoad(secondAddress);
		using first = await firstOpen;
		using second = await secondOpen;

		first.get('value').insert(0, 'first');
		expect(second.get('value').toString()).toBe('');
		expect(fixture.store.attaches).toBe(2);
	});
});

type ConnectionSurface = {
	readonly status: 'connected';
	onStatusChange(listener: (status: 'connected') => void): () => void;
	settle(): void;
};

function setup({
	live = () => true,
	onAttach,
}: {
	live?: (address: RowAddress) => boolean | Promise<boolean>;
	onAttach?: (address: RowAddress, document: Y.Doc) => void;
} = {}) {
	const events: string[] = [];
	const store = new FakeStore(events, onAttach);
	const connectionSurfaces: ConnectionSurface[] = [];
	let connections = 0;
	let remoteSettles = 0;
	const runtime = createRowDocumentRuntime<ConnectionSurface>({
		isLive: live,
		store,
		connect(address, document): RowDocumentConnectionLease<ConnectionSurface> {
			connections += 1;
			const surface: ConnectionSurface = {
				status: 'connected',
				onStatusChange: () => () => undefined,
				settle() {
					remoteSettles += 1;
				},
			};
			connectionSurfaces.push(surface);
			document.once('destroy', () => {
				events.push(`document:${formatAddress(address)}`);
			});
			return {
				connection: surface,
				dispose() {
					events.push(`connection:${formatAddress(address)}`);
				},
			};
		},
	});
	return {
		runtime,
		store,
		events,
		connectionSurfaces,
		get connections() {
			return connections;
		},
		get remoteSettles() {
			return remoteSettles;
		},
	};
}

class FakeStore implements DocumentStore {
	readonly #loads = new Map<string, PromiseWithResolvers<void>>();
	readonly #durability = new Map<string, PromiseWithResolvers<void>>();
	readonly #hydration = new Map<string, Uint8Array>();
	readonly events: string[];
	readonly onAttach:
		| ((address: RowAddress, document: Y.Doc) => void)
		| undefined;
	attaches = 0;
	activeLeases = 0;
	maximumActiveLeases = 0;
	durabilityCuts = 0;
	updates: Uint8Array[] = [];

	constructor(
		events: string[],
		onAttach?: (address: RowAddress, document: Y.Doc) => void,
	) {
		this.events = events;
		this.onAttach = onAttach;
	}

	attach(address: RowAddress, document: Y.Doc): DocumentPersistenceLease {
		this.attaches += 1;
		this.activeLeases += 1;
		this.maximumActiveLeases = Math.max(
			this.maximumActiveLeases,
			this.activeLeases,
		);
		const key = addressKey(address);
		const loaded = this.#loads.get(key) ?? Promise.withResolvers<void>();
		this.#loads.set(key, loaded);
		const updateHandler = (update: Uint8Array, origin: unknown) => {
			if (origin === this) return;
			this.updates.push(Uint8Array.from(update));
		};
		document.on('updateV2', updateHandler);
		this.onAttach?.({ ...address }, document);
		return {
			whenLoaded: loaded.promise.then(() => {
				const hydration = this.#hydration.get(key);
				if (hydration) Y.applyUpdateV2(document, hydration, this);
			}),
			whenDurable: async () => {
				this.durabilityCuts += 1;
				await this.#durability.get(key)?.promise;
			},
			dispose: async () => {
				document.off('updateV2', updateHandler);
				this.activeLeases -= 1;
				this.events.push(`persistence:${formatAddress(address)}`);
			},
		};
	}

	setHydration(address: RowAddress, update: Uint8Array): void {
		this.#hydration.set(addressKey(address), update);
	}

	resolveLoad(address: RowAddress): void {
		const key = addressKey(address);
		const loaded = this.#loads.get(key) ?? Promise.withResolvers<void>();
		this.#loads.set(key, loaded);
		loaded.resolve();
	}

	blockDurability(address: RowAddress): void {
		this.#durability.set(addressKey(address), Promise.withResolvers<void>());
	}

	resolveDurability(address: RowAddress): void {
		this.#durability.get(addressKey(address))?.resolve();
	}

	capture(): Promise<Uint8Array | undefined> {
		return Promise.resolve(undefined);
	}

	delete(): Promise<void> {
		return Promise.resolve();
	}

	deleteAll(): Promise<void> {
		return Promise.resolve();
	}
}

function addressKey(address: RowAddress): string {
	return JSON.stringify([address.table, address.rowId]);
}

function formatAddress(address: RowAddress): string {
	return `${address.table}/${address.rowId}`;
}

function createUpdate(name: string, value: string): Uint8Array {
	const document = new Y.Doc();
	document.get(name).insert(0, value);
	const update = Y.encodeStateAsUpdateV2(document);
	document.destroy();
	return update;
}

function flush(): Promise<void> {
	return new Promise((resolve) => queueMicrotask(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await flush();
	}
	throw new Error('Condition did not become true');
}
