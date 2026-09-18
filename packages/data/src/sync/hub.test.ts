/**
 * Hub failure boundaries: admission requires readable catch-up, failed delivery
 * cannot acknowledge a skipped position, and snapshot maintenance never answers
 * an unrelated push submission.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectOk } from 'wellcrafted/testing';
import { AuthorityError, openSyncAuthority } from './authority.js';
import { decodeFrame, encodeFrame, type Frame } from './frames.js';
import { createSyncHub } from './hub.js';

for (const operation of ['snapshot', 'since'] as const) {
	test(`admission fails when ${operation} cannot be read`, () => {
		const authority = openSyncAuthority({
			sqlite: createBunSqliteAdapter(new Database(':memory:')),
		});
		const hub = createSyncHub({
			authority: {
				...authority,
				[operation]: () =>
					AuthorityError.StorageFailed({ cause: 'unreadable' }),
			},
		});
		const frames: Frame[] = [];
		const connection = {
			cursor: 0,
			send: (bytes: Uint8Array) => {
				const frame = expectOk(decodeFrame(bytes));
				if (frame.kind === 'admitted' || frame.kind === 'retired') return;
				frames.push(frame);
			},
		};
		expect(hub.join(connection)).toBe('unavailable');
		expect(hub.attached()).toBe(0);
		hub.receive(
			connection,
			encodeFrame({
				kind: 'push',
				submission: 1,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([1]),
			}),
		);
		expect(expectOk(authority.head())).toBe(0);
		expect(frames).toEqual([]);
	});
}

test('a failed catch-up before acknowledgement preserves the connection cursor', () => {
	const authority = openSyncAuthority({
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	let fail = false;
	const hub = createSyncHub({
		authority: {
			...authority,
			since: (...args) =>
				fail
					? AuthorityError.StorageFailed({ cause: 'unreadable' })
					: authority.since(...args),
		},
	});
	const frames: Frame[] = [];
	const connection = {
		cursor: 0,
		send: (bytes: Uint8Array) => {
			const frame = expectOk(decodeFrame(bytes));
			if (frame.kind === 'admitted' || frame.kind === 'retired') return;
			frames.push(frame);
		},
	};
	expect(hub.join(connection)).toBe('admitted');
	expectOk(authority.append(new Uint8Array([1])));
	fail = true;
	hub.receive(
		connection,
		encodeFrame({
			kind: 'push',
			submission: 1,
			chunk: 0,
			chunks: 1,
			bytes: new Uint8Array([2]),
		}),
	);
	expect(connection.cursor).toBe(0);
	expect(frames.some((frame) => frame.kind === 'ack')).toBe(false);
	expect(
		frames.some((frame) => frame.kind === 'refuse' && frame.submission === 1),
	).toBe(true);
	expect(expectOk(authority.head())).toBe(2);
	fail = false;
	hub.receive(
		connection,
		encodeFrame({
			kind: 'push',
			submission: 2,
			chunk: 0,
			chunks: 1,
			bytes: new Uint8Array([2]),
		}),
	);
	expect(connection.cursor).toBe(3);
	expect(
		frames.filter((frame) => frame.kind === 'entry').map((frame) => frame.seq),
	).toEqual([1, 2]);
	expect(frames.at(-1)).toEqual({ kind: 'ack', submission: 2, seq: 3 });
});

for (const position of [1, 0]) {
	test(`a rejected snapshot at ${position} emits no push refusal`, () => {
		const authority = openSyncAuthority({
			sqlite: createBunSqliteAdapter(new Database(':memory:')),
		});
		const hub = createSyncHub({ authority });
		const frames: Frame[] = [];
		const connection = {
			cursor: 0,
			send: (bytes: Uint8Array) => {
				const frame = expectOk(decodeFrame(bytes));
				if (frame.kind === 'admitted' || frame.kind === 'retired') return;
				frames.push(frame);
			},
		};
		expect(hub.join(connection)).toBe('admitted');
		hub.receive(
			connection,
			encodeFrame({
				kind: 'offer',
				position,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([1]),
			}),
		);
		expect(frames).toEqual([]);
		hub.receive(
			connection,
			encodeFrame({
				kind: 'push',
				submission: position,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([2]),
			}),
		);
		expect(frames).toEqual([{ kind: 'ack', submission: position, seq: 1 }]);
	});
}

for (const baseline of ['entry', 'snapshot'] as const) {
	test(`a synchronous push waits until every ${baseline} chunk has been sent`, () => {
		const authority = openSyncAuthority({
			sqlite: createBunSqliteAdapter(new Database(':memory:')),
		});
		if (baseline === 'entry') expectOk(authority.append(new Uint8Array([1])));
		else expectOk(authority.seed(new Uint8Array(2_097_153)));
		const hub = createSyncHub({ authority });
		const frames: Frame[] = [];
		let answered = false;
		const connection = {
			cursor: 0,
			send(bytes: Uint8Array) {
				const frame = expectOk(decodeFrame(bytes));
				if (frame.kind === 'admitted' || frame.kind === 'retired') return;
				frames.push(frame);
				if (answered) return;
				answered = true;
				hub.receive(
					connection,
					encodeFrame({
						kind: 'push',
						submission: 1,
						chunk: 0,
						chunks: 1,
						bytes: new Uint8Array([2]),
					}),
				);
			},
		};
		expect(hub.join(connection)).toBe('admitted');
		expect(connection.cursor).toBe(2);
		expect(frames.map((frame) => frame.kind)).toEqual(
			baseline === 'entry' ? ['entry', 'ack'] : ['snapshot', 'snapshot', 'ack'],
		);
		expect(frames.at(-1)).toEqual({ kind: 'ack', submission: 1, seq: 2 });
	});
}

test('a synchronous push from failed admission is discarded before it can append', () => {
	const authority = openSyncAuthority({
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	expectOk(authority.seed(new Uint8Array([1])));
	const hub = createSyncHub({
		authority: {
			...authority,
			since: () => AuthorityError.StorageFailed({ cause: 'unreadable tail' }),
		},
	});
	let answered = false;
	const connection = {
		cursor: 0,
		send() {
			if (answered) return;
			answered = true;
			hub.receive(
				connection,
				encodeFrame({
					kind: 'push',
					submission: 1,
					chunk: 0,
					chunks: 1,
					bytes: new Uint8Array([2]),
				}),
			);
		},
	};
	expect(hub.join(connection)).toBe('unavailable');
	expect(hub.attached()).toBe(0);
	expect(expectOk(authority.head())).toBe(1);
});

test('retiring during chunk delivery fences materialized bytes and queued replies', () => {
	const authority = openSyncAuthority({
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	expectOk(authority.seed(new Uint8Array(2 * 1024 * 1024).fill(1)));
	const hub = createSyncHub({ authority });
	const frames: Frame[] = [];
	const connection = {
		cursor: 0,
		send(bytes: Uint8Array) {
			const frame = expectOk(decodeFrame(bytes));
			if (frame.kind === 'admitted' || frame.kind === 'retired') return;
			frames.push(frame);
			hub.receive(
				connection,
				encodeFrame({
					kind: 'push',
					submission: 1,
					chunk: 0,
					chunks: 1,
					bytes: new Uint8Array([2]),
				}),
			);
			hub.retire();
		},
	};
	expect(hub.join(connection)).toBe('retired');
	expect(frames).toHaveLength(1);
	expect(connection.cursor).toBe(0);
	expect(hub.attached()).toBe(0);
	expect(expectOk(authority.head())).toBe(1);
	expect(hub.join(connection)).toBe('retired');
});

for (const partial of [false, true]) {
	test(`storage failure ${partial ? 'during' : 'before'} collection refuses the push and forgets partial bytes`, () => {
		const sqlite = createBunSqliteAdapter(new Database(':memory:'));
		let failing = false;
		const authority = openSyncAuthority({
			sqlite: {
				...sqlite,
				transaction(run) {
					if (failing) throw new Error('storage unavailable');
					return sqlite.transaction(run);
				},
			},
		});
		const hub = createSyncHub({ authority });
		const frames: Frame[] = [];
		const connection = {
			cursor: 0,
			send(bytes: Uint8Array) {
				const frame = expectOk(decodeFrame(bytes));
				if (frame.kind === 'admitted' || frame.kind === 'retired') return;
				frames.push(frame);
			},
		};
		const chunk = (index: number) =>
			encodeFrame({
				kind: 'push',
				submission: 1,
				chunk: index,
				chunks: 2,
				bytes: new Uint8Array([index + 1]),
			});
		expect(hub.join(connection)).toBe('admitted');
		if (partial) hub.receive(connection, chunk(0));
		failing = true;
		hub.receive(connection, chunk(1));
		expect(frames).toEqual([
			{
				kind: 'refuse',
				submission: 1,
				reason: 'The authority could not commit to durable storage',
			},
		]);
		failing = false;
		hub.receive(connection, chunk(1));
		expect(expectOk(authority.head())).toBe(0);
		hub.receive(connection, chunk(0));
		expect(expectOk(authority.head())).toBe(1);
		expect(frames.at(-1)).toEqual({ kind: 'ack', submission: 1, seq: 1 });
	});
}
