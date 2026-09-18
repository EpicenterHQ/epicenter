import { defineApp, defineTable, field, plainText } from '@epicenter/app';

/**
 * The driver, over the same hub and authority that get deployed.
 *
 * Only the socket and the clock are stand-ins. The socket is a queue that
 * delivers in order exactly like a real one, and the clock is a list of due
 * tasks, so a test can hold messages in the wire and step time forward without
 * waiting for any of it.
 *
 * Every test that claims something arrived asserts on the RECEIVING replica's
 * own rows, never on a counter this file keeps, and every claim that a repair
 * happened is paired with a control showing the same schedule without the
 * repair does NOT converge. A rule on this branch once "worked" in a simulation
 * where nothing was ever delivered.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Result } from 'wellcrafted/result';

import {
	type DeclaredData,
	openAccountStore,
	syncEngineOf,
} from '../store/store.js';
import { openSyncAuthority } from './authority.js';
import {
	createSyncConnection,
	type SyncAttempt,
	type SyncDial,
} from './connection.js';
import { encodeFrame } from './frames.js';
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

function expectOk<TValue, TError>(
	result: Result<TValue, TError> | TValue,
): TValue {
	if (
		typeof result === 'object' &&
		result !== null &&
		'data' in result &&
		'error' in result
	) {
		const outcome = result as Result<TValue, TError>;
		if (outcome.error !== null) throw outcome.error;
		return outcome.data as TValue;
	}
	return result as TValue;
}

/** A network that delivers in order, and only when told to. */
function createWire() {
	const queue: (() => void)[] = [];
	return {
		defer(task: () => void) {
			queue.push(task);
		},
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
		inFlight: () => queue.length,
	};
}
type Wire = ReturnType<typeof createWire>;

/**
 * A clock made of due tasks, satisfying the same `Schedule` the driver injects.
 *
 * The driver's backoff, its healthy window and its watchdog are all delays, and
 * so is the client's idle timer underneath it, so all four run on this one
 * clock and a test says how much time passed rather than waiting for it.
 */
function createClock() {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; task: () => void }>();
	return {
		schedule(task: () => void, delayMs: number) {
			nextId += 1;
			const id = nextId;
			timers.set(id, { at: now + delayMs, task });
			return () => timers.delete(id);
		},
		/** Run everything due within `ms`, in time order, including what it schedules. */
		advance(ms: number) {
			const target = now + ms;
			let guard = 0;
			for (;;) {
				guard += 1;
				if (guard > 10_000) throw new Error('the clock never settled');
				let dueId: number | undefined;
				let dueAt = Number.POSITIVE_INFINITY;
				for (const [id, timer] of timers) {
					if (timer.at <= target && timer.at < dueAt) {
						dueAt = timer.at;
						dueId = id;
					}
				}
				if (dueId === undefined) break;
				const timer = timers.get(dueId) as { at: number; task: () => void };
				timers.delete(dueId);
				now = timer.at;
				timer.task();
			}
			now = target;
		},
		pending: () => timers.size,
	};
}
type Clock = ReturnType<typeof createClock>;

function openAuthority() {
	const sqlite = createBunSqliteAdapter(new Database(':memory:'));
	const authority = openSyncAuthority({ sqlite });
	return { authority, hub: createSyncHub({ authority, batch: 8 }) };
}

/**
 * One replica whose connection is driven entirely by `createSyncConnection`.
 *
 * Nothing here calls `nudge`, `attach`, `detach` or `receive`. That is the
 * point: everything a host used to write by hand is now the driver's, and the
 * host writes only `dial`.
 */
async function openDriven({
	hub,
	wire,
	clock,
	...options
}: {
	hub: ReturnType<typeof createSyncHub>;
	wire: Wire;
	clock: Clock;
	healthyMs?: number;
	unacknowledgedMs?: number;
	backoff?: (failures: number) => number;
}) {
	const data = await openAccountStore({
		definition: database,
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	const store = data;
	const db = data as DeclaredData<typeof database>;

	/** Cursor each dial asked the authority to start after, oldest first. */
	const dialledFrom: number[] = [];
	/** How many frames the next socket swallows before delivering any. */
	let swallow = 0;
	let generation = 0;
	let breakSocket: (() => void) | undefined;

	const dial: SyncDial = ({ cursor, opened, received, closed }) => {
		dialledFrom.push(cursor);
		generation += 1;
		const mine = generation;
		const connection: HubConnection = {
			cursor,
			send: (bytes) =>
				wire.defer(() => {
					if (mine !== generation) return;
					if (swallow > 0) {
						swallow -= 1;
						return;
					}
					received(bytes);
				}),
		};
		opened({
			send: (bytes) =>
				wire.defer(() => {
					if (mine === generation) hub.receive(connection, bytes);
				}),
		});
		hub.join(connection);
		// The server dropping the socket, which is what a hibernating Durable
		// Object, a lost network and a rejected credential all look like here.
		breakSocket = () => {
			if (mine !== generation) return;
			generation += 1;
			hub.leave(connection);
			closed();
		};
		return () => {
			if (mine !== generation) return;
			generation += 1;
			hub.leave(connection);
		};
	};

	const connection = createSyncConnection({
		onRetired: () => undefined,
		store,
		dial,
		schedule: clock.schedule,
		...options,
	});

	return {
		store,
		db,
		connection,
		dialledFrom,
		/** Make the next socket lose its first `count` frames from the authority. */
		loseNextFrames(count: number) {
			swallow = count;
		},
		breakSocket: () => breakSocket?.(),
		titles: () => db.tables.notes.rows.map((row) => row.title).sort(),
	};
}

async function setup(
	options: {
		healthyMs?: number;
		unacknowledgedMs?: number;
		backoff?: (failures: number) => number;
	} = {},
) {
	const wire = createWire();
	const clock = createClock();
	const { authority, hub } = openAuthority();
	const phone = await openDriven({ hub, wire, clock, ...options });
	const laptop = await openDriven({ hub, wire, clock, ...options });
	return { wire, clock, authority, hub, phone, laptop };
}

/**
 * Let time and delivery interleave, the way they do on a real device.
 *
 * In slices rather than one jump, and this is not a detail. Advancing the whole
 * interval before letting the wire deliver anything means a submission sent at
 * one timer cannot be acknowledged before the next fires, which manufactures a
 * stall the watchdog then correctly reports: the first version of this helper
 * did exactly that and made a working driver look broken.
 */
async function run(wire: Wire, clock: Clock, ms: number, sliceMs = 100) {
	let elapsed = 0;
	for (;;) {
		await wire.settle();
		if (elapsed >= ms) return;
		const slice = Math.min(sliceMs, ms - elapsed);
		clock.advance(slice);
		elapsed += slice;
	}
}

describe('a write syncs without anyone remembering to say so', () => {
	test('a row created on one device arrives on the other', async () => {
		// Nothing in this test nudges or flushes. The store announces its own
		// local work and the driver starts the idle timer, which is the whole
		// point: a caller that forgets used to leave the write sitting in the
		// outbox until some unrelated write happened to start the timer.
		const { wire, clock, phone, laptop } = await setup();
		phone.connection.start();
		laptop.connection.start();
		await run(wire, clock, 0);

		expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
		await run(wire, clock, 1_000);

		expect(laptop.titles()).toEqual(['Groceries']);
	});

	test('CONTROL: it does NOT arrive before the idle timer fires', async () => {
		// The isolation. If this ever fails, the test above is measuring the
		// harness delivering eagerly rather than the store's announcement.
		const { wire, clock, phone, laptop } = await setup();
		phone.connection.start();
		laptop.connection.start();
		await run(wire, clock, 0);

		expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
		await run(wire, clock, 0);

		expect(laptop.titles()).toEqual([]);
	});

	test("text written into a row's content node syncs on the same timer", async () => {
		const { wire, clock, phone, laptop } = await setup();
		phone.connection.start();
		laptop.connection.start();
		await run(wire, clock, 0);

		const note = expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
		const body = phone.db.tables.notes.get(note.id)?.content;
		if (body === undefined) throw new Error('the row has no content');
		body.applyDelta(body.change.insert('milk and eggs') as never);
		await run(wire, clock, 1_000);

		const arrived = laptop.db.tables.notes.get(note.id)?.content;
		expect(JSON.stringify(arrived?.toJSON())).toContain('milk and eggs');
	});
});

describe('a gap is repaired without anybody noticing it', () => {
	test('a lost entry wedges the replica, and the driver reconnects it', async () => {
		// The failure a randomised schedule found: a device wedged at 108 kept
		// receiving 118, 119 and 121 and rejecting all of them, with no error
		// surfaced and the socket perfectly healthy. The client sets
		// `needsResync` and waits for someone to notice; this is that someone.
		const { wire, clock, phone, laptop } = await setup();
		phone.connection.start();
		laptop.connection.start();
		await run(wire, clock, 0);

		// The laptop loses the frame carrying the first entry, so the second is
		// a gap and every later one is too.
		laptop.loseNextFrames(1);
		expectOk(phone.db.tables.notes.create({ title: 'first' }));
		await run(wire, clock, 1_000);
		expectOk(phone.db.tables.notes.create({ title: 'second' }));
		await run(wire, clock, 1_000);
		expect(laptop.connection.status().needsResync).toBe(true);

		// The backoff, and then the catch-up from the laptop's own cursor.
		await run(wire, clock, 5_000);

		expect(laptop.titles()).toEqual(['first', 'second']);
		expect(laptop.connection.status().needsResync).toBe(false);
		expect(laptop.connection.status().lastReconnect).toBe('resync');
	});

	test('CONTROL: without the reconnect the same schedule stays wedged forever', async () => {
		// The same lost frame, driven by hand the way every host used to drive
		// it, with the one rule that used to be optional left out. It never
		// recovers however long it is left alone.
		const wire = createWire();
		const clock = createClock();
		const { hub } = openAuthority();
		const phone = await openDriven({ hub, wire, clock });
		const laptop = await openDriven({
			hub,
			wire,
			clock,
			// A backoff so long it never elapses inside this test, which is what
			// "the caller never reconnects" looks like on this clock.
			backoff: () => 1_000_000,
		});
		phone.connection.start();
		laptop.connection.start();
		await run(wire, clock, 0);

		laptop.loseNextFrames(1);
		expectOk(phone.db.tables.notes.create({ title: 'first' }));
		await run(wire, clock, 1_000);
		expectOk(phone.db.tables.notes.create({ title: 'second' }));
		await run(wire, clock, 60_000);

		expect(laptop.titles()).toEqual([]);
		expect(laptop.connection.status().needsResync).toBe(true);
	});
});

describe('a socket that dies is dialled again from the replica own cursor', () => {
	test('work written while disconnected goes out on reconnect', async () => {
		const { wire, clock, phone, laptop } = await setup();
		phone.connection.start();
		laptop.connection.start();
		await run(wire, clock, 0);
		expectOk(phone.db.tables.notes.create({ title: 'before' }));
		await run(wire, clock, 1_000);
		expect(laptop.titles()).toEqual(['before']);

		phone.breakSocket();
		expectOk(phone.db.tables.notes.create({ title: 'while offline' }));
		await run(wire, clock, 5_000);

		expect(laptop.titles()).toEqual(['before', 'while offline']);
		expect(phone.connection.status().lastReconnect).toBe('closed');
	});

	test('every dial asks from what this replica has applied', async () => {
		const { wire, clock, phone, laptop } = await setup();
		phone.connection.start();
		laptop.connection.start();
		await run(wire, clock, 0);
		expectOk(phone.db.tables.notes.create({ title: 'first' }));
		await run(wire, clock, 1_000);

		laptop.breakSocket();
		await run(wire, clock, 5_000);

		// Two dials, not three. The first is the ordinary open at zero; the
		// bootstrap round-trip that used to sit between them went with the
		// identity stamp (ADR-0292), because there is no longer a name to be
		// handed and reconnect with.
		//
		// Not zero on the second. A reconnect that asked from the start would
		// work, and would re-download everything on every wobble; it resumes
		// from the applied cursor instead.
		expect(laptop.dialledFrom).toEqual([0, 1]);
	});

	test('a socket that never stays up backs off, and a working one resets it', async () => {
		const { wire, clock, phone } = await setup({ healthyMs: 5_000 });
		phone.connection.start();
		await run(wire, clock, 0);

		for (let attempt = 0; attempt < 3; attempt += 1) {
			phone.breakSocket();
			// Just past this attempt's backoff, and well short of the healthy
			// window, so the redial happens and never counts as a good connection.
			await run(wire, clock, 1_000 * 2 ** attempt + 1);
		}
		expect(phone.connection.status().failures).toBe(3);

		// One socket that lasts, and the count goes back to nothing.
		await run(wire, clock, 5_000);

		expect(phone.connection.status().failures).toBe(0);
	});
});

describe('a submission nobody answers is not waited on forever', () => {
	test('the watchdog reconnects, and the work is delivered afterwards', async () => {
		// The production stall in `evidence/workerd/results.md`, made
		// self-healing without knowing what causes it: a sustained run against
		// Cloudflare stopped waiting for an acknowledgement, four hypotheses
		// were tested and none of them was it.
		const { wire, clock, phone, laptop } = await setup({
			unacknowledgedMs: 10_000,
		});
		phone.connection.start();
		laptop.connection.start();
		await run(wire, clock, 0);

		// The push leaves and its acknowledgement never comes back.
		phone.loseNextFrames(1);
		expectOk(phone.db.tables.notes.create({ title: 'first' }));
		await run(wire, clock, 1_000);
		expect(phone.connection.status().inFlight).toBe(true);

		// The damage. One submission is out at a time, so nothing this device
		// writes from here on can leave, and every layer still reports success.
		expectOk(phone.db.tables.notes.create({ title: 'second' }));
		await run(wire, clock, 5_000);
		expect(laptop.titles()).toEqual(['first']);

		// Two ticks: the first records the submission, the second finds the same
		// one still out. One tick would reconnect a busy client on every pass.
		await run(wire, clock, 25_000);

		expect(phone.connection.status().lastReconnect).toBe('stalled');
		expect(laptop.titles()).toEqual(['first', 'second']);
	});

	test('CONTROL: a client that keeps getting acknowledged is never reconnected', async () => {
		// The false positive the submission NUMBER exists to avoid. Only one
		// submission is ever out and the next starts the moment the previous is
		// acknowledged, so under sustained work `inFlight` is continuously true
		// on a completely healthy client.
		const { wire, clock, phone, laptop } = await setup({
			unacknowledgedMs: 1_000,
		});
		phone.connection.start();
		laptop.connection.start();
		await run(wire, clock, 0);

		for (let index = 0; index < 20; index += 1) {
			expectOk(phone.db.tables.notes.create({ title: `note ${index}` }));
			await run(wire, clock, 1_100);
		}

		expect(phone.connection.status().lastReconnect).toBeUndefined();
		expect(laptop.titles()).toHaveLength(20);
	});
});

describe('a refused dial is reported and dialled again', () => {
	/**
	 * A replica whose host refuses every dial the way an auth-owned
	 * `openWebSocket` does: `refuseEvery` reports the refusal's code, otherwise
	 * the attempt just closes, which is what a transport failure (network loss,
	 * an unreachable authority) is reported as.
	 */
	async function openRefused({
		clock,
		refuseEvery,
	}: {
		clock: Clock;
		refuseEvery: boolean;
	}) {
		const data = await openAccountStore({
			definition: database,
			sqlite: createBunSqliteAdapter(new Database(':memory:')),
		});
		const store = data;
		const db = data as DeclaredData<typeof database>;
		let dials = 0;
		const connection = createSyncConnection({
			onRetired: () => undefined,
			store,
			schedule: clock.schedule,
			dial: ({ closed }) => {
				dials += 1;
				// Rejected before any socket opened, like a thrown `openWebSocket`.
				if (refuseEvery) closed('reauth-required');
				else closed();
				return () => undefined;
			},
		});
		return { db, connection, dials: () => dials };
	}

	test('a refusal is status, not a stop: the driver keeps dialling', async () => {
		const clock = createClock();
		const replica = await openRefused({ clock, refuseEvery: true });
		replica.connection.start();
		clock.advance(120_000);

		// The whole point, pinned to the arithmetic rather than to a floor. The
		// default backoff doubles from a second and caps at thirty, so under a
		// standing refusal the dials land at 0, 1, 3, 7, 15, 31, 61 and 91
		// seconds, and the ninth is due at 121.
		expect(replica.dials()).toBe(8);
		expect(replica.connection.status().failures).toBe(8);
		expect(replica.connection.status().refusal).toBe('reauth-required');
		expect(replica.connection.status().lastReconnect).toBe('refused');
		expect(replica.connection.status().connected).toBe(false);

		// The store subscription and the client are both still held, which the
		// old `denied` path released. A local write reaches a live client and
		// schedules its idle send, which is the timer counted here: a driver
		// that had let go would take the write and schedule nothing.
		const scheduled = clock.pending();
		expectOk(replica.db.tables.notes.create({ title: 'local only' }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(clock.pending()).toBe(scheduled + 1);
	});

	test('disposal under a standing refusal lets go of everything', async () => {
		const clock = createClock();
		const replica = await openRefused({ clock, refuseEvery: true });
		replica.connection.start();
		clock.advance(120_000);
		const dialled = replica.dials();

		replica.connection[Symbol.dispose]();
		clock.advance(120_000);

		expect(replica.dials()).toBe(dialled);
		expect(clock.pending()).toBe(0);
	});

	test('a dial that reaches the wire clears the refusal even when it fails', async () => {
		const clock = createClock();
		const data = await openAccountStore({
			definition: database,
			sqlite: createBunSqliteAdapter(new Database(':memory:')),
		});
		let refuse = true;
		const connection = createSyncConnection({
			onRetired: () => undefined,
			store: data,
			schedule: clock.schedule,
			dial: ({ closed }) => {
				if (refuse) closed('reauth-required');
				else closed();
				return () => undefined;
			},
		});
		connection.start();
		expect(connection.status().refusal).toBe('reauth-required');

		// A person signs back in and the network is down. The credential model
		// no longer refuses, so the status must stop saying it does: telling a
		// signed-in person to sign in is the one thing this must not do.
		refuse = false;
		clock.advance(2_000);

		expect(connection.status().refusal).toBeUndefined();
		expect(connection.status().lastReconnect).toBe('closed');
		connection[Symbol.dispose]();
	});

	test('a socket that opens clears the refusal', async () => {
		const clock = createClock();
		const data = await openAccountStore({
			definition: database,
			sqlite: createBunSqliteAdapter(new Database(':memory:')),
		});
		let refuse = true;
		let dials = 0;
		const connection = createSyncConnection({
			onRetired: () => undefined,
			store: data,
			schedule: clock.schedule,
			dial: ({ closed, opened, received }) => {
				dials += 1;
				if (refuse) closed('reauth-required');
				else {
					opened({ send: () => undefined });
					received(encodeFrame({ kind: 'admitted' }));
				}
				return () => undefined;
			},
		});
		connection.start();
		expect(connection.status().refusal).toBe('reauth-required');

		refuse = false;
		clock.advance(120_000);

		expect(dials).toBeGreaterThan(1);
		expect(connection.status().refusal).toBeUndefined();
		expect(connection.status().connected).toBe(true);
		connection[Symbol.dispose]();
	});

	test('CONTROL: an ordinary close reports no refusal and retries the same way', async () => {
		const clock = createClock();
		const replica = await openRefused({ clock, refuseEvery: false });
		replica.connection.start();
		clock.advance(120_000);

		expect(replica.dials()).toBe(8);
		expect(replica.connection.status().refusal).toBeUndefined();
		expect(replica.connection.status().lastReconnect).toBe('closed');
		replica.connection[Symbol.dispose]();
	});
});

describe('the driver lets go of what it has abandoned', () => {
	test('a dead socket cannot detach the one that replaced it', async () => {
		const { wire, clock, phone, laptop } = await setup();
		phone.connection.start();
		laptop.connection.start();
		await run(wire, clock, 0);
		const stale = phone.breakSocket;
		await run(wire, clock, 5_000);

		// The socket that died two connections ago, reporting its close late.
		stale();
		expectOk(phone.db.tables.notes.create({ title: 'still connected' }));
		await run(wire, clock, 1_000);

		expect(laptop.titles()).toEqual(['still connected']);
	});

	test('disposing stops dialling and stops listening to the store', async () => {
		const { wire, clock, phone } = await setup();
		phone.connection.start();
		await run(wire, clock, 0);
		const dials = phone.dialledFrom.length;

		phone.connection[Symbol.dispose]();
		phone.breakSocket();
		expectOk(phone.db.tables.notes.create({ title: 'after disposal' }));
		await run(wire, clock, 60_000);

		expect(phone.dialledFrom).toHaveLength(dials);
		expect(phone.connection.status().connected).toBe(false);
	});
});

describe('a retired opcode on the wire is ignored, not concluded from', () => {
	// Two opcodes are retired, 8 and 9. Opcode 9 carried the authority naming
	// the history its log described, which a replica compared against its own
	// stamp and could conclude supersession from; the generation is in the
	// address now, so there is no question to ask and no verdict to draw
	// (ADR-0292). A decoder meeting either ignores it, which is what lets a
	// deployment roll forward past a peer that has not.
	test('a frame nobody understands leaves the driver running', async () => {
		const wire = createWire();
		const clock = createClock();
		const data = await openAccountStore({
			definition: database,
			sqlite: createBunSqliteAdapter(new Database(':memory:')),
		});
		const retired = new Uint8Array([9, 1, 2, 3]);
		const connection = createSyncConnection({
			onRetired: () => undefined,
			store: data,
			idleMs: 1_000,
			schedule: clock.schedule,
			dial: ({ opened, received }) => {
				opened({ send: () => undefined });
				received(encodeFrame({ kind: 'admitted' }));
				wire.defer(() => received(retired));
				return () => undefined;
			},
		});
		connection.start();
		await run(wire, clock, 0);

		expect(connection.status().connected).toBe(true);
		expect(connection.status().lastError).toBeUndefined();
		connection[Symbol.dispose]();
		void data[Symbol.asyncDispose]();
	});
});

async function openAdmissionDriver(onRetired: () => void = () => undefined) {
	const store = await openAccountStore({
		definition: database,
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	const clock = createClock();
	const attempts: SyncAttempt[] = [];
	const sent: Uint8Array[] = [];
	let stopped = 0;
	let retirements = 0;
	const connection = createSyncConnection({
		store,
		schedule: clock.schedule,
		admissionMs: 20,
		backoff: () => 10,
		onRetired() {
			retirements += 1;
			onRetired();
		},
		dial(attempt) {
			attempts.push(attempt);
			return () => {
				stopped += 1;
			};
		},
	});
	connection.start();
	return {
		store,
		connection,
		clock,
		attempts,
		sent,
		open() {
			attempts.at(-1)?.opened({ send: (bytes) => sent.push(bytes) });
		},
		retirements: () => retirements,
		stopped: () => stopped,
		async [Symbol.asyncDispose]() {
			connection[Symbol.dispose]();
			await store[Symbol.asyncDispose]();
		},
	};
}

test('socket open and local edits send nothing until explicit admission', async () => {
	await using driver = await openAdmissionDriver();
	expectOk(driver.store.tables.notes.create({ title: 'pending' }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	driver.open();
	expectOk(driver.connection.flush());
	expect(driver.sent).toHaveLength(0);
	expect(driver.connection.status().connected).toBe(false);
	driver.attempts[0]?.received(encodeFrame({ kind: 'admitted' }));
	expect(driver.sent.length).toBeGreaterThan(0);
	expect(driver.connection.status().connected).toBe(true);
	const sent = driver.sent.length;
	driver.attempts[0]?.received(encodeFrame({ kind: 'admitted' }));
	expect(driver.sent).toHaveLength(sent);
});

test('data arriving before admission cannot alter the held document or cursor', async () => {
	await using driver = await openAdmissionDriver();
	await using donor = await openAccountStore({
		definition: database,
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	expectOk(donor.tables.notes.create({ title: 'remote' }));
	const bytes = syncEngineOf(donor).encodeSnapshot();
	driver.open();
	for (const frame of [
		encodeFrame({ kind: 'snapshot', position: 4, chunk: 0, chunks: 1, bytes }),
		encodeFrame({ kind: 'entry', seq: 1, chunk: 0, chunks: 1, bytes }),
	])
		driver.attempts[0]?.received(frame);
	expect(driver.store.tables.notes.rows).toHaveLength(0);
	expect(driver.connection.status().cursor).toBe(0);
	driver.attempts[0]?.received(encodeFrame({ kind: 'admitted' }));
	driver.attempts[0]?.received(
		encodeFrame({ kind: 'entry', seq: 1, chunk: 0, chunks: 1, bytes }),
	);
	expect(driver.store.tables.notes.rows.map((row) => row.title)).toEqual([
		'remote',
	]);
});

test('retirement stops sends and retries before notifying the lifetime owner once', async () => {
	await using driver = await openAdmissionDriver(() => {
		expect(driver.connection.status().connected).toBe(false);
		expect(driver.connection.status().retired).toBe(true);
		expectOk(driver.store.tables.notes.create({ title: 'late producer' }));
		expectOk(driver.connection.flush());
	});
	driver.open();
	driver.attempts[0]?.received(encodeFrame({ kind: 'admitted' }));
	driver.attempts[0]?.received(encodeFrame({ kind: 'retired' }));
	driver.attempts[0]?.received(encodeFrame({ kind: 'retired' }));
	driver.attempts[0]?.closed();
	driver.connection.start();
	driver.clock.advance(120_000);
	expect(driver.retirements()).toBe(1);
	expect(driver.sent).toHaveLength(0);
	expect(driver.attempts).toHaveLength(1);
	expect(driver.stopped()).toBe(1);
	expect(driver.clock.pending()).toBe(0);
});

test('retirement before admission preserves pending bytes and never sends them', async () => {
	await using driver = await openAdmissionDriver();
	expectOk(driver.store.tables.notes.create({ title: 'pending' }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	driver.open();
	driver.attempts[0]?.received(encodeFrame({ kind: 'retired' }));
	driver.attempts[0]?.received(encodeFrame({ kind: 'admitted' }));
	expect(driver.retirements()).toBe(1);
	expect(driver.sent).toHaveLength(0);
	expect(driver.store.tables.notes.rows).toHaveLength(1);
});

test('stale attempts cannot admit or retire their replacement', async () => {
	await using driver = await openAdmissionDriver();
	driver.open();
	const stale = driver.attempts[0];
	stale?.closed();
	driver.clock.advance(10);
	driver.open();
	stale?.received(encodeFrame({ kind: 'admitted' }));
	expect(driver.connection.status().connected).toBe(false);
	driver.attempts[1]?.received(encodeFrame({ kind: 'admitted' }));
	stale?.received(encodeFrame({ kind: 'retired' }));
	expect(driver.connection.status().connected).toBe(true);
	expect(driver.retirements()).toBe(0);
});

test('a silent socket times out admission and retries without sending its outbox', async () => {
	await using driver = await openAdmissionDriver();
	expectOk(driver.store.tables.notes.create({ title: 'pending' }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	driver.open();
	driver.clock.advance(20);
	expect(driver.connection.status().lastReconnect).toBe('admission');
	expect(driver.stopped()).toBe(1);
	driver.clock.advance(10);
	expect(driver.attempts).toHaveLength(2);
	expect(driver.sent).toHaveLength(0);
	expect(driver.retirements()).toBe(0);
});

test('retirement inside the first outgoing chunk stops the remaining submission', async () => {
	await using driver = await openAdmissionDriver();
	expectOk(driver.store.tables.notes.create({ title: 'x'.repeat(5_000_000) }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	const attempt = driver.attempts[0];
	attempt?.opened({
		send(bytes) {
			driver.sent.push(bytes);
			attempt.received(encodeFrame({ kind: 'retired' }));
		},
	});
	expect(() =>
		attempt?.received(encodeFrame({ kind: 'admitted' })),
	).not.toThrow();
	expect(driver.sent).toHaveLength(1);
	expect(driver.retirements()).toBe(1);
	expect(driver.clock.pending()).toBe(0);
});

test('synchronous retirement during dial releases the teardown returned afterward', async () => {
	await using store = await openAccountStore({
		definition: database,
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	const clock = createClock();
	let stopped = 0;
	let retirements = 0;
	using connection = createSyncConnection({
		store,
		schedule: clock.schedule,
		onRetired: () => {
			retirements += 1;
		},
		dial(attempt) {
			attempt.opened({ send: () => undefined });
			attempt.received(encodeFrame({ kind: 'retired' }));
			return () => {
				stopped += 1;
				attempt.closed();
			};
		},
	});
	connection.start();
	clock.advance(120_000);
	expect(stopped).toBe(1);
	expect(retirements).toBe(1);
	expect(clock.pending()).toBe(0);
});

test('retirement inside a snapshot offer stops its remaining chunks', async () => {
	await using driver = await openAdmissionDriver();
	await using donor = await openAccountStore({
		definition: database,
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	expectOk(donor.tables.notes.create({ title: 'x'.repeat(5_000_000) }));
	const attempt = driver.attempts[0];
	attempt?.opened({
		send(bytes) {
			driver.sent.push(bytes);
			attempt.received(encodeFrame({ kind: 'retired' }));
		},
	});
	attempt?.received(encodeFrame({ kind: 'admitted' }));
	attempt?.received(
		encodeFrame({
			kind: 'snapshot',
			position: 1,
			chunk: 0,
			chunks: 1,
			bytes: syncEngineOf(donor).encodeSnapshot(),
		}),
	);
	expect(() =>
		attempt?.received(encodeFrame({ kind: 'wanted', position: 1 })),
	).not.toThrow();
	expect(driver.sent).toHaveLength(1);
	expect(driver.retirements()).toBe(1);
});

test('retirement still fences its owner when socket teardown throws', async () => {
	await using store = await openAccountStore({
		definition: database,
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	const clock = createClock();
	const failure = new Error('Socket close failed');
	let current: SyncAttempt | undefined;
	let retirements = 0;
	let sent = 0;
	using connection = createSyncConnection({
		store,
		schedule: clock.schedule,
		onRetired() {
			retirements += 1;
		},
		dial(attempt) {
			current = attempt;
			attempt.opened({
				send() {
					sent += 1;
				},
			});
			return () => {
				throw failure;
			};
		},
	});
	connection.start();
	current?.received(encodeFrame({ kind: 'admitted' }));
	expect(() => current?.received(encodeFrame({ kind: 'retired' }))).toThrow(
		failure,
	);
	expect(retirements).toBe(1);
	expect(connection.status().connected).toBe(false);
	expect(connection.status().retired).toBe(true);
	expectOk(store.tables.notes.create({ title: 'late' }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	clock.advance(120_000);
	current?.received(encodeFrame({ kind: 'retired' }));
	expect(sent).toBe(0);
	expect(retirements).toBe(1);
	expect(clock.pending()).toBe(0);
});
