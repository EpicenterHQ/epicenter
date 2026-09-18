/**
 * Current-generation admission and hub lifetime tests.
 * Retired sockets cannot read replacement bytes or finish queued and partial
 * writes. Reentrant delivery, reconstructed attachments, rollback, and receipt
 * retries preserve the generation each connection originally joined.
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openCurrentAuthority } from '../../src/sync/authority.js';
import {
	CHUNK_BYTES,
	decodeFrame,
	encodeFrame,
	type Frame,
} from '../../src/sync/frames.js';
import { createSyncHub, type HubConnection } from '../../src/sync/hub.js';

const databases: Database[] = [];
afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

function setup(bytes = new Uint8Array([1])) {
	const database = new Database(':memory:');
	databases.push(database);
	const sqlite = createBunSqliteAdapter(database);
	const owner = openCurrentAuthority({ sqlite });
	owner.ensureCurrent(bytes);
	return { owner, sqlite };
}

function peer(cursor = 0, onSend?: (frame: Frame) => void) {
	const frames: Frame[] = [];
	const connection: HubConnection = {
		cursor,
		send(bytes) {
			const frame = expectOk(decodeFrame(bytes));
			if (frame.kind === 'admitted' || frame.kind === 'retired') return;
			frames.push(frame);
			onSend?.(frame);
		},
	};
	return { connection, frames };
}

function push(submission: number, chunk = 0, chunks = 1) {
	return encodeFrame({
		kind: 'push',
		submission,
		chunk,
		chunks,
		bytes: new Uint8Array([8]),
	});
}

async function replacement(owner: ReturnType<typeof openCurrentAuthority>) {
	return owner.prepareActivation({
		operation: 'restore',
		expected: owner.capture(),
		bytes: new Uint8Array([9]),
	});
}

test('retired joins receive no replacement bytes, including reconstructed attachments', async () => {
	const { owner, sqlite } = setup();
	const old = expectOk(owner.createHub(1));
	expect((await replacement(owner)).activate().status).toBe('activated');
	for (const authority of [owner, openCurrentAuthority({ sqlite })]) {
		expect(expectErr(authority.createHub(1)).name).toBe(
			'GenerationUnavailable',
		);
	}
	for (const hub of [old, createSyncHub({ authority: owner.bind(1) })]) {
		// Hibernation reconstructs both the generation and cursor held by the socket.
		const attachment = { generation: 1, cursor: 0 };
		const { connection, frames } = peer(attachment.cursor);
		expect(hub.join(connection)).toBe('retired');
		expect(hub.attached()).toBe(0);
		hub.receive(connection, push(1));
		expect(frames).toEqual([]);
	}
	expect(owner.capture().snapshot.bytes).toEqual(new Uint8Array([9]));
	expect(owner.capture().head).toBe(1);
});

test('partial pushes and old snapshot offers cannot survive activation', async () => {
	const { owner } = setup();
	const hub = expectOk(owner.createHub(1));
	const { connection, frames } = peer();
	expect(hub.join(connection)).toBe('admitted');
	hub.receive(connection, push(1, 0, 2));
	const before = frames.length;
	expect((await replacement(owner)).activate().status).toBe('activated');
	hub.receive(connection, push(1, 1, 2));
	hub.receive(
		connection,
		encodeFrame({
			kind: 'offer',
			position: 1,
			chunk: 0,
			chunks: 1,
			bytes: new Uint8Array([7]),
		}),
	);
	expect(frames).toHaveLength(before);
	expect(hub.attached()).toBe(0);
	expect(owner.capture().snapshot.bytes).toEqual(new Uint8Array([9]));
	expect(owner.capture().tail).toEqual([]);
});

for (const kind of ['snapshot', 'entry'] as const) {
	test(`activation inside ${kind} delivery stops remaining chunks and a queued push`, async () => {
		const large = new Uint8Array(CHUNK_BYTES * 2 + 1).fill(4);
		const { owner } = setup(kind === 'snapshot' ? large : new Uint8Array([1]));
		if (kind === 'entry') expectOk(owner.bind(1).append(large));
		const prepared = await replacement(owner);
		const hub = expectOk(owner.createHub(1));
		const { connection, frames } = peer(kind === 'entry' ? 1 : 0, (frame) => {
			if (frame.kind !== kind) return;
			hub.receive(connection, push(11));
			expect(prepared.activate().status).toBe('activated');
		});
		expect(hub.join(connection)).toBe('retired');
		expect(frames).toHaveLength(1);
		expect(connection.cursor).toBe(kind === 'entry' ? 1 : 0);
		expect(owner.capture().head).toBe(1);
		expect(owner.capture().tail).toEqual([]);
	});
}

test('a separately reopened authority fences outbound bytes in a retained hub', async () => {
	const { owner, sqlite } = setup(new Uint8Array(CHUNK_BYTES + 1).fill(3));
	const reopened = openCurrentAuthority({ sqlite });
	const prepared = await replacement(reopened);
	const hub = expectOk(owner.createHub(1));
	const { connection, frames } = peer(0, () => {
		expect(prepared.activate().status).toBe('activated');
	});
	expect(hub.join(connection)).toBe('retired');
	expect(frames).toHaveLength(1);
	expect(hub.attached()).toBe(0);
});

test('a synchronous acknowledgement callback cannot carry old queued work forward', async () => {
	const { owner } = setup();
	const hub = expectOk(owner.createHub(1));
	// The incoming push advances the capture head from one to two.
	const prepared = await owner.prepareActivation({
		operation: 'restore',
		expected: { generation: 1, head: 2 },
		bytes: new Uint8Array([9]),
	});
	const { connection, frames } = peer(1, (frame) => {
		if (frame.kind !== 'ack') return;
		hub.receive(connection, push(2));
		expect(prepared.activate().status).toBe('activated');
	});
	expect(hub.join(connection)).toBe('admitted');
	hub.receive(connection, push(1));
	expect(frames.filter((frame) => frame.kind === 'ack')).toHaveLength(1);
	expect(owner.capture().head).toBe(1);
	expect(owner.capture().snapshot.bytes).toEqual(new Uint8Array([9]));
});

test('a historical receipt retry leaves the replacement hub admitted', async () => {
	const { owner } = setup();
	const prepared = await replacement(owner);
	const receipt = prepared.activate();
	const hub = expectOk(owner.createHub(2));
	const { connection, frames } = peer();
	expect(hub.join(connection)).toBe('admitted');
	expect(prepared.activate()).toEqual(receipt);
	hub.receive(connection, push(1));
	expect(hub.attached()).toBe(1);
	expect(frames.at(-1)?.kind).toBe('ack');
	expect(owner.capture().head).toBe(2);
});

test('a failed activation retains the admitted hub and its partial submission', async () => {
	const { owner, sqlite } = setup();
	const hub = expectOk(owner.createHub(1));
	const { connection, frames } = peer(1);
	expect(hub.join(connection)).toBe('admitted');
	hub.receive(connection, push(1, 0, 2));
	const prepared = await replacement(owner);
	sqlite.run(`CREATE TRIGGER fail_receipt BEFORE INSERT ON _restore_receipts
		BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`);
	expect(() => prepared.activate()).toThrow('receipt failed');
	hub.receive(connection, push(1, 1, 2));
	expect(frames.at(-1)?.kind).toBe('ack');
	expect(hub.attached()).toBe(1);
	expect(owner.capture().generation).toBe(1);
	expect(owner.capture().head).toBe(2);
});

test('activation inside a refusal callback discards synchronous queued work', async () => {
	const { owner, sqlite } = setup();
	const prepared = await replacement(owner);
	const hub = expectOk(owner.createHub(1));
	const { connection, frames } = peer(1, (frame) => {
		if (frame.kind !== 'refuse') return;
		hub.receive(connection, push(2));
		expect(prepared.activate().status).toBe('activated');
	});
	expect(hub.join(connection)).toBe('admitted');
	sqlite.run(`CREATE TRIGGER fail_append BEFORE INSERT ON _log
		BEGIN SELECT RAISE(ABORT, 'append failed'); END`);
	hub.receive(connection, push(1));
	expect(frames.map((frame) => frame.kind)).toEqual(['refuse']);
	expect(hub.attached()).toBe(0);
	expect(owner.capture().head).toBe(1);
	expect(owner.capture().snapshot.bytes).toEqual(new Uint8Array([9]));
});

test('a future-generation creation fails and later callers share the current relay', async () => {
	const { owner } = setup();
	expect(expectErr(owner.createHub(2)).name).toBe('GenerationUnavailable');
	expect((await replacement(owner)).activate().status).toBe('activated');
	const first = expectOk(owner.createHub(2));
	const second = expectOk(owner.createHub(2));
	expect(first).toBe(second);
	const sender = peer(1);
	const receiver = peer(1);
	expect(first.join(sender.connection)).toBe('admitted');
	expect(second.join(receiver.connection)).toBe('admitted');
	first.receive(sender.connection, push(1));
	expect(receiver.frames.at(-1)?.kind).toBe('entry');
});

test('failed hub creation exposes no lifetime and retry preserves one relay', () => {
	const { sqlite } = setup();
	let failing = false;
	const owner = openCurrentAuthority({
		sqlite: {
			...sqlite,
			transaction(run) {
				if (failing) throw new Error('temporarily unavailable');
				return sqlite.transaction(run);
			},
		},
	});
	failing = true;
	expect(expectErr(owner.createHub(1)).name).toBe('StorageFailed');
	failing = false;
	const hub = expectOk(owner.createHub(1));
	expect(expectOk(owner.createHub(1))).toBe(hub);
	const sender = peer(1);
	const receiver = peer(1);
	expect(hub.join(sender.connection)).toBe('admitted');
	expect(expectOk(owner.createHub(1)).join(receiver.connection)).toBe(
		'admitted',
	);
	hub.receive(sender.connection, push(1));
	expect(receiver.frames.at(-1)?.kind).toBe('entry');
});

test('admission precedes data and retirement notifies idle connections once', async () => {
	const { owner } = setup();
	const hub = expectOk(owner.createHub(1));
	const frames: Frame[] = [];
	const connection = {
		cursor: 0,
		send(bytes: Uint8Array) {
			frames.push(expectOk(decodeFrame(bytes)));
		},
	};
	expect(hub.join(connection)).toBe('admitted');
	expect(frames.map((frame) => frame.kind)).toEqual(['admitted', 'snapshot']);
	expect((await replacement(owner)).activate().status).toBe('activated');
	hub.retire();
	expect(frames.map((frame) => frame.kind)).toEqual([
		'admitted',
		'snapshot',
		'retired',
	]);
	const late: Frame[] = [];
	expect(
		hub.join({
			cursor: 0,
			send(bytes) {
				late.push(expectOk(decodeFrame(bytes)));
			},
		}),
	).toBe('retired');
	expect(late).toEqual([{ kind: 'retired' }]);
});

test('activation inside admission sends retirement without a snapshot', async () => {
	const { owner } = setup();
	const prepared = await replacement(owner);
	const hub = expectOk(owner.createHub(1));
	const frames: Frame[] = [];
	const connection = {
		cursor: 0,
		send(bytes: Uint8Array) {
			const frame = expectOk(decodeFrame(bytes));
			frames.push(frame);
			if (frame.kind === 'admitted')
				expect(prepared.activate().status).toBe('activated');
		},
	};
	expect(hub.join(connection)).toBe('retired');
	expect(frames).toEqual([{ kind: 'admitted' }, { kind: 'retired' }]);
	expect(connection.cursor).toBe(0);
});

test('a failed retirement notification cannot roll back activation or skip other sockets', async () => {
	const { owner } = setup();
	const hub = expectOk(owner.createHub(1));
	const notified: Frame[] = [];
	expect(
		hub.join({
			cursor: 1,
			send(bytes) {
				if (expectOk(decodeFrame(bytes)).kind === 'retired')
					throw new Error('socket closed');
			},
		}),
	).toBe('admitted');
	expect(
		hub.join({
			cursor: 1,
			send(bytes) {
				notified.push(expectOk(decodeFrame(bytes)));
			},
		}),
	).toBe('admitted');
	expect((await replacement(owner)).activate().status).toBe('activated');
	expect(notified.at(-1)).toEqual({ kind: 'retired' });
	expect(owner.capture().generation).toBe(2);
	expect(hub.attached()).toBe(0);
});
