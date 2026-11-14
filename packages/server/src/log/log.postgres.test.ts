/**
 * A folder's log on a disposable Postgres cluster (ADR-0824, ADR-0826):
 * every migration in `apps/api/drizzle` applied, then appends, reads,
 * bytes, marks, and retention driven through the module's own functions.
 * Requires initdb and pg_ctl on PATH; never connects to a configured
 * database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createDb, type Db } from '../db/create-db.js';
import { newFolderId } from '../folders.js';
import {
	type DisposablePostgres,
	startDisposablePostgres,
} from '../test-helpers/disposable-postgres.js';
import { appendChange, type ChangeWrite } from './append.js';
import {
	PENDING_FOR_MS,
	purgeBlobs,
	putBlob,
	sweepPendingBlobs,
} from './blobs.js';
import { listMarks, seqOfMark, setMark } from './marks.js';
import { createMemoryBlobStore } from './memory-blob-store.js';
import {
	blobsOf,
	changesSince,
	filesAt,
	folderHeads,
	folderTitles,
	missingVersions,
	readLog,
	seqAtTime,
} from './read.js';
import { INLINE_MAX, sha256Hex, writeCursor } from './versions.js';

let cluster: DisposablePostgres;
let pool: Pool;
let db: Db;
const store = createMemoryBlobStore();

beforeAll(async () => {
	cluster = await startDisposablePostgres();
	await migrate(createDb(cluster.clients[0]), {
		migrationsFolder: fileURLToPath(
			new URL('../../../../apps/api/drizzle/', import.meta.url),
		),
	});
	pool = new Pool({
		host: '127.0.0.1',
		port: cluster.port,
		user: 'postgres',
		database: 'postgres',
		max: 12,
	});
	db = createDb(pool);
	await pool.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ('ada', 'Ada Lovelace', 'ada@example.test', true, now(), now())`,
	);
}, 60_000);

afterAll(async () => {
	await pool?.end();
	await cluster?.stop();
});

const text = (value: string) => new TextEncoder().encode(value);
const stream = (bytes: Uint8Array) =>
	new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();

/** A new folder, held by Ada. */
async function folder() {
	const id = newFolderId();
	await pool.query('insert into folder (id) values ($1)', [id]);
	await pool.query(
		`insert into folder_member (folder_id, account_id, role) values ($1, 'ada', 'member')`,
		[id],
	);
	return id;
}

const append = (id: string, files: ChangeWrite[]) =>
	appendChange(db, { folder: id, account: 'ada', via: 'so.epicenter', files });

/** What `path` holds now, or null. */
async function versionAt(id: string, path: string) {
	const listed = await filesAt(db, id, { paths: [path] });
	return listed?.files[0]?.version ?? null;
}

/** Write `files` (path to text, null to delete) over whatever each path holds. */
async function write(id: string, files: Record<string, string | null>) {
	const writes: ChangeWrite[] = [];
	for (const [path, value] of Object.entries(files)) {
		const expect = await versionAt(id, path);
		writes.push(
			value === null
				? { path, expect, delete: true }
				: { path, expect, bytes: text(value) },
		);
	}
	const landed = await append(id, writes);
	if (!('landed' in landed)) throw new Error(JSON.stringify(landed));
	return landed;
}

describe('an appended change', () => {
	test('lands every path at once, numbered densely, and answers each version', async () => {
		const id = await folder();
		const first = await write(id, { 'a.md': 'one', 'b/c.md': 'two' });
		expect(first.cursor.seq).toBe(1);
		expect(first.versions).toEqual({
			'a.md': await sha256Hex(text('one')),
			'b/c.md': await sha256Hex(text('two')),
		});
		const second = await write(id, { 'a.md': 'three', 'b/c.md': null });
		expect(second.cursor.seq).toBe(2);
		expect(second.versions['b/c.md']).toBeNull();
		const listed = await filesAt(db, id);
		expect(listed?.files.map(({ path }) => path)).toEqual(['a.md']);
		const [file] = (await filesAt(db, id, { bytes: true }))?.files ?? [];
		expect(Buffer.from(file?.base64 ?? '', 'base64').toString()).toBe('three');
	});

	test('refuses with every path that moved, and lands nothing', async () => {
		const id = await folder();
		await write(id, { 'a.md': 'one', 'b.md': 'two' });
		const stale = await append(id, [
			{ path: 'a.md', expect: null, bytes: text('x') },
			{ path: 'b.md', expect: await sha256Hex(text('old')), bytes: text('y') },
			{ path: 'c.md', expect: null, bytes: text('z') },
		]);
		expect(stale).toEqual({
			moved: [
				{ path: 'a.md', now: await sha256Hex(text('one')) },
				{ path: 'b.md', now: await sha256Hex(text('two')) },
			],
		});
		expect((await filesAt(db, id))?.seq).toBe(1);
	});

	test('writing what a path holds, or deleting nothing, makes no change', async () => {
		const id = await folder();
		await write(id, { 'a.md': 'one' });
		const again = await append(id, [
			{
				path: 'a.md',
				expect: await sha256Hex(text('one')),
				bytes: text('one'),
			},
			{ path: 'gone.md', expect: null, delete: true },
		]);
		expect('landed' in again && again.cursor.seq).toBe(1);
	});

	test('names a version the folder holds, so a restore moves no bytes; one it lacks is missing', async () => {
		const id = await folder();
		const big = new Uint8Array(INLINE_MAX + 10).fill(7);
		const version = await sha256Hex(big);
		expect(
			await append(id, [{ path: 'take.webm', expect: null, version }]),
		).toEqual({ missing: [version] });
		expect(await missingVersions(db, id, [version])).toEqual([version]);
		const put = await putBlob({
			db,
			store,
			folder: id,
			sha256: version,
			body: stream(big),
			length: big.byteLength,
		});
		expect(put).toEqual({ status: 201, size: big.byteLength });
		expect(await missingVersions(db, id, [version])).toEqual([]);
		await append(id, [{ path: 'take.webm', expect: null, version }]);
		const oldNote = (await write(id, { 'a.md': 'old' })).versions['a.md'];
		await write(id, { 'a.md': 'new' });
		// The restore names the old version: no bytes travel.
		const restored = await append(id, [
			{
				path: 'a.md',
				expect: await sha256Hex(text('new')),
				version: oldNote as string,
			},
		]);
		expect('landed' in restored && restored.versions['a.md']).toBe(oldNote);
		expect(await blobsOf(db, id, [version, oldNote as string])).toEqual([
			{ size: big.byteLength },
			{ base64: Buffer.from('old').toString('base64') },
		]);
	});

	test('refuses a name differing only in case, a file where a folder is, and a file below a file', async () => {
		const id = await folder();
		await write(id, { 'Notes/Todo.md': 'x', 'a.md': 'y' });
		const refused = async (path: string) => {
			const answer = await append(id, [
				{ path, expect: null, bytes: text('z') },
			]);
			return 'refused' in answer ? answer.refused : answer;
		};
		expect(await refused('Notes/todo.md')).toEqual({
			path: 'Notes/todo.md',
			held: 'Notes/Todo.md',
			reason: 'case',
		});
		expect(await refused('notes/other.md')).toEqual({
			path: 'notes',
			held: 'Notes',
			reason: 'case',
		});
		expect(await refused('Notes')).toEqual({
			path: 'Notes',
			held: 'Notes/Todo.md',
			reason: 'folder',
		});
		expect(await refused('a.md/b.md')).toEqual({
			path: 'a.md',
			held: 'a.md',
			reason: 'file',
		});
		expect(await refused('A.MD')).toEqual({
			path: 'A.MD',
			held: 'a.md',
			reason: 'case',
		});
		expect((await filesAt(db, id))?.seq).toBe(1);
		// A case-only rename in one change is no clash.
		const renamed = await append(id, [
			{ path: 'a.md', expect: await sha256Hex(text('y')), delete: true },
			{ path: 'A.md', expect: null, bytes: text('y') },
		]);
		expect('landed' in renamed).toBe(true);
	});

	test('keeps an imported author, time, and message only while the folder imports', async () => {
		const id = await folder();
		const imported = {
			author: 'Grace Hopper <grace@example.test>',
			at: new Date('2020-01-02T03:04:05Z'),
			message: 'First draft\n\nWith a body.',
		};
		const files: ChangeWrite[] = [
			{ path: 'a.md', expect: null, bytes: text('one') },
		];
		expect(
			await appendChange(db, {
				folder: id,
				account: 'ada',
				via: 'so.epicenter.cli',
				files,
				imported,
			}),
		).toEqual({ error: 'not_importing' });
		await pool.query('update folder set importing = true where id = $1', [id]);
		await appendChange(db, {
			folder: id,
			account: 'ada',
			via: 'so.epicenter.cli',
			files,
			imported,
		});
		const [change] = await readLog(db, id, {});
		expect(change).toMatchObject({
			seq: 1,
			at: '2020-01-02T03:04:05.000Z',
			author: 'Grace Hopper <grace@example.test>',
			message: 'First draft\n\nWith a body.',
		});
	});

	test('chains each digest over the previous one and the canonical change', async () => {
		const id = await folder();
		await write(id, { 'a.md': 'one', 'z.md': 'two' });
		await write(id, { 'a.md': null });
		const log = (await readLog(db, id, { after: 0 })).map((change) => change);
		let previous = '';
		for (const change of log) {
			const canonical = [
				'epicenter change v1',
				`folder ${id}`,
				`seq ${change.seq}`,
				`at ${new Date(change.at).getTime()}`,
				'account ada',
				`author ${JSON.stringify(change.author)}`,
				`via ${JSON.stringify(change.via)}`,
				`message ${JSON.stringify(change.message)}`,
				...change.files.map(
					(file) =>
						`file ${JSON.stringify(file.path)} ${file.version ?? '-'} ${file.size ?? '-'}`,
				),
			]
				.map((line) => `${line}\n`)
				.join('');
			const digest = await sha256Hex(text(previous + canonical));
			expect(change.digest).toBe(digest);
			previous = digest;
		}
		expect(log[0]?.author).toBe('Ada Lovelace <ada@example.test>');
	});
});

describe('the change feed', () => {
	test('answers each changed path with its version, and "compare every path" past a gap or another epoch', async () => {
		const id = await folder();
		const first = await write(id, { 'a.md': 'one', 'b.md': 'two' });
		await write(id, { 'a.md': 'three' });
		await write(id, { 'b.md': null });
		const since = await changesSince(db, id, writeCursor(first.cursor));
		expect(since?.changes).toEqual([
			{ path: 'a.md', version: await sha256Hex(text('three')) },
			{ path: 'b.md', version: null },
		]);
		expect(since?.cursor.seq).toBe(3);
		expect(
			(await changesSince(db, id, writeCursor(first.cursor), 1))?.changes,
		).toBeNull();
		expect((await changesSince(db, id, undefined))?.changes).toBeNull();
		expect((await changesSince(db, id, 'elsewhere.1'))?.changes).toBeNull();
		expect(
			(await changesSince(db, id, `${first.cursor.epoch}.99`))?.changes,
		).toBeNull();
		expect(
			(await changesSince(db, id, writeCursor(since!.cursor)))?.changes,
		).toEqual([]);
	});

	test('two writers appending at once: every change lands, numbered densely, and a poller never skips one', async () => {
		const id = await folder();
		const writers = 8;
		const each = 15;
		const seen = new Set<string>();
		let cursor = writeCursor({
			epoch: (await filesAt(db, id))!.cursor.epoch,
			seq: 0,
		});
		let writing = true;
		const poller = (async () => {
			while (writing) {
				const asked = await changesSince(db, id, cursor);
				if (asked?.changes === null || asked === undefined)
					throw new Error('the feed lost its place');
				for (const { path } of asked.changes) seen.add(path);
				cursor = writeCursor(asked.cursor);
			}
		})();
		await Promise.all(
			Array.from({ length: writers }, async (_, writer) => {
				for (let n = 0; n < each; n++) {
					const landed = await append(id, [
						{ path: `w${writer}/${n}.md`, expect: null, bytes: text(`${n}`) },
					]);
					expect('landed' in landed).toBe(true);
				}
			}),
		);
		writing = false;
		await poller;
		const last = await changesSince(db, id, cursor);
		for (const { path } of last?.changes ?? []) seen.add(path);
		expect(seen.size).toBe(writers * each);
		const seqs = (await readLog(db, id, { after: 0, limit: 1000 })).map(
			({ seq }) => seq,
		);
		expect(seqs).toEqual(
			Array.from({ length: writers * each }, (_, index) => index + 1),
		);
	}, 60_000);

	test('two writers over one version: one lands, the other has moved', async () => {
		const id = await folder();
		await write(id, { 'a.md': 'one' });
		const expect_ = await sha256Hex(text('one'));
		const answers = await Promise.all(
			['two', 'three'].map((value) =>
				append(id, [{ path: 'a.md', expect: expect_, bytes: text(value) }]),
			),
		);
		expect(answers.filter((answer) => 'landed' in answer)).toHaveLength(1);
		expect(answers.filter((answer) => 'moved' in answer)).toHaveLength(1);
	});
});

describe('history', () => {
	test("a file's history, the folder as of a change or a time, and the log newest first", async () => {
		const id = await folder();
		await write(id, { 'a.md': 'one', 'b.md': 'x' });
		await write(id, { 'b.md': 'y' });
		await write(id, { 'a.md': 'two' });
		const history = await readLog(db, id, { path: 'a.md' });
		expect(history.map(({ seq, files }) => [seq, files])).toEqual([
			[3, [{ path: 'a.md', version: await sha256Hex(text('two')), size: 3 }]],
			[1, [{ path: 'a.md', version: await sha256Hex(text('one')), size: 3 }]],
		]);
		const then = await filesAt(db, id, { seq: 2 });
		expect(then?.files.map(({ path, version }) => [path, version])).toEqual([
			['a.md', await sha256Hex(text('one'))],
			['b.md', await sha256Hex(text('y'))],
		]);
		expect((await readLog(db, id, { limit: 2 })).map(({ seq }) => seq)).toEqual(
			[3, 2],
		);
		expect(await seqAtTime(db, id, new Date(0))).toBe(0);
		expect(await seqAtTime(db, id, new Date())).toBe(3);
	});

	test('heads and titles are one statement each', async () => {
		const id = await folder();
		await write(id, { 'epicenter.json': JSON.stringify({ title: 'Journal' }) });
		const heads = await folderHeads(db, { accountId: 'ada', app: null });
		expect(heads[id]).toMatch(/^[a-z0-9]+\.1$/);
		const big = await folder();
		const contract = text(
			JSON.stringify({ title: 'Big', pad: 'x'.repeat(INLINE_MAX) }),
		);
		const version = await sha256Hex(contract);
		await putBlob({
			db,
			store,
			folder: big,
			sha256: version,
			body: stream(contract),
			length: contract.byteLength,
		});
		await append(big, [{ path: 'epicenter.json', expect: null, version }]);
		const titles = await folderTitles(db, store, [id, big, await folder()]);
		expect([...titles.values()]).toEqual(['Journal', 'Big', null]);
	});

	test('a mark names a change, and a taken name moves only when asked', async () => {
		const id = await folder();
		expect(
			await setMark(db, { folder: id, name: 'v1', account: 'ada' }),
		).toEqual({ empty: true });
		await write(id, { 'a.md': 'one' });
		const made = await setMark(db, { folder: id, name: 'v1', account: 'ada' });
		expect('marked' in made && made.marked.seq).toBe(1);
		await write(id, { 'a.md': 'two' });
		const taken = await setMark(db, { folder: id, name: 'v1', account: 'ada' });
		expect('taken' in taken && taken.taken.seq).toBe(1);
		const moved = await setMark(db, {
			folder: id,
			name: 'v1',
			account: 'ada',
			move: true,
		});
		expect('marked' in moved && moved.marked.seq).toBe(2);
		await setMark(db, { folder: id, name: 'first', account: 'ada', seq: 1 });
		expect(
			(await listMarks(db, id)).map(({ name, seq }) => [name, seq]),
		).toEqual([
			['first', 1],
			['v1', 2],
		]);
		expect(await seqOfMark(db, id, 'first')).toBe(1);
		expect((await readLog(db, id, {}))[0]?.marks).toEqual(['v1']);
	});
});

describe('bytes', () => {
	test('the sweep deletes an upload no change named for a day, row and bytes, and nothing kept', async () => {
		const id = await folder();
		const left = new Uint8Array(INLINE_MAX + 1).fill(1);
		const kept = new Uint8Array(INLINE_MAX + 1).fill(2);
		for (const bytes of [left, kept])
			await putBlob({
				db,
				store,
				folder: id,
				sha256: await sha256Hex(bytes),
				body: stream(bytes),
				length: bytes.byteLength,
			});
		await append(id, [
			{ path: 'kept.bin', expect: null, version: await sha256Hex(kept) },
		]);
		const swept = await sweepPendingBlobs({
			db,
			store,
			now: new Date(Date.now() + PENDING_FOR_MS + 1000),
		});
		expect(swept).toBeGreaterThanOrEqual(1);
		expect(await missingVersions(db, id, [await sha256Hex(left)])).toEqual([
			await sha256Hex(left),
		]);
		expect(store.keys()).not.toContain(
			`folders/${id}/blobs/${await sha256Hex(left)}`,
		);
		expect(store.keys()).toContain(
			`folders/${id}/blobs/${await sha256Hex(kept)}`,
		);
	});

	test('a purge keeps every row and refuses what a computer may still merge against', async () => {
		const id = await folder();
		await write(id, { 'a.md': 'one' });
		await write(id, { 'a.md': 'two' });
		const one = await sha256Hex(text('one'));
		const two = await sha256Hex(text('two'));
		expect(
			await purgeBlobs({ db, store, folder: id, versions: [one, two] }),
		).toEqual({
			purged: [],
			refused: [
				{ version: one, reason: 'recent' },
				{ version: two, reason: 'current' },
			],
		});
		const later = new Date(Date.now() + 91 * 24 * 60 * 60 * 1000);
		expect(
			await purgeBlobs({ db, store, folder: id, versions: [one], now: later }),
		).toEqual({ purged: [one], refused: [] });
		expect(await blobsOf(db, id, [one])).toEqual([null]);
		const history = await readLog(db, id, { path: 'a.md' });
		expect(history.map(({ files }) => files[0]?.version)).toEqual([two, one]);
		// Bytes uploaded again are kept, since history names them.
		await putBlob({
			db,
			store,
			folder: id,
			sha256: one,
			body: stream(text('one')),
		});
		expect(await blobsOf(db, id, [one])).toEqual([
			{ base64: Buffer.from('one').toString('base64') },
		]);
	});

	test('an upload is checked against its hash and length', async () => {
		const id = await folder();
		const bytes = text('hello');
		expect(
			await putBlob({
				db,
				store,
				folder: id,
				sha256: '0'.repeat(64),
				body: stream(bytes),
			}),
		).toMatchObject({ status: 422, error: 'hash-mismatch' });
		const large = new Uint8Array(INLINE_MAX * 2).fill(3);
		expect(
			await putBlob({
				db,
				store,
				folder: id,
				sha256: '1'.repeat(64),
				body: stream(large),
			}),
		).toMatchObject({ status: 422, error: 'hash-mismatch' });
		expect(
			await putBlob({
				db,
				store: null,
				folder: id,
				sha256: await sha256Hex(large),
				body: stream(large),
				length: large.byteLength,
			}),
		).toMatchObject({ status: 503 });
	});
});
