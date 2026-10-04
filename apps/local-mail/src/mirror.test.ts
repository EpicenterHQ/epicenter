/**
 * The mirror primitive, proved against the things Local Mail keeps beside its
 * artifact. Books proves the same surface in its own suite; what is specific
 * here is the neighbourhood: an account directory also holds `lock.db`,
 * and the data-dir root holds `credentials.json` and `provider.json`. Reclaim
 * must be unable to name any of them, and `artifacts()` must not report them.
 *
 * The other half is the property the whole design rests on: opening never
 * destroys. A changed declaration must leave the previous SQLite database
 * readable, because Mail's rebuild is an hours-long paginated Gmail backfill and
 * the predecessor is the only complete local copy until it finishes.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineMirror } from './mirror.ts';

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-mirror-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The declaration a caller of `defineMirror` is expected to hand it. */
const DECLARATION = {
	tables: [
		{ table: 'messages', columns: ['id', 'raw'] },
		{ table: 'labels', columns: ['id', 'raw'] },
	],
};

const HEX_64 = /^[0-9a-f]{64}$/;

describe('the fingerprint', () => {
	test('is the hash of the tagged canonical serialization', () => {
		const canonical =
			'{"tables":[{"columns":["id","raw"],"table":"messages"},{"columns":["id","raw"],"table":"labels"}]}';
		const expected = createHash('sha256')
			.update(`epicenter.mirror.declaration.v1\n${canonical}`)
			.digest('hex');

		expect(defineMirror({ name: 'mail', declaration: DECLARATION }).fingerprint)
			.toBe(expected);
	});

	test('ignores object key order, so authoring order is not rebuild behavior', () => {
		const a = defineMirror({
			name: 'mail',
			declaration: { table: 'messages', columns: ['id'] },
		});
		const b = defineMirror({
			name: 'mail',
			declaration: { columns: ['id'], table: 'messages' },
		});
		expect(a.fingerprint).toBe(b.fingerprint);
	});

	test('preserves array order, because a column list is ordered', () => {
		const a = defineMirror({
			name: 'mail',
			declaration: { columns: ['id', 'raw'] },
		});
		const b = defineMirror({
			name: 'mail',
			declaration: { columns: ['raw', 'id'] },
		});
		expect(a.fingerprint).not.toBe(b.fingerprint);
	});

	test('does not include the name: two names, one shape, one fingerprint', () => {
		const mail = defineMirror({ name: 'mail', declaration: DECLARATION });
		const books = defineMirror({ name: 'books', declaration: DECLARATION });
		expect(mail.fingerprint).toBe(books.fingerprint);
		expect(mail.at('/d').path).not.toBe(books.at('/d').path);
	});

	test('rejects values it cannot canonically serialize', () => {
		const reject = (declaration: unknown) =>
			expect(() =>
				defineMirror({
					name: 'mail',
					// The whole point is that these are unreachable through the type,
					// so the runtime guard is what a test can reach.
					declaration: declaration as never,
				}),
			).toThrow();

		reject({ column: undefined });
		reject({ column: Number.NaN });
		reject({ column: Number.POSITIVE_INFINITY });
		reject({ column: new Date(0) });
		reject({ column: new Map() });
		reject({ column: () => 'id' });
		reject({ column: 1n });
	});

	test('rejects a cyclic declaration instead of hanging', () => {
		const cyclic: Record<string, unknown> = { table: 'messages' };
		cyclic.self = cyclic;
		expect(() =>
			defineMirror({ name: 'mail', declaration: cyclic as never }),
		).toThrow('cyclic');
	});
});

describe('the filename grammar', () => {
	test('names the artifact <name>.<fingerprint>.db', () => {
		const mirror = defineMirror({ name: 'mail', declaration: DECLARATION });
		expect(mirror.at('/data/you@example.com').path).toBe(
			join('/data/you@example.com', `mail.${mirror.fingerprint}.db`),
		);
		expect(mirror.fingerprint).toMatch(HEX_64);
	});

	test('refuses a name that could confuse the filename', () => {
		for (const name of ['Mail', 'mail.db', 'mail_db', 'mail-', '-mail', '']) {
			expect(() => defineMirror({ name, declaration: DECLARATION })).toThrow();
		}
		expect(() =>
			defineMirror({ name: 'local-mail', declaration: DECLARATION }),
		).not.toThrow();
	});
});

describe('opening', () => {
	test('read-only reports an absent artifact instead of conjuring one', () => {
		const tmp = tempDir();
		const site = defineMirror({ name: 'mail', declaration: DECLARATION }).at(
			join(tmp.dir, 'you@example.com'),
		);

		expect(site.openReadonly()).toBeNull();
		expect(existsSync(site.path)).toBe(false);
		expect(existsSync(join(tmp.dir, 'you@example.com'))).toBe(false);
		tmp.cleanup();
	});

	test('reopening keeps every row: nothing is dropped or migrated', () => {
		const tmp = tempDir();
		const site = defineMirror({ name: 'mail', declaration: DECLARATION }).at(
			join(tmp.dir, 'you@example.com'),
		);

		const first = site.open();
		first.run(`CREATE TABLE messages (id TEXT PRIMARY KEY);`);
		first.run(`INSERT INTO messages (id) VALUES ('m1');`);
		first.close();

		const second = site.open();
		expect(
			second.query<{ n: number }, []>(`SELECT count(*) AS n FROM messages`).get()
				?.n,
		).toBe(1);
		second.close();
		tmp.cleanup();
	});
});

describe('a changed declaration', () => {
	test('names a new artifact and leaves the predecessor intact', () => {
		const tmp = tempDir();
		const accountDir = join(tmp.dir, 'you@example.com');
		const before = defineMirror({ name: 'mail', declaration: DECLARATION });
		const after = defineMirror({
			name: 'mail',
			declaration: {
				tables: [
					{ table: 'messages', columns: ['id', 'raw', 'body_text'] },
					{ table: 'labels', columns: ['id', 'raw'] },
				],
			},
		});

		const old = before.at(accountDir).open();
		old.run(`CREATE TABLE messages (id TEXT PRIMARY KEY);`);
		old.run(`INSERT INTO messages (id) VALUES ('m1');`);
		old.close();

		const site = after.at(accountDir);
		expect(site.path).not.toBe(before.at(accountDir).path);
		// Opening the successor is what would have unlinked the predecessor under
		// the old `SCHEMA_VERSION` gate.
		const successor = site.open();
		successor.run(`CREATE TABLE messages (id TEXT PRIMARY KEY);`);
		successor.close();

		expect(existsSync(before.at(accountDir).path)).toBe(true);
		const retained = new Database(before.at(accountDir).path, {
			readonly: true,
		});
		expect(
			retained
				.query<{ n: number }, []>(`SELECT count(*) AS n FROM messages`)
				.get()?.n,
		).toBe(1);
		retained.close();

		// The successor is the one the site reads, and it starts empty: a rebuild
		// is a re-pull, never a reprojection of the predecessor's rows.
		const current = site.openReadonly();
		expect(current).not.toBeNull();
		expect(
			current
				?.query<{ n: number }, []>(`SELECT count(*) AS n FROM messages`)
				.get()?.n,
		).toBe(0);
		current?.close();
		tmp.cleanup();
	});
});

describe('artifacts()', () => {
	test('never classifies a file Local Mail owns beside the mirror', () => {
		const tmp = tempDir();
		const accountDir = join(tmp.dir, 'you@example.com');
		const mirror = defineMirror({ name: 'mail', declaration: DECLARATION });
		const site = mirror.at(accountDir);
		site.open().close();

		// The account's sync-owner lock, the pre-fingerprint filename, and the
		// credential files. None of them match `mail.<64 hex>.db`.
		writeFileSync(join(accountDir, 'lock.db'), '');
		writeFileSync(join(accountDir, 'mail.db'), '');
		writeFileSync(join(accountDir, 'credentials.json'), '{}');
		writeFileSync(join(accountDir, 'provider.json'), '{}');
		writeFileSync(join(accountDir, `mail.${'z'.repeat(64)}.db`), '');
		writeFileSync(join(accountDir, 'books.a.db'), '');

		expect(site.artifacts().map((a) => a.filename)).toEqual([
			`mail.${mirror.fingerprint}.db`,
		]);
		expect(site.artifacts()[0]?.current).toBe(true);
		tmp.cleanup();
	});

	test('is an empty site, not an error, when the directory does not exist', () => {
		const site = defineMirror({ name: 'mail', declaration: DECLARATION }).at(
			join(tmpdir(), 'local-mail-mirror-test-absent', 'you@example.com'),
		);
		expect(site.artifacts()).toEqual([]);
	});
});

describe('reclaim', () => {
	test('deletes one predecessor and its sidecars, and nothing else', () => {
		const tmp = tempDir();
		const accountDir = join(tmp.dir, 'you@example.com');
		const before = defineMirror({ name: 'mail', declaration: DECLARATION });
		const after = defineMirror({
			name: 'mail',
			declaration: { tables: [{ table: 'messages', columns: ['id'] }] },
		});

		const predecessor = before.at(accountDir).path;
		const old = before.at(accountDir).open();
		old.run(`CREATE TABLE messages (id TEXT PRIMARY KEY);`);
		old.run(`INSERT INTO messages (id) VALUES ('m1');`);
		old.close();
		// A cleanly closed WAL database checkpoints its sidecars away, so stage the
		// state that actually needs reclaiming: the pair a killed sync leaves.
		writeFileSync(`${predecessor}-wal`, '');
		writeFileSync(`${predecessor}-shm`, '');

		const site = after.at(accountDir);
		site.open().close();
		writeFileSync(join(accountDir, 'lock.db'), '');
		writeFileSync(join(accountDir, 'credentials.json'), '{}');

		site.reclaim(before.fingerprint);

		expect(existsSync(predecessor)).toBe(false);
		expect(existsSync(`${predecessor}-wal`)).toBe(false);
		expect(existsSync(`${predecessor}-shm`)).toBe(false);
		// The lock and the credentials survive, and so does the current artifact.
		expect(readdirSync(accountDir).sort()).toEqual([
			'credentials.json',
			'lock.db',
			`mail.${after.fingerprint}.db`,
		]);
		expect(existsSync(accountDir)).toBe(true);
		tmp.cleanup();
	});

	test('refuses the current fingerprint', () => {
		const mirror = defineMirror({ name: 'mail', declaration: DECLARATION });
		expect(() => mirror.at('/data/you').reclaim(mirror.fingerprint)).toThrow(
			'it is the current artifact',
		);
	});

	test('refuses anything that is not a fingerprint', () => {
		const site = defineMirror({ name: 'mail', declaration: DECLARATION }).at(
			'/data/you',
		);
		for (const argument of [
			'lock',
			'lock.db',
			'../../credentials',
			'A'.repeat(64),
			'a'.repeat(63),
			'',
		]) {
			expect(() => site.reclaim(argument)).toThrow('64 lowercase hex');
		}
	});

	test('reclaiming an artifact that is already gone is a no-op', () => {
		const tmp = tempDir();
		const site = defineMirror({ name: 'mail', declaration: DECLARATION }).at(
			join(tmp.dir, 'you@example.com'),
		);
		expect(() => site.reclaim('a'.repeat(64))).not.toThrow();
		tmp.cleanup();
	});
});
