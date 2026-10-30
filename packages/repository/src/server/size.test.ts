/**
 * The Size Limit
 *
 * One limit on what is stored: a note is at most `MAX_FILE_BYTES`, just
 * under the 2 MB a Durable Object's SQLite holds in one row. A merge whose
 * note would pass it does not happen: `main`'s note stays and the arriving
 * version lands beside it.
 *
 * Key behaviors:
 * - every row the server stores for a max-size note, its answer included, fits 2,000,000 bytes
 * - a merge past the limit lands beside the note, idempotently, and its resend gets the same answer
 * - a note past the limit is refused at the door, and waits on its writer's device
 */
import { expect, test } from 'bun:test';
import { openBunSqlite } from '../bun/sqlite.js';
import { findConflicts } from '../core/conflict.js';
import { MAX_FILE_BYTES, OVER_LIMIT } from '../core/door.js';
import { gitBlobHash } from '../core/hash.js';
import { directPush, EPOCH, writer } from '../sim/harness.js';
import type { SqlDriver } from '../sql.js';
import { createMemoryGitStore } from './memory-git.js';
import { createServer } from './server.js';

const alice = writer('alice');
const bob = writer('bob');
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const note = (body: string) => `---\ntitle: Big\n---\n${body}`;
/** A note of exactly `size` bytes whose body escapes heavily as JSON: quotes, backslashes and newlines. */
function sized(size: number, fill = 'a"\\\n') {
	const head = note('');
	let body = fill.repeat(Math.floor((size - bytes(head)) / bytes(fill)));
	body += 'x'.repeat(size - bytes(head) - bytes(body) - 1);
	return note(`${body}\n`);
}

/** The bytes of the largest row in any table of a store, as SQLite holds each value. */
function largestRow(store: SqlDriver) {
	let largest = { table: '', bytes: 0 };
	for (const { name } of store.all<{ name: string }>(
		"SELECT name FROM sqlite_schema WHERE type = 'table'",
	))
		for (const row of store.all<Record<string, unknown>>(
			`SELECT * FROM "${name}"`,
		)) {
			let size = 0;
			for (const value of Object.values(row))
				size +=
					typeof value === 'string'
						? bytes(value)
						: value instanceof Uint8Array
							? value.length
							: value === null
								? 0
								: 8;
			if (size > largest.bytes) largest = { table: name, bytes: size };
		}
	return largest;
}

function setup() {
	const store = openBunSqlite();
	const server = createServer({
		store,
		git: createMemoryGitStore(),
		clock: () => EPOCH,
	});
	return { store, server };
}

test('every row the server stores for a note of the most bytes, its writer answer included, fits 2,000,000 bytes', () => {
	const { store, server } = setup();
	const big = sized(MAX_FILE_BYTES);
	expect(bytes(big)).toBe(MAX_FILE_BYTES);
	// Escaped as JSON, the note alone would pass the row limit: the answer must not keep it.
	expect(bytes(JSON.stringify(big))).toBeGreaterThan(2_000_000);
	const push = directPush(server, 'alice', [
		{ path: 'notes/big.md', text: big },
	]);
	const answer = server.push(push, alice);
	expect(answer).toMatchObject({ kind: 'applied' });
	expect(server.read('notes/big.md')).toBe(big);
	expect(largestRow(store).bytes).toBeLessThanOrEqual(2_000_000);
	// The resend reads the note again by its version: the same answer, contents and all.
	expect(server.push(push, alice)).toEqual(answer);
});

test('a note past the limit is refused at the door, over the size limit', () => {
	const { server } = setup();
	expect(
		server.push(
			directPush(server, 'alice', [
				{ path: 'notes/big.md', text: sized(MAX_FILE_BYTES + 1) },
			]),
			alice,
		),
	).toMatchObject({
		kind: 'refused',
		code: 'inadmissible',
		reason: OVER_LIMIT,
	});
});

test('a merge that would pass the limit does not happen: main keeps its note, and the arriving version lands beside it, once', () => {
	const { server } = setup();
	const path = 'notes/big.md';
	const start = note('start\n');
	server.push(directPush(server, 'alice', [{ path, text: start }]), alice);
	const base = gitBlobHash(start);
	const half = Math.floor(MAX_FILE_BYTES / 2) + 10_000;
	const mine = note(`start\n${'a'.repeat(half)}\n`);
	const theirs = note(`start\n${'b'.repeat(half)}\n`);
	server.push(directPush(server, 'alice', [{ path, text: mine }]), alice);
	const late = directPush(server, 'bob', [{ path, text: theirs, base }]);
	const answer = server.push(late, bob);
	const beside = `notes/big (conflict ${gitBlobHash(theirs).slice(0, 7)}).md`;
	expect(answer).toMatchObject({
		kind: 'merged',
		siblings: [{ path, at: beside }],
	});
	expect(server.read(path)).toBe(mine);
	expect(server.read(beside)).toBe(theirs);
	expect(findConflicts(server.read(path) ?? '')).toEqual([]);
	// Sent again, the same answer; sent anew by another writer, the same file: equal texts are one file.
	expect(server.push(late, bob)).toEqual(answer);
	server.push(directPush(server, 'bob', [{ path, text: theirs, base }]), bob);
	expect(
		[...server.snapshot().keys()].filter((p) => p.startsWith('notes/big')),
	).toEqual([beside, path].sort());
});
