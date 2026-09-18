import {
	type DataDefinition,
	defineApp,
	defineTable,
	field,
	plainText,
} from '@epicenter/app';
/**
 * Two replicas and one authority, wired through in-process sockets.
 *
 * The client, the hub and the authority here are the ones that get deployed;
 * only the socket is a stand-in, and it is a queue that delivers in order
 * exactly like a real one. That distinction is the point. A cursor rule on this
 * branch once "worked" in a simulation where nothing was ever delivered, so
 * every test that claims something arrived asserts on the RECEIVING replica's
 * rows, never on a counter kept by the harness.
 *
 * The second rule is newer and less obvious: where a test is about what
 * survives a crash it asserts on the DURABLE reading, not the in-memory one.
 * A durable cursor ahead of its bytes converges anyway while the process
 * lives, so every convergence assertion in this file passes while it is
 * happening. `durableCursorNeverLeads` is that rule as a predicate, checked
 * every round of both fuzzes.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';
import {
	type DeclaredData,
	openAccountStore,
	syncEngineOf,
	type TableHandle,
	type UntypedDeclaredData,
} from '../store/store.js';
import {
	AuthorityError,
	openSyncAuthority,
	type SyncAuthority,
} from './authority.js';
import { createSyncClient } from './client.js';
import {
	createChunkCollector,
	decodeFrame,
	encodeFrame,
	intoChunks,
} from './frames.js';
import { createSyncHub, type HubConnection } from './hub.js';

const database = defineApp({
	id: 'so.epicenter.honeycrisp',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			content: plainText(),
		}),
	},
});

/** This replica's whole state, as a snapshot carries it. */
function snapshotOf(replica: { data: Replica['data'] }): Uint8Array {
	return syncEngineOf(replica.data).encodeSnapshot();
}

/** One row's `content` node, live on the database document (ADR-0295). */
function editorOf(replica: Replica, rowId: string) {
	const content = replica.db.tables.notes.get(rowId);
	if (content === undefined) throw new Error('the table holds no such row');
	return content.content;
}

/**
 * One table's rows on an untyped binding.
 *
 * An untyped view holds a record of tables, so every one reads as possibly
 * absent. Where a
 * test is about a database NOT declaring a table it looks for that `undefined`
 * deliberately; everywhere else the database declares it, and this says so once.
 */
function tableOf(
	view: { tables: Readonly<Record<string, Pick<TableHandle, 'rows'>>> },
	name: string,
): Pick<TableHandle, 'rows'> {
	const handle = view.tables[name];
	if (handle === undefined)
		throw new Error(`this database declares no '${name}'`);
	return handle;
}

/**
 * A network that delivers in order, and only when told to.
 *
 * Delivery is explicit, so a test can hold messages and inspect either side.
 * Each delivered frame yields to persistence before the next frame runs.
 */
function createWire() {
	const queue: (() => void)[] = [];
	return {
		defer(task: () => void) {
			queue.push(task);
		},
		/** Deliver everything, including whatever delivery itself produces. */
		async settle() {
			await new Promise<void>((resolve) => setImmediate(resolve));
			let guard = 0;
			while (queue.length > 0) {
				guard += 1;
				if (guard > 10_000) throw new Error('the wire never settled');
				(queue.shift() as () => void)();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		},
		/**
		 * Deliver `count` messages and leave the rest queued.
		 *
		 * How a socket that dies part way through a chunked transfer is modelled:
		 * the frames ahead of the break land, and the ones behind it are still in
		 * the queue when the close discards them. Without this the only reachable
		 * schedules are "everything arrived" and "nothing did", and a partial
		 * transfer is neither.
		 */
		async step(count = 1) {
			for (let index = 0; index < count && queue.length > 0; index += 1) {
				(queue.shift() as () => void)();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		},
		inFlight: () => queue.length,
	};
}

type Wire = ReturnType<typeof createWire>;

async function openReplica(
	label: string,
	hub: ReturnType<typeof createSyncHub>,
	wire: Wire,
	/**
	 * The database this device is running, which is not always the same one.
	 *
	 * A device updates before another device does, so two replicas of one
	 * partition routinely hold declarations that disagree. Everything here
	 * declares `notes.title`, which is what keeps `titles()` meaningful across
	 * all of them. One runtime holds one definition (ADR-0240); a device that
	 * updates goes through `upgrade`, which closes this runtime and opens the
	 * next one over the same durable file.
	 */
	through: DataDefinition = database,
	sqlite = createBunSqliteAdapter(new Database(':memory:')),
): Promise<Replica> {
	const data = await openAccountStore({ definition: through, sqlite });

	// One runtime, two static views of it: the typed view costs nothing and is
	// honest for every replica running the default database; a replica running
	// another one reads through `bound`.
	const bound = data as unknown as UntypedDeclaredData;
	const db = data as unknown as DeclaredData<typeof database>;
	const client = createSyncClient({
		store: data,
		idleMs: 0,
		// The idle timer fires through the wire, so a test controls when a
		// coalesced batch leaves rather than waiting on a clock.
		schedule: (task) => {
			wire.defer(task);
			return () => undefined;
		},
	});
	// A socket generation, so a close discards whatever was queued for it. The
	// first version of this harness delivered those frames anyway, which no real
	// socket does, and it manufactured out-of-order deliveries that cannot happen.
	let generation = 0;
	const connection: HubConnection = {
		cursor: client.cursor(),
		send: (bytes) => {
			const sentOn = generation;
			wire.defer(() => {
				if (sentOn === generation) client.receive(bytes);
			});
		},
	};
	const socket = {
		send: (bytes: Uint8Array) => {
			const sentOn = generation;
			wire.defer(() => {
				if (sentOn === generation) hub.receive(connection, bytes);
			});
		},
	};

	return {
		label,
		sqlite,
		data,
		db,
		bound,
		client,
		connection,
		socket,
		connect() {
			connection.cursor = client.cursor();
			const admission = hub.join(connection);
			client.attach(socket);
			return admission;
		},
		disconnect() {
			generation += 1;
			hub.leave(connection);
			client.detach();
		},
		/**
		 * The release upgrade, told honestly (ADR-0240): close this runtime,
		 * reopen the same durable file under the newer declaration. The
		 * successor is a whole replica; the caller connects it when the test
		 * needs the wire.
		 */
		async upgrade(next: DataDefinition): Promise<Replica> {
			generation += 1;
			hub.leave(connection);
			client.detach();
			await data[Symbol.asyncDispose]();
			return await openReplica(label, hub, wire, next, sqlite);
		},
		titles: () => db.tables.notes.rows.map((row) => row.title).sort(),
	};
}

type Replica = {
	label: string;
	/** This device's durable record, for the few tests that assert on rows. */
	sqlite: ReturnType<typeof createBunSqliteAdapter>;
	/** The whole opened handle: one object since the store stopped nesting. */
	data: Awaited<ReturnType<typeof openAccountStore>>;
	db: DeclaredData<typeof database>;
	bound: UntypedDeclaredData;
	client: ReturnType<typeof createSyncClient>;
	connection: HubConnection;
	socket: { send: (bytes: Uint8Array) => void };
	connect(): string;
	disconnect(): void;
	upgrade(next: DataDefinition): Promise<Replica>;
	titles(): string[];
};

function openAuthority(snapshotFloorBytes?: number) {
	const sqlite = createBunSqliteAdapter(new Database(':memory:'));
	const authority = openSyncAuthority({ sqlite, snapshotFloorBytes });
	return { sqlite, authority, hub: createSyncHub({ authority, batch: 8 }) };
}

async function setup(snapshotFloorBytes?: number) {
	const wire = createWire();
	const { sqlite, authority, hub } = openAuthority(snapshotFloorBytes);
	const phone = await openReplica('phone', hub, wire);
	const laptop = await openReplica('laptop', hub, wire);
	return { wire, sqlite, authority, hub, phone, laptop };
}

/**
 * Put bytes no replica can apply into the authority's log.
 *
 * The only way a replica's cursor pins while the log keeps moving, and the
 * authority is the right place to do it from: it never reads what it stores, so
 * garbage takes a position exactly like an update does, and the replica that
 * cannot apply it is the one that finds out (ADR-0298).
 */
function poison(
	hub: ReturnType<typeof createSyncHub>,
	submission: number,
	bytes: Uint8Array,
): void {
	const writer: HubConnection = { cursor: 0, send: () => undefined };
	hub.join(writer);
	hub.receive(
		writer,
		encodeFrame({ kind: 'push', submission, chunk: 0, chunks: 1, bytes }),
	);
	hub.leave(writer);
}

/**
 * The rule every cursor write has to obey: durable may lag, never lead.
 *
 * Lagging is designed and costs an idempotent re-application, because a blocked
 * flush leaves the durable position behind the applied one and a restart simply
 * re-receives entries the document already holds. Leading is the failure with
 * no recovery: the position survives a crash, the bytes do not, and the replica
 * resumes past entries it never read with nothing reporting it.
 *
 * Asserted continuously rather than at the end, because it is transient by
 * nature. Every convergence assertion in this file passes while it is violated,
 * and a `needsResync` reconnect repairs the in-memory state before any of them
 * run.
 */
function durableCursorNeverLeads(replicas: Replica[]): void {
	for (const replica of replicas) {
		const durable = syncEngineOf(replica.data).cursor();
		const applied = replica.client.status().cursor;
		// Compared as a pair so a failure names the replica and both positions;
		// `toBeLessThanOrEqual` alone reports two bare numbers.
		if (durable > applied) {
			expect({ replica: replica.label, durable, applied }).toEqual({
				replica: replica.label,
				durable: applied,
				applied,
			});
		}
	}
}

/** A floor low enough that ordinary test traffic reaches the snapshot path. */
const TINY_FLOOR = 512;

describe('two replicas converge through a log of opaque bytes', () => {
	test('a row created on one device arrives on the other', async () => {
		const { wire, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();

		phone.db.tables.notes.create({ title: 'Groceries' });
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();

		expect(laptop.titles()).toEqual(['Groceries']);
		expect(laptop.client.status().unresolvedDependencies).toBe(false);
	});

	test('CONTROL: it does NOT arrive when the wire never delivers', async () => {
		// The control this whole file exists for. An earlier experiment on this
		// branch passed because its harness delivered nothing and the assertion
		// happened to be about the sender. If this test ever fails, the one above
		// is measuring the harness rather than the transport.
		const { phone, laptop } = await setup();
		phone.connect();
		laptop.connect();

		phone.db.tables.notes.create({ title: 'Groceries' });
		await phone.data.persistence.flush();
		phone.client.flush();
		// await wire.settle() deliberately omitted.

		expect(laptop.titles()).toEqual([]);
	});

	test('edits made on both devices while connected merge', async () => {
		const { wire, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();

		phone.db.tables.notes.create({ title: 'from the phone' });
		laptop.db.tables.notes.create({ title: 'from the laptop' });
		await phone.data.persistence.flush();
		phone.client.flush();
		await laptop.data.persistence.flush();
		laptop.client.flush();
		await wire.settle();

		expect(phone.titles()).toEqual(['from the laptop', 'from the phone']);
		expect(laptop.titles()).toEqual(phone.titles());
	});

	test('a device that was offline is caught up by the same path as a live relay', async () => {
		const { wire, phone, laptop } = await setup();
		phone.connect();

		for (let index = 0; index < 30; index += 1) {
			phone.db.tables.notes.create({ title: `note ${index}` });
			await phone.data.persistence.flush();
			phone.client.flush();
			await wire.settle();
		}

		// The laptop has been absent the whole time and holds nothing.
		expect(laptop.titles()).toEqual([]);
		laptop.connect();
		await wire.settle();

		expect(laptop.titles()).toHaveLength(30);
		expect(laptop.client.status().cursor).toBe(30);
		expect(laptop.client.status().unresolvedDependencies).toBe(false);
	});

	test('database work authored while offline is published on the first dial', async () => {
		const { wire, authority, phone, laptop } = await setup();
		laptop.connect();

		// The phone never connects while it writes.
		phone.db.tables.notes.create({ title: 'written on a plane' });
		phone.db.tables.notes.create({ title: 'also on a plane' });
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();
		expect(laptop.titles()).toEqual([]);

		phone.connect();
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();

		// The reversal the generation address bought (ADR-0292). This work used
		// to be DISCARDED: a replica that grew before it was stamped belonged to
		// no authority document, so first contact concluded supersession and
		// threw it away. A generation is created complete and opened at its own
		// address, so a device holding one is a replica from the moment it opens
		// and its offline work is ordinary owed work.
		expect(laptop.titles()).toEqual(['also on a plane', 'written on a plane']);
		expect(expectOk(authority.head())).toBe(1);
	});

	test('a deletion replicates, which a state vector could never have told us', async () => {
		const { wire, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();
		const note = phone.db.tables.notes.create({ title: 'Groceries' });
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();
		expect(laptop.titles()).toEqual(['Groceries']);

		phone.db.tables.notes.delete(note.id);
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();

		expect(laptop.titles()).toEqual([]);
	});

	test("text written into a row's content node replicates with the row", async () => {
		const { wire, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();
		const note = phone.db.tables.notes.create({ title: 'Groceries' });
		const text = editorOf(phone, note.id);
		text.applyDelta(text.change.insert('buy milk') as never);
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();

		const arrived = editorOf(laptop, note.id);
		expect(arrived.length).toBe('buy milk'.length);
	});
});

describe('the ack is what makes a refusal visible', () => {
	test('an update is owed until the authority names its position', async () => {
		const { wire, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();
		// Let the document announcements land, so the first flush can stamp
		// and send rather than holding the work for the greeting.
		await wire.settle();
		phone.db.tables.notes.create({ title: 'Groceries' });
		await phone.data.persistence.flush();
		phone.client.flush();

		// The push is on the wire and no ack has come back.
		expect(phone.client.status().inFlight).toBe(true);
		expect(phone.client.status().owed).toBeGreaterThan(0);

		await wire.settle();

		expect(phone.client.status().inFlight).toBe(false);
		expect(phone.client.status().owed).toBe(0);
		expect(phone.client.status().cursor).toBe(1);
	});

	test('a refused update is held, reported, and never silently dropped', async () => {
		// The failure `workerd` hides: a throw in `webSocketMessage` does not close
		// the socket, so without an answer a refused update simply evaporates and
		// every layer reports success.
		//
		// The refusal exercised here is a framing violation, which is the only kind
		// left. The authority never reads the bytes, so "this is not a valid
		// update" is not a sentence anything on the server can say; what the
		// collector still knows is how many chunks it was promised.
		const { wire, authority, hub, phone } = await setup();
		phone.connect();

		const answers: Uint8Array[] = [];
		const connection: HubConnection = {
			cursor: 0,
			send: (bytes) => answers.push(bytes),
		};
		hub.join(connection);
		// Chunk 0 opens submission 7 as three chunks long. Chunk 1 arrives claiming
		// the same submission is two, so the collector no longer knows when it is
		// whole and drops what it was holding.
		hub.receive(
			connection,
			encodeFrame({
				kind: 'push',
				submission: 7,
				chunk: 0,
				chunks: 3,
				bytes: new Uint8Array([1, 2, 3]),
			}),
		);
		hub.receive(
			connection,
			encodeFrame({
				kind: 'push',
				submission: 7,
				chunk: 1,
				chunks: 2,
				bytes: new Uint8Array([4, 5, 6]),
			}),
		);

		// The authority answered rather than going quiet, and it named the
		// submission, so the client knows exactly which work it still owes.
		expect(answers).toHaveLength(2);
		expect(expectOk(decodeFrame(answers[0]!))).toEqual({ kind: 'admitted' });
		const refusal = expectOk(decodeFrame(answers[1] as Uint8Array));
		if (refusal.kind !== 'refuse')
			throw new Error(`answered with ${refusal.kind}`);
		expect(refusal.submission).toBe(7);

		// And nothing was stored, so no device will ever be handed a fragment.
		await wire.settle();
		expect(expectOk(authority.head())).toBe(0);
		expect(phone.titles()).toEqual([]);
	});

	test('an offline backlog past the merge threshold converges on one dial', async () => {
		const { wire, phone, laptop } = await setup();
		laptop.connect();

		// Every other offline test in this file writes two rows, so until this
		// one the collapse in ADR-0301 had never fired end to end: the merge
		// needs more owed rows than the threshold, and no socket to have taken
		// any of them.
		for (let index = 0; index < 80; index += 1) {
			phone.db.tables.notes.create({ title: `plane ${index}` });
		}
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();
		expect(laptop.titles()).toEqual([]);

		const rowCount = () =>
			phone.sqlite.all<{ rows: number }>(
				'SELECT COUNT(*) AS rows FROM _updates',
			)[0]?.rows ?? 0;
		const owedCount = () =>
			phone.sqlite.all<{ rows: number }>(
				'SELECT COUNT(*) AS rows FROM _updates WHERE authoritySeq IS NULL',
			)[0]?.rows ?? 0;

		// The merge fired, and this is the control: without it the chain is one
		// row per edit and this assertion is what fails.
		expect(rowCount()).toBeLessThan(80);
		// Collapsed and still owed. A merge changes what carries the bytes,
		// never whether the authority has them.
		expect(owedCount()).toBe(rowCount());
		expect(phone.client.cursor()).toBe(0);

		phone.connect();
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();

		// Every edit made on the plane is on the other device, none of them
		// individually addressable by the time they left.
		expect(laptop.titles().length).toBe(80);
		expect(laptop.titles()).toContain('plane 0');
		expect(laptop.titles()).toContain('plane 79');
		expect(owedCount()).toBe(0);
	});

	test('a replica that never hears an ack still owes the work after reconnecting', async () => {
		const { wire, phone, laptop } = await setup();
		laptop.connect();
		phone.connect();
		await wire.settle();
		phone.db.tables.notes.create({ title: 'Groceries' });
		await phone.data.persistence.flush();
		phone.client.flush();
		expect(phone.client.status().inFlight).toBe(true);

		// The socket dies with the push in flight and the ack never written.
		phone.disconnect();
		await wire.settle();

		phone.connect();
		await wire.settle();

		expect(laptop.titles()).toEqual(['Groceries']);
		expect(phone.client.status().owed).toBe(0);
	});
});

describe('the log grows with sends rather than with transactions', () => {
	test('twenty transactions coalesce into one entry', async () => {
		const { wire, authority, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();

		for (let index = 0; index < 20; index += 1) {
			phone.db.tables.notes.create({ title: `note ${index}` });
			// Every transaction nudges, as a real caller would. The idle timer is
			// what collapses them, not the caller being careful.
			phone.client.nudge();
		}
		await wire.settle();

		expect(expectOk(authority.head())).toBe(1);
		expect(laptop.titles()).toHaveLength(20);
	});

	test('CONTROL: flushing each one instead produces twenty entries', async () => {
		// Without this the test above passes for a client that silently drops
		// nineteen transactions, which looks identical from the authority's side.
		const { wire, authority, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();

		for (let index = 0; index < 20; index += 1) {
			phone.db.tables.notes.create({ title: `note ${index}` });
			await phone.data.persistence.flush();
			phone.client.flush();
			await wire.settle();
		}

		expect(expectOk(authority.head())).toBe(20);
		expect(laptop.titles()).toHaveLength(20);
	});
});

describe('chunking is framing, and carries what no single frame could', () => {
	test('an update past the storage cap survives the round trip', async () => {
		const { wire, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();
		const note = phone.db.tables.notes.create({ title: 'a big paste' });
		const text = editorOf(phone, note.id);
		// One transaction, well past 2,097,152 bytes. There is no seam here for a
		// coalescing bound to cut at, which is why the fix is framing at storage.
		text.applyDelta(text.change.insert('x'.repeat(3_000_000)) as never);
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();

		const arrived = editorOf(laptop, note.id);
		expect(arrived.length).toBe(3_000_000);
		expect(laptop.titles()).toEqual(['a big paste']);
		expect(laptop.client.status().unresolvedDependencies).toBe(false);
	});

	test('CONTROL: it really was chunked, and one chunk alone is not an update', async () => {
		// If the update had fit in one frame the test above would prove nothing
		// about reassembly. This asserts the split happened AND that a lone piece
		// is independently worthless, so concatenation is doing real work.
		const doc = new Y.Doc({ gc: true });
		const text = doc.get('content', 'text');
		doc.transact(() =>
			text.applyDelta(text.change.insert('x'.repeat(5_000_000)) as never),
		);
		const bytes = new Uint8Array(Y.encodeStateAsUpdateV2(doc));
		const chunks = intoChunks(bytes);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			const replica = new Y.Doc({ gc: true });
			expect(() =>
				Y.applyUpdateV2(
					replica,
					new Uint8Array(chunk) as Uint8Array<ArrayBuffer>,
				),
			).toThrow();
			replica.destroy();
		}
		doc.destroy();
	});
});

describe('a socket that dies part way through a chunked transfer', () => {
	test('a push that lost its second chunk arrives whole after reconnecting', async () => {
		// The claim the in-memory collector rests on, from the client's side: a
		// partial nobody ever acked is one the client still owes. The outbox is
		// cleared by the ack and by nothing else, so this is what stands between a
		// dropped socket and a paste that no device ever sees again.
		const { wire, authority, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();
		const note = phone.db.tables.notes.create({ title: 'a big paste' });
		const text = editorOf(phone, note.id);
		text.applyDelta(text.change.insert('x'.repeat(3_000_000)) as never);
		await phone.data.persistence.flush();
		phone.client.flush();

		// It really was chunked: one frame would be one message on the wire.
		expect(wire.inFlight()).toBeGreaterThan(1);
		await wire.step();
		// The hub is holding chunk 0 and has stored nothing, which is the whole
		// point of reassembling before appending: a truncated entry in the log is
		// the poison pill this design spends real effort to make impossible.
		expect(expectOk(authority.head())).toBe(0);

		phone.disconnect();
		await wire.settle();
		expect(expectOk(authority.head())).toBe(0);
		expect(laptop.titles()).toEqual([]);

		phone.connect();
		await wire.settle();

		expect(laptop.titles()).toEqual(['a big paste']);
		const arrived = editorOf(laptop, note.id);
		expect(arrived.length).toBe(3_000_000);
		expect(phone.client.status().owed).toBe(0);
	});

	test('CONTROL: without the reconnect the work is nowhere, on any side', async () => {
		// Without this the test above passes for a hub that stored the fragment, or
		// for a laptop that had somehow seen the paste already. Nothing recovers a
		// half-delivered submission except the client re-offering it.
		const { wire, authority, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();
		const note = phone.db.tables.notes.create({ title: 'a big paste' });
		const text = editorOf(phone, note.id);
		text.applyDelta(text.change.insert('x'.repeat(3_000_000)) as never);
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.step();
		phone.disconnect();
		await wire.settle();

		expect(expectOk(authority.head())).toBe(0);
		expect(laptop.titles()).toEqual([]);
		// The row itself never arrived, so the laptop holds no content for it.
		expect(laptop.db.tables.notes.get(note.id)).toBeUndefined();
		// And the phone still owes it, which is what the reconnect above spends.
		expect(phone.client.status().owed).toBeGreaterThan(0);
	});

	test('a partial submission does not survive the connection that opened it', async () => {
		// The other half of "lost to eviction is safe": the authority must not
		// staple a returning client's chunks onto a stranger's fragment. Each
		// connection gets its own collector and `leave` drops it, so a submission
		// number is only ever meaningful within one socket.
		const { authority, hub } = openAuthority();
		const answers: Uint8Array[] = [];
		const first: HubConnection = {
			cursor: 0,
			send: (bytes) => answers.push(bytes),
		};
		hub.join(first);
		hub.receive(
			first,
			encodeFrame({
				kind: 'push',
				submission: 7,
				chunk: 0,
				chunks: 2,
				bytes: new Uint8Array([1, 2, 3]),
			}),
		);
		hub.leave(first);

		// A second socket sends what the first one had left: the tail of submission
		// 7. It completes nothing, because there is nothing here to complete.
		const second: HubConnection = {
			cursor: 0,
			send: (bytes) => answers.push(bytes),
		};
		hub.join(second);
		answers.length = 0;
		hub.receive(
			second,
			encodeFrame({
				kind: 'push',
				submission: 7,
				chunk: 1,
				chunks: 2,
				bytes: new Uint8Array([4, 5, 6]),
			}),
		);

		expect(expectOk(authority.head())).toBe(0);
		expect(answers).toEqual([]);
	});

	test('CONTROL: the same two chunks on one connection DO complete it', async () => {
		// Without this the test above passes for a hub that ignores every push.
		const { authority, hub } = openAuthority();
		const answers: Uint8Array[] = [];
		const only: HubConnection = {
			cursor: 0,
			send: (bytes) => answers.push(bytes),
		};
		hub.join(only);
		for (const [chunk, bytes] of [
			[0, new Uint8Array([1, 2, 3])],
			[1, new Uint8Array([4, 5, 6])],
		] as const) {
			hub.receive(
				only,
				encodeFrame({ kind: 'push', submission: 7, chunk, chunks: 2, bytes }),
			);
		}

		expect(expectOk(authority.head())).toBe(1);
		expect(expectOk(authority.since(0))[0]?.bytes).toEqual(
			new Uint8Array([1, 2, 3, 4, 5, 6]),
		);
	});

	test('a replica that loses a snapshot mid-transfer converges on reconnect', async () => {
		// The authority's side of the same failure. This replica can only be served
		// by the snapshot, because the entries it covers are deleted, so a snapshot
		// that dies in flight and is not retried is a device that never syncs again.
		const { wire, authority, phone, laptop } = await setup();
		phone.connect();
		const note = phone.db.tables.notes.create({ title: 'a big paste' });
		const text = editorOf(phone, note.id);
		text.applyDelta(text.change.insert('x'.repeat(3_000_000)) as never);
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();
		// The hub asked for a snapshot; the offer's encode is asynchronous.
		await wire.settle();
		// The snapshot is not staged by hand here: a 3 MB paste is past the floor on
		// its own, so the hub asked the phone for one and the tail is already gone.
		expect(expectOk(authority.snapshotPosition())).toBe(1);
		expect(expectOk(authority.since(0, 1_000))).toEqual([]);

		laptop.connect();
		expect(wire.inFlight()).toBeGreaterThan(1);
		await wire.step();
		laptop.disconnect();
		await wire.settle();

		// One chunk of a snapshot is not state, and the replica knows it holds
		// nothing rather than believing it is caught up.
		expect(laptop.titles()).toEqual([]);
		expect(laptop.client.status().cursor).toBe(0);

		laptop.connect();
		await wire.settle();

		expect(laptop.titles()).toEqual(['a big paste']);
		const arrived = editorOf(laptop, note.id);
		expect(arrived.length).toBe(3_000_000);
		expect(laptop.client.status().cursor).toBe(1);
		expect(laptop.client.status().unresolvedDependencies).toBe(false);
	});
});

/**
 * The collector on its own, fed real update bytes cut small.
 *
 * Driven directly rather than through the client, because everything here is
 * about chunk arithmetic and reaching it through the transport would mean
 * multi-megabyte payloads per case. The BYTES are real and the reassembled
 * result is applied to a real replica and read back through its database, so what is
 * synthetic is the chunk size and nothing else.
 */
describe('reassembly holds partials in memory, and only in memory', () => {
	/** One replica's whole state, cut into more chunks than any case needs. */
	function cutUpdate(
		source: Awaited<ReturnType<typeof openReplica>>,
		limit = 16,
	) {
		const bytes = source.data.encodeStateSince();
		const chunks = intoChunks(bytes, limit);
		if (chunks.length < 4) throw new Error(`only ${chunks.length} chunks`);
		return { bytes, chunks };
	}

	function push(chunks: Uint8Array[], chunk: number) {
		return {
			kind: 'push' as const,
			submission: 7,
			chunk,
			chunks: chunks.length,
			bytes: chunks[chunk] as Uint8Array,
		};
	}

	test('chunks that arrive out of order reassemble into the update they were cut from', async () => {
		const { phone, laptop } = await setup();
		phone.db.tables.notes.create({ title: 'Groceries' });
		const { bytes, chunks } = cutUpdate(phone);
		const collector = createChunkCollector({ limitBytes: 1 << 20 });

		let whole: Uint8Array | undefined;
		// Backwards, so the last chunk arrives first and chunk 0 arrives last.
		for (const index of [...chunks.keys()].reverse()) {
			whole = expectOk(collector.accept(push(chunks, index)));
			// Complete only once every index has landed, never before.
			expect(whole === undefined).toBe(index !== 0);
		}

		expect(whole).toEqual(bytes);
		expect(collector.bufferedBytes()).toBe(0);
		// Byte equality alone would not show the update still works, so it is
		// applied to a replica that has never seen this row and read back through
		// that replica's own database.
		expectOk(syncEngineOf(laptop.data).applyRemote(whole as Uint8Array));
		expect(laptop.titles()).toEqual(['Groceries']);
	});

	test('CONTROL: one chunk short is never whole, and the replica stays empty', async () => {
		// Without this, "out of order still reassembles" would pass for a collector
		// that hands back whatever it holds on the first frame.
		const { phone, laptop } = await setup();
		phone.db.tables.notes.create({ title: 'Groceries' });
		const { chunks } = cutUpdate(phone);
		const collector = createChunkCollector({ limitBytes: 1 << 20 });

		for (const index of [...chunks.keys()].reverse()) {
			if (index === 1) continue;
			expect(expectOk(collector.accept(push(chunks, index)))).toBeUndefined();
		}

		expect(collector.bufferedBytes()).toBeGreaterThan(0);
		expect(laptop.titles()).toEqual([]);
	});

	test('a chunk that arrives twice does not count twice', async () => {
		// Re-delivery is ordinary here: a reconnect re-sends a submission from its
		// first chunk, so a collector that counted frames rather than filled slots
		// would call a submission whole while a hole was still in it.
		const { phone, laptop } = await setup();
		phone.db.tables.notes.create({ title: 'Groceries' });
		const { bytes, chunks } = cutUpdate(phone);
		const collector = createChunkCollector({ limitBytes: 1 << 20 });

		const repeated = [0, 0, 0, ...chunks.keys()];
		let whole: Uint8Array | undefined;
		for (const index of repeated) {
			whole = expectOk(collector.accept(push(chunks, index)));
			expect(whole === undefined).toBe(index !== chunks.length - 1);
		}

		expect(whole).toEqual(bytes);
		expect(collector.bufferedBytes()).toBe(0);
		expectOk(syncEngineOf(laptop.data).applyRemote(whole as Uint8Array));
		expect(laptop.titles()).toEqual(['Groceries']);
	});

	test('CONTROL: repeats alone never fill the holes they duplicate', async () => {
		const { phone, laptop } = await setup();
		phone.db.tables.notes.create({ title: 'Groceries' });
		const { chunks } = cutUpdate(phone);
		const collector = createChunkCollector({ limitBytes: 1 << 20 });

		for (const index of [0, 0, 0, 0, 1, 1, 1]) {
			expect(expectOk(collector.accept(push(chunks, index)))).toBeUndefined();
		}

		// Two slots filled and the rest empty, however many frames arrived.
		expect(collector.bufferedBytes()).toBe(
			(chunks[0]?.length ?? 0) + (chunks[1]?.length ?? 0),
		);
		expect(laptop.titles()).toEqual([]);
	});

	test('a partial nobody finishes is held until something forgets it', async () => {
		// Nothing ages a partial out, and that is deliberate rather than an
		// oversight: eviction on a timer would drop a submission a slow client is
		// still sending. The bound is the byte limit, and the release is the
		// collector itself going away with the connection that owned it.
		const collector = createChunkCollector({ limitBytes: 1 << 20 });
		expectOk(
			collector.accept({
				kind: 'push',
				submission: 7,
				chunk: 0,
				chunks: 3,
				bytes: new Uint8Array(600),
			}),
		);
		expect(collector.bufferedBytes()).toBe(600);

		// Other traffic completing does not release it, so a dead submission is not
		// swept up by a live one.
		expectOk(
			collector.accept({
				kind: 'push',
				submission: 8,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array(9),
			}),
		);
		expect(collector.bufferedBytes()).toBe(600);

		collector.forget(7);
		expect(collector.bufferedBytes()).toBe(0);
	});

	test('past the limit the partial is dropped and the sender is told', async () => {
		// The ceiling that makes "held in memory" bounded rather than a promise. A
		// client that opens submissions and never finishes them is asking the
		// authority to hold bytes forever, and the answer is a refusal it can act
		// on, because it still owes the work.
		const collector = createChunkCollector({ limitBytes: 1_000 });
		expectOk(
			collector.accept({
				kind: 'push',
				submission: 7,
				chunk: 0,
				chunks: 3,
				bytes: new Uint8Array(600),
			}),
		);
		const over = collector.accept({
			kind: 'push',
			submission: 7,
			chunk: 1,
			chunks: 3,
			bytes: new Uint8Array(600),
		});

		expect(over.error?.name).toBe('Malformed');
		expect(collector.bufferedBytes()).toBe(0);
	});
});

describe('a partial that outlives the socket that opened it', () => {
	/**
	 * The client keeps ONE collector for the life of the client, and `detach`
	 * does not clear it. Positions in it are entry sequence numbers and snapshot
	 * positions in the same key space, so a partial left behind by a dead socket
	 * is waiting for whatever the authority sends at that number next.
	 *
	 * The hub does not have this problem: a collector belongs to a connection and
	 * `leave` drops it, which is pinned above by 'a partial submission does not
	 * survive the connection that opened it'.
	 */
	async function stallMidEntry() {
		// A floor nothing reaches, so both snapshots here are staged deliberately
		// and the sizes are the real ones the transport would produce.
		const { wire, authority, phone, laptop } = await setup(
			Number.MAX_SAFE_INTEGER,
		);
		phone.connect();
		const note = phone.db.tables.notes.create({ title: 'a big paste' });
		const text = editorOf(phone, note.id);
		text.applyDelta(text.change.insert('x'.repeat(4_000_000)) as never);
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();
		expectOk(authority.replaceSnapshot(1, snapshotOf(phone)));
		const first = expectOk(authority.snapshot());
		const snapshotChunks = intoChunks(first?.bytes as Uint8Array).length;
		// Entry 2 is a second paste: two chunks, where the state through 2 is four.
		// That difference is the whole scenario, and it is what a delta and a whole
		// state at the same position ordinarily look like.
		text.applyDelta(text.change.insert('y'.repeat(3_000_000)) as never);
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();
		expect(
			intoChunks(expectOk(authority.since(1))[0]?.bytes as Uint8Array),
		).toHaveLength(2);

		return { wire, authority, phone, laptop, note, snapshotChunks };
	}

	async function readNodeText(replica: Replica, rowId: string) {
		return editorOf(replica, rowId).length;
	}

	test('a snapshot cut differently to the entry it replaces still arrives', async () => {
		const { wire, authority, phone, laptop, note, snapshotChunks } =
			await stallMidEntry();

		// The laptop takes the snapshot at 1, then the first chunk of entry 2, and
		// its socket dies. It is now holding a partial at position 2, two chunks
		// wide, that will never be completed by anything.
		laptop.connect();
		await wire.step(snapshotChunks + 1);
		laptop.disconnect();
		await wire.settle();
		expect(laptop.client.status().cursor).toBe(1);
		expect(await readNodeText(laptop, note.id)).toBe(4_000_000);

		// The authority snapshots at 2 and the tail it covers is gone, so the
		// snapshot is now the only way this replica can ever converge.
		expectOk(authority.replaceSnapshot(2, snapshotOf(phone)));
		expect(expectOk(authority.since(0, 1_000))).toEqual([]);
		expect(
			intoChunks(expectOk(authority.snapshot())?.bytes as Uint8Array),
		).toHaveLength(4);

		laptop.connect();
		await wire.settle();

		// This used to leave the replica at 4,000,000 in silence. A partial from
		// the dead socket sat at position 2, a four-chunk snapshot arrived at the
		// same position, the collector reported a framing error, and
		// `client.receive` mapped it to `Ok(undefined)`: chunk 0 discarded, the
		// rest stranded in a partial that could never complete, `lastError`
		// undefined and `needsResync` false. Two changes close it. A collector
		// belongs to a socket and is rebuilt on attach and detach, so nothing
		// survives to collide; and a reassembly failure is reported rather than
		// swallowed, so even a collision that did happen asks to be reconnected.
		expect(await readNodeText(laptop, note.id)).toBe(7_000_000);
		expect(laptop.client.status().needsResync).toBe(false);
		expect(laptop.client.status().lastError).toBeUndefined();
	});

	test('a reassembly failure asks to be reconnected instead of going quiet', async () => {
		// The second half of the fix, on its own. Even if frames that contradict
		// their own count reach a replica, it must say so: a partial nothing will
		// ever complete stops the replica dead while every layer reports success.
		const { wire, phone } = await setup();
		phone.connect();
		await wire.settle();

		const first = phone.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: 1,
				chunk: 0,
				chunks: 3,
				bytes: new Uint8Array([1]),
			}),
		);
		expect(first.error).toBeNull();
		const contradicting = phone.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: 1,
				chunk: 1,
				chunks: 2,
				bytes: new Uint8Array([2]),
			}),
		);

		expect(contradicting.error?.name).toBe('BrokenStream');
		expect(phone.client.status().needsResync).toBe(true);
	});

	test('CONTROL: without the stale partial the same snapshot converges first time', async () => {
		// The isolation. Same sizes, same four-chunk snapshot, same reconnect: the
		// only difference is that this laptop's socket died on a frame boundary
		// rather than inside a chunked entry.
		const { wire, authority, phone, laptop, note, snapshotChunks } =
			await stallMidEntry();

		laptop.connect();
		// One extra step for the document announcement that opens every join.
		await wire.step(1 + snapshotChunks);
		laptop.disconnect();
		await wire.settle();
		expect(laptop.client.status().cursor).toBe(1);

		expectOk(authority.replaceSnapshot(2, snapshotOf(phone)));
		laptop.connect();
		await wire.settle();

		expect(await readNodeText(laptop, note.id)).toBe(7_000_000);
		expect(laptop.client.status().cursor).toBe(2);
		expect(laptop.titles()).toEqual(['a big paste']);
	});
});

describe('the cursor is contiguous, and a jump is refused rather than absorbed', () => {
	test('an entry that skips a position is not applied and moves nothing', async () => {
		const { wire, phone } = await setup();
		phone.connect();
		await wire.settle();
		const before = phone.client.status().cursor;

		const skipped = phone.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: before + 5,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([0]),
			}),
		);

		expect(skipped.error?.name).toBe('Gap');
		expect(phone.client.status().cursor).toBe(before);
	});

	test('CONTROL: the very next position IS applied, so the check is not refusing everything', async () => {
		const { wire, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();
		phone.db.tables.notes.create({ title: 'Groceries' });
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();

		expect(laptop.client.status().cursor).toBe(1);
		expect(laptop.titles()).toEqual(['Groceries']);
	});
});

describe('sustained traffic through one authority', () => {
	test('a thousand sends stay contiguous and converge', async () => {
		const { wire, authority, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();

		for (let index = 0; index < 500; index += 1) {
			phone.db.tables.notes.create({ title: `phone ${index}` });
			await phone.data.persistence.flush();
			phone.client.flush();
			laptop.db.tables.notes.create({ title: `laptop ${index}` });
			await laptop.data.persistence.flush();
			laptop.client.flush();
			await wire.settle();
		}

		expect(expectOk(authority.head())).toBe(1000);
		expect(phone.titles()).toHaveLength(1000);
		expect(laptop.titles()).toEqual(phone.titles());
		expect(phone.client.status().cursor).toBe(1000);
		expect(laptop.client.status().cursor).toBe(1000);
		expect(phone.client.status().lastError).toBeUndefined();
		expect(laptop.client.status().lastError).toBeUndefined();
	});
});

describe('an entry that will not apply is loud, not silent', () => {
	test('the replica reports it, names the position, and moves nothing', async () => {
		// The poison pill seen from the only place it is ever visible. This
		// returned Ok and set no error, so a bricked device looked exactly like an
		// idle one: it stopped syncing and every layer reported success. Nothing
		// recovers a failure nobody is told about.
		const { wire, phone } = await setup();
		phone.connect();
		await wire.settle();
		const before = phone.client.status().cursor;

		const outcome = phone.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: before + 1,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([1, 2, 3, 4, 5, 6]),
			}),
		);

		expect(outcome.error?.name).toBe('Unapplyable');
		expect((outcome.error as { seq?: number } | null)?.seq).toBe(before + 1);
		expect(phone.client.status().lastError?.name).toBe('Unapplyable');
		// Stuck, deliberately: advancing past it would trade a visible stall for
		// permanent invisible loss.
		expect(phone.client.status().cursor).toBe(before);
	});

	test('the authority stores bytes it cannot read, and only the reader finds out', async () => {
		// The whole server half of this story, end to end. The authority used to
		// decode every update and refuse what threw; that check was never a proof
		// (it let 44 of ~5,900 single-byte corruptions through), cost more than
		// hydrating an entire document, and reading the bytes at all is what would
		// make end-to-end encryption impossible. So garbage is accepted, given a
		// position, and relayed. Nothing on the server has an opinion about it, and
		// the replica that cannot apply it is the one that says so.
		const { wire, authority, hub, phone } = await setup();
		phone.connect();
		await wire.settle();

		const answers: Uint8Array[] = [];
		const writer: HubConnection = {
			cursor: 0,
			send: (bytes) => answers.push(bytes),
		};
		hub.join(writer);
		hub.receive(
			writer,
			encodeFrame({
				kind: 'push',
				submission: 7,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([1, 2, 3, 4, 5, 6]),
			}),
		);

		// Accepted: acknowledged at a position, and in the log byte for byte.
		const answer = expectOk(decodeFrame(answers[1] as Uint8Array));
		if (answer.kind !== 'ack') throw new Error(`answered with ${answer.kind}`);
		expect(answer.seq).toBe(1);
		expect(expectOk(authority.head())).toBe(1);
		expect(expectOk(authority.since(0))[0]?.bytes).toEqual(
			new Uint8Array([1, 2, 3, 4, 5, 6]),
		);

		// And the failure surfaces where the bytes are finally read, naming the
		// position an operator has to neutralise.
		await wire.settle();
		const stuck = phone.client.status().lastError;
		expect(stuck?.name).toBe('Unapplyable');
		expect((stuck as { seq?: number } | undefined)?.seq).toBe(1);
		expect(phone.client.status().cursor).toBe(0);
	});

	test('CONTROL: a good entry at the same position applies and reports nothing', async () => {
		const { wire, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();
		laptop.db.tables.notes.create({ title: 'Groceries' });
		await laptop.data.persistence.flush();
		laptop.client.flush();
		await wire.settle();

		expect(phone.client.status().lastError).toBeUndefined();
		expect(phone.titles()).toEqual(['Groceries']);
	});

	test('neutralising the position in the log unsticks the replica', async () => {
		// Why no server-side check is needed to RECOVER from a poison pill. The
		// log is append-only and every entry is individually addressable, so the
		// repair is to overwrite one row with an empty update, which every
		// document applies as a no-op. The sequence stays contiguous and every
		// replica walks straight past it.
		const { wire, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();
		laptop.db.tables.notes.create({ title: 'Groceries' });
		await laptop.data.persistence.flush();
		laptop.client.flush();
		await wire.settle();

		const empty = new Y.Doc({ gc: true });
		const noop = new Uint8Array(Y.encodeStateAsUpdateV2(empty));
		empty.destroy();
		const stuck = phone.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: 2,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([9, 9, 9]),
			}),
		);
		expect(stuck.error?.name).toBe('Unapplyable');

		// The operator replaces entry 2's bytes. The replica takes it and moves on.
		expectOk(
			phone.client.receive(
				encodeFrame({
					kind: 'entry',
					seq: 2,
					chunk: 0,
					chunks: 1,
					bytes: noop,
				}),
			),
		);

		expect(phone.client.status().cursor).toBe(2);
		expect(phone.titles()).toEqual(['Groceries']);
	});
});

describe('an ack naming a position this replica never received through', () => {
	/**
	 * A replica pinned behind the log, with the log still moving.
	 *
	 * An ack is an entry frame with the payload elided: it names a position and
	 * expects the replica to move its cursor there using bytes it already holds.
	 * That is sound only while the position is the next one, which the hub
	 * arranges by delivering everything below it to the same socket first.
	 *
	 * A poison entry breaks the arrangement from the replica's side. It refuses
	 * to apply, so its cursor pins while the log keeps moving, and an ack for a
	 * submission still in flight then names a position several entries ahead.
	 * Nothing here drops a frame or reorders one; this is what an ordered wire
	 * and a working authority produce on their own.
	 *
	 * Returns with the phone pinned at 1 and the log at 3.
	 */
	async function pinnedBehindTheLog() {
		const { wire, authority, hub, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();

		// Entry 1: ordinary work, and the phone takes it.
		laptop.db.tables.notes.create({ title: 'Groceries' });
		await laptop.data.persistence.flush();
		laptop.client.flush();
		await wire.settle();
		expect(phone.client.status().cursor).toBe(1);

		// Entry 2: bytes no replica can apply. The authority stores them without
		// an opinion, and the phone pins at 1 rather than walking past them.
		poison(hub, 1, new Uint8Array([1, 2, 3, 4, 5, 6]));
		await wire.settle();
		expect(phone.client.status().lastError?.name).toBe('Unapplyable');

		// Entry 3: more ordinary work, which the phone now reads as a gap.
		laptop.db.tables.notes.create({ title: 'Milk' });
		await laptop.data.persistence.flush();
		laptop.client.flush();
		await wire.settle();
		expect(phone.client.status().cursor).toBe(1);
		expect(expectOk(authority.head())).toBe(3);

		return { wire, hub, phone, laptop };
	}

	test('the durable cursor stays put and the work stays owed', async () => {
		const { wire, phone } = await pinnedBehindTheLog();

		// The phone authors its own work while pinned. The authority takes it at
		// 4 and says so, which is three past where this replica actually is.
		phone.db.tables.notes.create({ title: 'Eggs' });
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();

		// One assertion, because `name: 'Gap'` alone cannot fail here: entry 3
		// already reported a gap before the ack arrived. Only `received` tells the
		// two apart, and `expected: 2` is the substance: the gap is reported
		// against the replica's real position, not the ack's own, which is what
		// sends the reconnect after entry 2 rather than entry 4.
		expect(phone.client.status().lastError).toMatchObject({
			name: 'Gap',
			expected: 2,
			received: 4,
		});

		// The DURABLE readings, because every in-memory one was already correct
		// while the bytes were being lost. Acting on the ack would stamp the owed
		// rows at 4, and the cursor IS `MAX(authoritySeq)` (ADR-0301), so that one
		// write claims entries 2 and 3 were read.
		expect(syncEngineOf(phone.data).cursor()).toBe(1);
		expect(syncEngineOf(phone.data).coalesce()).not.toBeUndefined();
	});

	test('a restart inside the window dials from the entries it still needs', async () => {
		const { wire, phone } = await pinnedBehindTheLog();

		phone.db.tables.notes.create({ title: 'Eggs' });
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();

		// The crash that turns a durable stamp into loss. Nothing in memory
		// survives, so the only thing deciding where this device resumes is the
		// row it wrote down. Dialing from 4 skips entry 3 forever AND walks
		// silently past the poison at 2 that the design spends real effort making
		// loud, which is the failure this whole suite exists for.
		const restarted = await phone.upgrade(database);
		expect(restarted.client.cursor()).toBe(1);
		// And it still owes what the ack was answering, so the work authored
		// before the crash is not dropped either.
		expect(syncEngineOf(restarted.data).coalesce()).not.toBeUndefined();
	});

	test('an ack behind the cursor is refused too, after a snapshot jumped past it', async () => {
		// The third arm, and the reason the check is `!==` rather than `>`. A
		// snapshot is the ONE licensed cursor jump, so it can carry a replica past
		// a submission that is still in flight; the ack then names a position
		// BELOW the cursor. Acting on it happened to be harmless, but only because
		// stamping under `MAX(authoritySeq)` cannot move it. That is a property of
		// the fold's arithmetic, not a rule anything stated, and a fold that ever
		// stopped taking the maximum would turn it into a silent cursor rewind.
		const { wire, phone } = await setup();
		phone.connect();
		await wire.settle();

		phone.db.tables.notes.create({ title: 'Eggs' });
		await phone.data.persistence.flush();
		phone.client.flush();
		const outstanding = phone.client.status().inFlightSubmission;
		expect(outstanding).toBeDefined();

		// A snapshot at 9 arrives before the ack does. It covers everything at or
		// before it, so the jump is legitimate and the cursor lands at 9.
		expectOk(
			phone.client.receive(
				encodeFrame({
					kind: 'snapshot',
					position: 9,
					chunk: 0,
					chunks: 1,
					bytes: snapshotOf(phone),
				}),
			),
		);
		expect(phone.client.status().cursor).toBe(9);

		const answer = phone.client.receive(
			encodeFrame({
				kind: 'ack',
				submission: outstanding as number,
				seq: 4,
			}),
		);

		expect(answer.error?.name).toBe('Gap');
		expect(phone.client.status().needsResync).toBe(true);
		expect(phone.client.status().cursor).toBe(9);
	});

	test('CONTROL: an ack at the next position is taken and the outbox clears', async () => {
		// Without this the guard could refuse EVERY ack and the tests above would
		// still pass, while the replica never retired a single row.
		const { wire, phone } = await setup();
		phone.connect();
		phone.db.tables.notes.create({ title: 'Eggs' });
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();

		expect(phone.client.status().lastError).toBeUndefined();
		expect(phone.client.status().needsResync).toBe(false);
		expect(syncEngineOf(phone.data).cursor()).toBe(1);
		expect(syncEngineOf(phone.data).coalesce()).toBeUndefined();
	});

	/**
	 * The same conjunction on schedules nobody designed.
	 *
	 * The four tests above assert a sequence someone imagined, so they can only
	 * hold the shape that was imagined. What actually has to be true is narrower
	 * and applies at every instant: a replica may not durably record a position
	 * it has not read through. `durableCursorNeverLeads` is that sentence, and
	 * these schedules vary everything the deterministic tests fix in place.
	 *
	 * The big fuzz below cannot reach this state at all. Every byte it generates
	 * is a real update, so no replica is ever pinned, so no ack is ever ahead.
	 * That is exactly why this one exists and why it injects bytes that will not
	 * apply.
	 */
	for (const seed of [3, 19, 2024, 55555]) {
		test(`seed ${seed}: a pinned replica never records a position it skipped`, async () => {
			const random = createRandom(seed);
			const { wire, authority, hub, phone, laptop } = await setup();
			phone.connect();
			laptop.connect();

			let poisoned = false;
			/** The conjunction itself: pinned behind the log, and still pushing. */
			let sawPinnedWithWorkInFlight = false;
			for (let round = 0; round < 40; round += 1) {
				const author = random.chance(0.5) ? phone : laptop;
				author.db.tables.notes.create({ title: `r${round}` });
				// Whether a submission is still in flight when the next ack lands is
				// the whole variable, so flushing is a coin toss rather than a step.
				if (random.chance(0.7)) author.client.flush();
				// Poison once, at a position the schedule chooses rather than one
				// this test picked.
				if (!poisoned && random.chance(0.15)) {
					poison(hub, round + 100, new Uint8Array([7, 7, 7, 7]));
					poisoned = true;
				}
				if (random.chance(0.6)) await wire.settle();
				if (random.chance(0.2)) phone.disconnect();
				if (random.chance(0.3)) phone.connect();
				const state = phone.client.status();
				if (state.inFlight && state.cursor < expectOk(authority.head())) {
					sawPinnedWithWorkInFlight = true;
				}
				durableCursorNeverLeads([phone, laptop]);
			}

			await wire.settle();
			durableCursorNeverLeads([phone, laptop]);
			// CONTROLS. A schedule that poisoned nothing, or that poisoned the log
			// while the phone happened to be idle, satisfies every assertion above
			// while exercising none of the path this fuzz is for. The second is the
			// conjunction itself: an ack can only be ahead of a replica that is
			// behind the log AND waiting on a submission.
			expect(poisoned).toBe(true);
			expect(sawPinnedWithWorkInFlight).toBe(true);
		});
	}
});

describe('the authority keeps a snapshot and a tail, not a log', () => {
	test('a snapshot replaces the entries it covers, and storage stops growing', async () => {
		const { wire, authority, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();
		for (let index = 0; index < 30; index += 1) {
			phone.db.tables.notes.create({ title: `note ${index}` });
			await phone.data.persistence.flush();
			phone.client.flush();
			await wire.settle();
		}
		const head = expectOk(authority.head());
		const before = expectOk(authority.since(0, 1_000)).length;
		expect(before).toBe(30);

		// Driven directly rather than by the floor, which a thirty-note document
		// never reaches. What is under test is what a snapshot DOES, not when the
		// authority decides to ask for one.
		expectOk(authority.replaceSnapshot(head, snapshotOf(phone)));

		expect(expectOk(authority.snapshotPosition())).toBe(head);
		expect(expectOk(authority.since(0, 1_000))).toEqual([]);
		expect(laptop.titles()).toHaveLength(30);
	});

	test('a previously bootstrapped replica behind the snapshot keeps same-document offline work', async () => {
		// The case the whole shape exists for. The tail this replica needed is
		// gone, so it can only be served by the snapshot, and it is carrying work
		// nobody has seen.
		const { wire, authority, phone, laptop } = await setup();
		phone.connect();
		laptop.connect();
		laptop.disconnect();
		for (let index = 0; index < 30; index += 1) {
			phone.db.tables.notes.create({ title: `note ${index}` });
			await phone.data.persistence.flush();
			phone.client.flush();
			await wire.settle();
		}

		// The tail is gone, so this replica can only be served by the snapshot.
		expectOk(
			authority.replaceSnapshot(expectOk(authority.head()), snapshotOf(phone)),
		);

		// This work is offline but not unlabelled: the replica already adopted
		// this database document before it went away.
		laptop.db.tables.notes.create({ title: 'WRITTEN OFFLINE' });
		laptop.connect();
		await wire.settle();
		await laptop.data.persistence.flush();
		laptop.client.flush();
		await wire.settle();

		expect(laptop.titles()).toHaveLength(31);
		expect(laptop.titles()).toContain('WRITTEN OFFLINE');
		expect(laptop.client.status().unresolvedDependencies).toBe(false);
		// And it converges both ways, so the offline note reached the other side.
		expect(phone.titles()).toEqual(laptop.titles());
	});

	test('a deleted note is not in the snapshot, so it stops being recoverable', async () => {
		// The privacy consequence, and the reason this shape is worth the change.
		// A never-compacted log holds the update that CREATED a row forever
		// (`evidence/retention.test.ts`); a snapshot is current state and carries
		// no trace of it.
		const { wire, authority, phone } = await setup();
		phone.connect();
		const secret = 'SECRET-CANARY-therapist';
		const note = phone.db.tables.notes.create({ title: secret });
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();
		phone.db.tables.notes.delete(note.id);
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();
		for (let index = 0; index < 40; index += 1) {
			phone.db.tables.notes.create({ title: `filler ${index}` });
			await phone.data.persistence.flush();
			phone.client.flush();
			await wire.settle();
		}
		expectOk(
			authority.replaceSnapshot(expectOk(authority.head()), snapshotOf(phone)),
		);

		const stored = [
			...(expectOk(authority.snapshot()) === undefined
				? []
				: [expectOk(authority.snapshot())?.bytes as Uint8Array]),
			...expectOk(authority.since(0, 1_000)).map((entry) => entry.bytes),
		];
		const haystack = Buffer.concat(
			stored.map((bytes) => Buffer.from(bytes)),
		).toString('latin1');

		expect(haystack).not.toContain(secret);
		// CONTROL: a title that IS still live must be found, or the search is
		// looking in the wrong place and would pass for any string.
		expect(haystack).toContain('filler 39');
	});
});

describe('who may replace the snapshot', () => {
	test('a connection the authority has NOT sent everything to is refused', async () => {
		// The half of the condition the hub owns, and the half that separates this
		// from the client-posted baseline an earlier design died on. The check is
		// against the authority's own record of what it sent, never against what
		// the replica says about itself.
		const { wire, authority, hub, phone } = await setup();
		phone.connect();
		phone.db.tables.notes.create({ title: 'real work' });
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();
		const head = expectOk(authority.head());

		const answers: Uint8Array[] = [];
		const stale: HubConnection = {
			cursor: 0,
			send: (bytes) => answers.push(bytes),
		};
		hub.join(stale);
		answers.length = 0;
		// Joining catches a connection up, so the state this guard exists for has
		// to be arranged: a socket the authority has sent nothing to, claiming to
		// hold everything.
		stale.cursor = 0;
		// An empty document, offered as though it were the whole state. This is
		// the exact shape that destroyed a partition in a withdrawn design.
		hub.receive(
			stale,
			encodeFrame({
				kind: 'offer',
				position: head,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array(Y.encodeStateAsUpdateV2(new Y.Doc({ gc: true }))),
			}),
		);

		expect(answers).toEqual([]);
		// And nothing was destroyed: the work is still there.
		expect(phone.titles()).toEqual(['real work']);
	});

	test('CONTROL: the same offer from a current connection IS accepted', async () => {
		// Without this the refusal above passes for a hub that refuses every
		// offer, which would mean snapshots never happen at all.
		const { wire, authority, phone } = await setup();
		phone.connect();
		for (let index = 0; index < 10; index += 1) {
			phone.db.tables.notes.create({ title: `note ${index}` });
			await phone.data.persistence.flush();
			phone.client.flush();
			await wire.settle();
		}

		const head = expectOk(authority.head());
		const accepted = authority.replaceSnapshot(head, snapshotOf(phone));

		expect(accepted.error).toBeNull();
		expect(expectOk(authority.snapshotPosition())).toBe(head);
		expect(phone.titles()).toHaveLength(10);
	});

	test('an offer running past the end of the log is refused by the authority', async () => {
		const { wire, authority, phone } = await setup();
		phone.connect();
		phone.db.tables.notes.create({ title: 'one' });
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();
		const head = expectOk(authority.head());

		// Past the end of the log: it would stand for entries nobody has written.
		const beyond = authority.replaceSnapshot(head + 5, new Uint8Array([0]));

		expect(beyond.error?.name).toBe('SnapshotRefused');
	});
});

describe('the snapshot path under sustained traffic', () => {
	test('hundreds of sends with snapshots firing throughout still converge', async () => {
		// The scale that broke a live run against Cloudflare. The floor is dropped
		// so the snapshot path is reached with ordinary test traffic rather than
		// with a real vault.
		const { wire, authority, phone, laptop } = await setup(TINY_FLOOR);
		phone.connect();
		laptop.connect();

		for (let index = 0; index < 300; index += 1) {
			phone.db.tables.notes.create({ title: `note ${index}` });
			await phone.data.persistence.flush();
			phone.client.flush();
			await wire.settle();
			// A requested snapshot offer encodes asynchronously before it sends.
			await wire.settle();
			expect(phone.client.status().inFlight).toBe(false);
		}

		expect(expectOk(authority.snapshotPosition())).toBeGreaterThan(0);
		expect(phone.titles()).toHaveLength(300);
		expect(laptop.titles()).toEqual(phone.titles());
		expect(phone.client.status().lastError).toBeUndefined();
		expect(laptop.client.status().lastError).toBeUndefined();
	});
});

/**
 * The same application one release later: `notes` grew a field.
 *
 * `pinned` declares no default, so it is a field the older release's rows cannot
 * satisfy. That asymmetry is the point: an extra field is invisible to a database
 * that does not declare it, while a missing one is a row a database cannot read, and
 * the two directions have to be told apart.
 */
const newerDatabase = defineApp({
	id: 'so.epicenter.honeycrisp',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			pinned: field.boolean(),
			content: plainText(),
		}),
	},
});

/** The same application again, one release later still: a whole new table. */
const twoTableDatabase = defineApp({
	id: 'so.epicenter.honeycrisp',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			content: plainText(),
		}),
		tasks: defineTable({
			label: field.string(),
			content: plainText(),
		}),
	},
});

describe('two devices whose databases disagree', () => {
	/** One partition, two devices, each running the release it was given. */
	async function pair<
		const TDatabase extends typeof newerDatabase | typeof twoTableDatabase,
	>(updatedDatabase: TDatabase) {
		const wire = createWire();
		const { authority, hub } = openAuthority();
		const updated = await openReplica('updated', hub, wire, updatedDatabase);
		const updatedDb = updated.bound as DeclaredData<TDatabase>;
		const updatedNotes: DeclaredData<TDatabase>['tables']['notes'] =
			updatedDb.tables.notes;
		const older = await openReplica('older', hub, wire);
		updated.connect();
		older.connect();
		return {
			wire,
			authority,
			hub,
			updated,
			older,
			updatedDb,
			updatedNotes,
			olderNotes: older.db.tables.notes,
		};
	}

	test('a field the older release cannot name survives a round trip through it', async () => {
		// The case that decides whether a release can be rolled out to one device at
		// a time. If the older release rewrote rows as its own database sees them, every
		// edit made on the un-updated phone would silently strip the new field from
		// the updated laptop's rows.
		const { wire, updated, updatedNotes, older, olderNotes } =
			await pair(newerDatabase);
		const made = updatedNotes.create({ title: 'Groceries', pinned: true });
		await updated.data.persistence.flush();
		updated.client.flush();
		await wire.settle();

		// The older release sees the row, minus the one field it cannot name, and
		// reports no trouble: an undeclared key is not a conformance failure.
		const seen = olderNotes;
		expect(seen.nonconforming).toEqual([]);
		expect(seen.rows).toMatchObject([{ id: made.id, title: 'Groceries' }]);

		expectOk(olderNotes.update(made.id, { title: 'Groceries and milk' }));
		await older.data.persistence.flush();
		older.client.flush();
		await wire.settle();

		// Both halves in one assertion, and each is the other's control. The new
		// title proves the round trip actually happened; `pinned` proves it did not
		// cost the updated device a field the older one had never heard of.
		expect(updatedNotes.get(made.id)).toMatchObject({
			id: made.id,
			title: 'Groceries and milk',
			pinned: true,
		});
	});

	test('CONTROL: the older release can still destroy the row entirely', async () => {
		// Without this, "the field survived" would pass for a channel that carries
		// nothing back from the older device at all. A delete authored there has to
		// reach the updated device and take the row with it.
		const { wire, updated, updatedNotes, older, olderNotes } =
			await pair(newerDatabase);
		const made = updatedNotes.create({ title: 'Groceries', pinned: true });
		await updated.data.persistence.flush();
		updated.client.flush();
		await wire.settle();

		olderNotes.delete(made.id);
		await older.data.persistence.flush();
		older.client.flush();
		await wire.settle();

		expect(updatedNotes.get(made.id)).toBeUndefined();
		expect(updatedNotes.ids()).toEqual([]);
	});

	test('a row the newer release cannot read is reported, not dropped', async () => {
		// The other direction, which is what the updated device sees for every row
		// the un-updated one writes. A row it cannot read is still a row and is
		// still in the CRDT: the failure names the address and carries what did
		// pass, so the application can repair it or show it.
		const { wire, updatedNotes, older, olderNotes } = await pair(newerDatabase);
		const made = olderNotes.create({ title: 'Groceries' });
		await older.data.persistence.flush();
		older.client.flush();
		await wire.settle();

		const seen = updatedNotes;
		expect(seen.rows).toEqual([]);
		expect(seen.nonconforming).toHaveLength(1);
		const failure = seen.nonconforming[0];
		expect(failure?.id).toBe(made.id);
		expect(failure?.issues.map((issue) => issue.field)).toEqual(['pinned']);
		// What could be read, which is what recovery is composed from.
		expect(failure?.conforming).toEqual({ id: made.id, title: 'Groceries' });
		expect(failure?.raw).toEqual({ title: 'Groceries' });
		// And it was not dropped on the way in: the row is on this device.
		expect(updatedNotes.ids()).toEqual([made.id]);
	});

	test('CONTROL: a row the newer release CAN read is in rows and reported nowhere', async () => {
		// Without this, "reported rather than dropped" would pass for a database that
		// reports every row it is handed.
		const { wire, updated, updatedNotes, older } = await pair(newerDatabase);
		const made = updatedNotes.create({ title: 'Groceries', pinned: false });
		await updated.data.persistence.flush();
		updated.client.flush();
		await wire.settle();
		expect(older.titles()).toEqual(['Groceries']);

		const seen = updatedNotes;
		expect(seen.nonconforming).toEqual([]);
		expect(seen.rows).toMatchObject([
			{ id: made.id, title: 'Groceries', pinned: false },
		]);
	});

	test('a table the older release does not declare waits in the CRDT for one that does', async () => {
		// The claim ADR-0240 makes about an undeclared table, checked across the
		// transport rather than inside one store. The older device relays and stores
		// rows of a table it has no name for, and they are there the moment it is
		// updated, without anybody re-sending anything.
		const { wire, updated, updatedDb, updatedNotes, older } =
			await pair(twoTableDatabase);
		updatedNotes.create({ title: 'Groceries' });
		const task = updatedDb.tables.tasks.create({ label: 'buy milk' });
		await updated.data.persistence.flush();
		updated.client.flush();
		await wire.settle();

		expect(older.titles()).toEqual(['Groceries']);
		// It holds no handle for the table it has no name for.
		expect(older.bound.tables.tasks).toBeUndefined();

		// The device is updated: same durable file, the next runtime, a
		// declaration that now names the table (ADR-0240).
		const upgraded = await older.upgrade(twoTableDatabase);
		expect(tableOf(upgraded.bound, 'tasks').rows).toMatchObject([
			{ id: task.id, label: 'buy milk' },
		]);
	});

	test('updating a device to a declaration with a new FIELD keeps working', async () => {
		// The mismatch seen from the device that is doing the updating, which is
		// the likeliest way a declaration ever changes.
		const wire = createWire();
		const { hub } = openAuthority();
		const updating = await openReplica('updating', hub, wire);
		const other = await openReplica('other', hub, wire);
		const otherNotes = other.db.tables.notes;
		updating.connect();
		other.connect();
		otherNotes.create({ title: 'Groceries' });
		await other.data.persistence.flush();
		other.client.flush();
		await wire.settle();
		expect(updating.titles()).toEqual(['Groceries']);

		// The device is updated (ADR-0240): close this runtime, reopen the same
		// durable file under the declaration that adds the field. Adding a
		// field is the most ordinary change a release makes.
		const upgraded = await updating.upgrade(newerDatabase);
		upgraded.connect();

		const upgradedDb = upgraded.bound as DeclaredData<typeof newerDatabase>;
		const upgradedNotes = upgradedDb.tables.notes;
		// The pre-existing row is REPORTED rather than repaired or dropped, because
		// `pinned` is declared without a default and that row predates it
		// (ADR-0213). It is still in the CRDT, and `conforming` carries what could
		// be read, which is the whole recovery composition.
		const listed = upgradedNotes;
		expect(listed.rows).toHaveLength(0);
		expect(listed.nonconforming).toHaveLength(1);
		expect(listed.nonconforming[0]?.conforming).toMatchObject({
			title: 'Groceries',
		});
		expect(upgradedNotes.ids()).toHaveLength(1);

		// CONTROL: the new field really is there now, which is exactly what the
		// old relation was missing. A drop that failed to recreate fails here.
		expect(upgradedNotes.create({ title: 'Bread', pinned: true }).pinned).toBe(
			true,
		);

		// And it keeps syncing rather than stopping dead at the next entry.
		otherNotes.create({ title: 'Milk' });
		await other.data.persistence.flush();
		other.client.flush();
		await wire.settle();
		expect(upgraded.client.status().lastError).toBeUndefined();
		expect(upgradedNotes.ids()).toHaveLength(3);
	});

	test('CONTROL: updating a device to a declaration with a new TABLE leaves it working', async () => {
		// The isolation: upgrading to a declaration that ADDS a table over the
		// same file succeeds, and the device keeps syncing.
		const wire = createWire();
		const { hub } = openAuthority();
		const updating = await openReplica('updating', hub, wire);
		const other = await openReplica('other', hub, wire);
		const otherNotes = other.db.tables.notes;
		updating.connect();
		other.connect();
		otherNotes.create({ title: 'Groceries' });
		await other.data.persistence.flush();
		other.client.flush();
		await wire.settle();

		const upgraded = await updating.upgrade(twoTableDatabase);
		upgraded.connect();

		expect(tableOf(upgraded.bound, 'tasks').rows).toMatchObject([]);
		otherNotes.create({ title: 'Bread' });
		await other.data.persistence.flush();
		other.client.flush();
		await wire.settle();
		expect(upgraded.titles()).toEqual(['Bread', 'Groceries']);
		expect(upgraded.client.status().lastError).toBeUndefined();
	});

	test('CONTROL: the new table on a device that never received them holds nothing', async () => {
		// Without this, the upgrade above would pass for an open that invents
		// rows, or for a `tasks` relation that was somehow already populated.
		const wire = createWire();
		const { hub } = openAuthority();
		const absent = await openReplica('absent', hub, wire);

		const upgraded = await absent.upgrade(twoTableDatabase);

		expect(tableOf(upgraded.bound, 'tasks').rows).toMatchObject([]);
	});
});

/**
 * A deterministic pseudo-random source.
 *
 * Seeded so a failure is reproducible: the seed is printed with any failure and
 * replaying it replays the exact schedule. `Math.random` would make a red run
 * unreproducible, which is the difference between a fuzz that finds bugs and
 * one that only reports them.
 */
function createRandom(seed: number) {
	let state = seed >>> 0;
	return {
		next(): number {
			// xorshift32, chosen because it is four lines and needs no library.
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) / 0x1_0000_0000;
		},
		below(bound: number): number {
			return Math.floor(this.next() * bound);
		},
		chance(probability: number): boolean {
			return this.next() < probability;
		},
	};
}

/**
 * Random operations against several replicas, then everyone must agree.
 *
 * The point is to generate schedules nobody designed. Every other test here
 * asserts a scenario someone imagined, so it can only find bugs someone already
 * imagined; the two real defects this transport shipped were both found by
 * running it rather than by testing it.
 *
 * The invariant is exact rather than statistical, which is what makes a failure
 * mean something. **A replica only ever updates or deletes rows it created
 * itself**, so there is no concurrent write to one field and the final state is
 * computable in a plain `Map`: every row created and not deleted, with the last
 * title its owner gave it, present on every replica exactly once.
 */
async function fuzz(
	seed: number,
	{ replicas, rounds }: { replicas: number; rounds: number },
) {
	const random = createRandom(seed);
	const wire = createWire();
	const { authority, hub } = openAuthority(TINY_FLOOR);
	const devices = await Promise.all(
		Array.from({ length: replicas }, (_, index) =>
			openReplica(`device-${index}`, hub, wire),
		),
	);
	/** What every replica must end up holding, tracked outside the system. */
	const expected = new Map<string, string>();
	/** Which rows each device owns, so nothing ever writes to another's row. */
	const owned = devices.map(() => [] as string[]);
	const online = devices.map(() => false);
	const seen = { creates: 0, updates: 0, deletes: 0, drops: 0, nodeEdits: 0 };

	const connect = (index: number) => {
		if (online[index]) return;
		devices[index]?.connect();
		online[index] = true;
	};
	const disconnect = (index: number) => {
		if (!online[index]) return;
		devices[index]?.disconnect();
		online[index] = false;
		seen.drops += 1;
	};

	for (let index = 0; index < replicas; index += 1) connect(index);

	for (let round = 0; round < rounds; round += 1) {
		const index = random.below(replicas);
		const device = devices[index];
		const mine = owned[index];
		if (device === undefined || mine === undefined) continue;

		const roll = random.next();
		if (roll < 0.45 || mine.length === 0) {
			const title = `r${round} from ${index}`;
			const made = device.db.tables.notes.create({ title });
			mine.push(made.id);
			expected.set(made.id, title);
			seen.creates += 1;
		} else if (roll < 0.65) {
			const rowId = mine[random.below(mine.length)] as string;
			const title = `r${round} edited by ${index}`;
			expectOk(device.db.tables.notes.update(rowId, { title }));
			expected.set(rowId, title);
			seen.updates += 1;
		} else if (roll < 0.78) {
			const at = random.below(mine.length);
			const rowId = mine[at] as string;
			device.db.tables.notes.delete(rowId);
			mine.splice(at, 1);
			expected.delete(rowId);
			seen.deletes += 1;
		} else {
			// A node edit, which is the one thing that reaches storage without going
			// through a store verb.
			const rowId = mine[random.below(mine.length)] as string;
			const text = editorOf(device, rowId);
			text.applyDelta(text.change.insert('x') as never);
			seen.nodeEdits += 1;
		}

		if (random.chance(0.6)) device.client.flush();
		if (random.chance(0.5)) await wire.settle();
		// A snapshot offer requested mid-schedule encodes asynchronously.
		if (random.chance(0.5)) await wire.settle();
		if (random.chance(0.12)) disconnect(random.below(replicas));
		if (random.chance(0.25)) connect(random.below(replicas));
		// Checked every round rather than at the end. A durable cursor ahead of
		// its bytes converges anyway while the process lives, so the final
		// assertions below cannot see it: a snapshot path stamping five positions
		// ahead of what it applied passed this entire file.
		durableCursorNeverLeads(devices);
	}

	// Everyone comes back and everything drains. A replica reporting `needsResync`
	// is reconnected, which is the repair a caller owes it.
	for (let index = 0; index < replicas; index += 1) connect(index);
	await wire.settle();
	for (let index = 0; index < replicas; index += 1) {
		if (devices[index]?.client.status().needsResync !== true) continue;
		disconnect(index);
		connect(index);
		await wire.settle();
	}
	for (const device of devices) device.client.flush();
	await wire.settle();
	// A second pass, because a flush can only carry what the previous settle
	// delivered, and a device that reconnected last needs one more exchange.
	for (const device of devices) device.client.flush();
	await wire.settle();

	return { devices, authority, expected, seen };
}

describe('random schedules, and everyone still agrees', () => {
	for (const seed of [1, 7, 12345, 987654321]) {
		test(`seed ${seed}: every replica holds exactly what was written`, async () => {
			const { devices, expected, seen } = await fuzz(seed, {
				replicas: 3,
				rounds: 220,
			});

			const wanted = [...expected.values()].sort();
			for (const device of devices) {
				// Compared against a model kept OUTSIDE the system, so this cannot be
				// satisfied by every replica agreeing on the wrong thing, which is
				// what a convergence-only assertion would accept.
				expect(device.titles()).toEqual(wanted);
				expect(device.client.status().unresolvedDependencies).toBe(false);
				expect(device.client.status().lastError).toBeUndefined();
			}

			// CONTROLS: a schedule that never deleted, never disconnected or never
			// snapshotted would pass the assertions above while testing none of the
			// paths this fuzz exists for.
			expect(seen.creates).toBeGreaterThan(10);
			expect(seen.deletes).toBeGreaterThan(0);
			expect(seen.drops).toBeGreaterThan(0);
			expect(seen.nodeEdits).toBeGreaterThan(0);
			expect(wanted.length).toBeGreaterThan(10);
		});
	}

	test('CONTROL: the model notices when a replica is missing a row', async () => {
		// Without this, `titles()` compared against a model proves nothing unless
		// the comparison can actually fail. A row created on a device that never
		// reconnects must NOT satisfy it.
		const { devices, expected } = await fuzz(42, { replicas: 2, rounds: 60 });
		const first = devices[0];
		if (first === undefined) throw new Error('no device');
		expected.set('never-synchronised', 'a row nobody has');

		expect(first.titles()).not.toEqual([...expected.values()].sort());
	});
});

describe('wire admission precedes catch-up and membership requires delivery', () => {
	test('any connection is admitted and caught up from its own cursor', async () => {
		const { wire, hub, phone } = await setup();
		phone.connect();
		for (let index = 0; index < 3; index += 1) {
			phone.db.tables.notes.create({ title: `note ${index}` });
			await phone.data.persistence.flush();
			phone.client.flush();
			await wire.settle();
		}

		const sent: Uint8Array[] = [];
		const late: HubConnection = {
			cursor: 2,
			send: (bytes) => sent.push(bytes),
		};
		expect(hub.join(late)).toBe('admitted');
		expect(hub.attached()).toBe(2);
		// Admission precedes everything after its cursor.
		expect(sent.map((bytes) => expectOk(decodeFrame(bytes)))).toEqual([
			{ kind: 'admitted' },
			expect.objectContaining({ kind: 'entry', seq: 3 }),
		]);
	});

	test('a cursor at the head receives only admission', async () => {
		const { wire, hub, phone } = await setup();
		phone.connect();
		phone.db.tables.notes.create({ title: 'current' });
		await phone.data.persistence.flush();
		phone.client.flush();
		await wire.settle();

		const sent: Uint8Array[] = [];
		const caughtUp: HubConnection = {
			cursor: 1,
			send: (bytes) => sent.push(bytes),
		};
		expect(hub.join(caughtUp)).toBe('admitted');
		expect(hub.attached()).toBe(2);
		expect(sent.map((bytes) => expectOk(decodeFrame(bytes)))).toEqual([
			{ kind: 'admitted' },
		]);
	});

	test('a catch-up failure removes membership after wire admission', async () => {
		const { authority } = openAuthority();
		const broken: SyncAuthority = {
			...authority,
			snapshot: () => AuthorityError.StorageFailed({ cause: new Error('io') }),
		};
		const hub = createSyncHub({ authority: broken });
		const sent: Uint8Array[] = [];
		const connection: HubConnection = {
			cursor: 5,
			send: (bytes) => sent.push(bytes),
		};
		expect(hub.join(connection)).toBe('unavailable');
		expect(hub.attached()).toBe(0);
		expect(sent.map((bytes) => expectOk(decodeFrame(bytes)))).toEqual([
			{ kind: 'admitted' },
		]);
	});
});
