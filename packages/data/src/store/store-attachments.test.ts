/**
 * Owning attachment creation tests.
 *
 * The document saves bytes before accepting references, drains compensation on
 * close, and gives every copied attachment an independent deletion identity.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BlobId,
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import {
	compileData,
	defineData,
	defineTable,
	field,
	plainText,
} from '@epicenter/data/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Type } from 'typebox';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createSqliteDurablePort } from './log.js';
import { createStoreOverPort, type DeclaredData } from './store.js';

const definition = defineData({
	id: 'so.epicenter.attachments-test',
	kv: {},
	tables: {
		recordings: defineTable({
			title: field.string(),
			audio: field.blob(),
			optional: field.nullable(field.blob()),
			content: plainText(),
		}),
		optional: defineTable({
			audio: field.nullable(field.blob()),
			content: plainText(),
		}),
		reversed: defineTable({
			audio: Type.Union([Type.Null(), field.blob()]),
			content: plainText(),
		}),
	},
});

function setup(path = ':memory:', bytes = new Map<BlobId, Blob>()) {
	const raw = new Database(path);
	const port = createSqliteDurablePort({ sqlite: createBunSqliteAdapter(raw) });
	const events: string[] = [];
	const { sink, events: logs } = memorySink();
	const blobStore: BlobStore = {
		async put(id, blob) {
			if (bytes.has(id)) return BlobStoreError.BlobAlreadyExists({ id });
			bytes.set(id, blob);
			return Ok(undefined);
		},
		async get(id) {
			const blob = bytes.get(id);
			return blob === undefined
				? BlobStoreError.BlobNotFound({ id })
				: Ok(blob);
		},
		async copy(sourceId, destinationId) {
			const source = await blobStore.get(sourceId);
			if (source.error !== null) return source;
			return blobStore.put(destinationId, source.data);
		},
		async stat(id) {
			const blob = bytes.get(id);
			return blob
				? Ok({ size: blob.size, contentType: blob.type })
				: BlobStoreError.BlobNotFound({ id });
		},
		async statMany(ids) {
			return Promise.all(ids.map((id) => blobStore.stat(id)));
		},
		async delete(id) {
			events.push('delete');
			bytes.delete(id);
			return Ok(undefined);
		},
	};
	const parts = createStoreOverPort({
		definition: expectOk(compileData(definition)),
		blobStore,
		log: createLogger('attachment-test', sink),
		async acquire() {
			return Ok({
				durable: port,
				loaded: port.load(),
				dispose() {
					events.push('backing');
					raw.close();
				},
			});
		},
	});
	// The engine erases the declaration; this fixture supplies this exact literal.
	const view = parts.view as DeclaredData<typeof definition>;
	return { ...parts, view, blobStore, bytes, events, logs };
}

test('byte writes finish before a row is published and input fields are captured', async () => {
	const app = setup();
	expectOk(await app.ready);
	const pendingPut =
		Promise.withResolvers<Awaited<ReturnType<BlobStore['put']>>>();
	app.blobStore.put = async (id, blob) => {
		app.bytes.set(id, blob);
		return pendingPut.promise;
	};
	const input = {
		title: 'captured',
		audio: new Blob(['audio']),
		optional: null,
	};
	const created = app.view.tables.recordings.create(input);
	input.title = 'changed';
	expect(app.view.tables.recordings.rows).toEqual([]);
	pendingPut.resolve(Ok(undefined));
	const row = expectOk(await created);
	expect(row.title).toBe('captured');
	expect(row.optional).toBeNull();
	expect(await app.bytes.get(row.audio)?.text()).toBe('audio');
	await app.close();
});

test('an all-null attachment table remains asynchronous without writing bytes', async () => {
	const app = setup();
	expectOk(await app.ready);
	for (const table of [app.view.tables.optional, app.view.tables.reversed]) {
		const pending = table.create({ audio: null });
		expect(pending).toBeInstanceOf(Promise);
		expect(expectOk(await pending).audio).toBeNull();
	}
	expect(app.bytes.size).toBe(0);
	await app.close();
});

test('close waits for byte compensation before releasing backing and refuses row publication', async () => {
	const app = setup();
	expectOk(await app.ready);
	const started = Promise.withResolvers<void>();
	const put = Promise.withResolvers<Awaited<ReturnType<BlobStore['put']>>>();
	const remove = Promise.withResolvers<void>();
	app.blobStore.put = async (id, blob) => {
		app.bytes.set(id, blob);
		started.resolve();
		return put.promise;
	};
	app.blobStore.delete = async (id) => {
		await remove.promise;
		app.bytes.delete(id);
		app.events.push('delete');
		return Ok(undefined);
	};
	const created = app.view.tables.recordings.create({
		title: 'cancelled',
		audio: new Blob(['audio']),
		optional: null,
	});
	const outcome = Promise.allSettled([created]);
	await started.promise;
	const closing = app.close();
	put.resolve(Ok(undefined));
	await Promise.resolve();
	expect(app.events).toEqual([]);
	remove.resolve();
	expect((await outcome)[0]).toMatchObject({
		status: 'rejected',
		reason: { name: 'StoreUnusableError' },
	});
	await closing;
	expect(app.bytes.size).toBe(0);
	expect(app.events).toEqual(['delete', 'backing']);
});

test('a failed second put cleans the first bytes and preserves the original Result', async () => {
	const app = setup();
	expectOk(await app.ready);
	const failure = BlobStoreError.BlobAlreadyExists({ id: generateBlobId() });
	app.blobStore.put = async (id, blob) => {
		if (app.bytes.size !== 0) return failure;
		app.bytes.set(id, blob);
		return Ok(undefined);
	};
	const result = await app.view.tables.recordings.create({
		title: 'failed',
		audio: new Blob(['one']),
		optional: new Blob(['two']),
	});
	expect(result).toBe(failure);
	expect(app.bytes.size).toBe(0);
	expect(app.view.tables.recordings.rows).toEqual([]);
	await app.close();
});

test('failed compensation is logged without replacing the original put failure', async () => {
	const app = setup();
	expectOk(await app.ready);
	const failure = BlobStoreError.BlobAlreadyExists({ id: generateBlobId() });
	app.blobStore.put = async (id, blob) => {
		if (app.bytes.size) return failure;
		app.bytes.set(id, blob);
		return Ok(undefined);
	};
	app.blobStore.delete = async (id) =>
		BlobStoreError.BlobStoreFailed({ id, cause: 'cleanup refused' });
	expect(
		await app.view.tables.recordings.create({
			title: 'failed',
			audio: new Blob(['one']),
			optional: new Blob(['two']),
		}),
	).toBe(failure);
	expect(app.logs).toHaveLength(1);
	expect(app.logs[0]?.data).toMatchObject({
		name: 'BlobStoreFailed',
		id: [...app.bytes.keys()][0],
	});
	await app.close();
});

test('invalid copy IDs, owning patches, and transaction callbacks are refused before byte IO', async () => {
	const app = setup();
	expectOk(await app.ready);
	const table = app.view.tables.recordings;
	const input = {
		title: 'recording',
		audio: new Blob(['audio']),
		optional: null,
	};
	expect(() =>
		app.view.transact(() => {
			void table.create(input);
		}),
	).toThrow('synchronous transaction');
	// @ts-expect-error: an arbitrary string is not a copy-source BlobId.
	expect(() => table.create({ ...input, audio: 'invalid' })).toThrow(
		'requires Blob',
	);
	// @ts-expect-error: owning fields cannot be patched by ID.
	expect(() => table.update('missing', { audio: generateBlobId() })).toThrow(
		'owning blob',
	);
	expect(app.bytes.size).toBe(0);
	const row = expectOk(await table.create(input));
	expect(() => table.update(row.id, row)).toThrow('owning blob');
	expectOk(table.update(row.id, { title: 'renamed' }));
	expect(table.get(row.id)?.title).toBe('renamed');
	await app.close();
});

test('concurrent creates and fields copy one source into independent owned IDs', async () => {
	const app = setup();
	expectOk(await app.ready);
	const id = generateBlobId();
	expectOk(await app.blobStore.put(id, new Blob(['native'])));
	const rows = (
		await Promise.all(
			['first', 'second'].map((title) =>
				app.view.tables.recordings.create({ title, audio: id, optional: id }),
			),
		)
	).map((result) => expectOk(result));
	expect(
		new Set([id, ...rows.flatMap((row) => [row.audio, row.optional])]).size,
	).toBe(5);
	const [first, second] = rows;
	if (!first || !second) throw new Error('Both creates must produce rows');
	expectOk(await app.blobStore.delete(first.audio));
	app.view.tables.recordings.delete(first.id);
	expect(await expectOk(await app.blobStore.get(second.audio)).text()).toBe(
		'native',
	);
	expect(await expectOk(await app.blobStore.get(id)).text()).toBe('native');
	await app.close();
});

test('copying an owned ID after reopen cannot alias the original row', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-attachment-copy-'));
	const path = join(directory, 'rows.sqlite');
	const first = setup(path);
	try {
		expectOk(await first.ready);
		const original = expectOk(
			await first.view.tables.recordings.create({
				title: 'original',
				audio: new Blob(['saved']),
				optional: null,
			}),
		);
		await first.close();
		const reopened = setup(path, first.bytes);
		try {
			expectOk(await reopened.ready);
			expect(reopened.view.tables.recordings.get(original.id)?.audio).toBe(
				original.audio,
			);
			const copied = expectOk(
				await reopened.view.tables.recordings.create({
					title: 'copy',
					audio: original.audio,
					optional: null,
				}),
			);
			expect(copied.audio).not.toBe(original.audio);
			expectOk(await reopened.blobStore.delete(original.audio));
			reopened.view.tables.recordings.delete(original.id);
			expect(
				await expectOk(await reopened.blobStore.get(copied.audio)).text(),
			).toBe('saved');
		} finally {
			await reopened.close();
		}
	} finally {
		await first.close();
		rmSync(directory, { recursive: true });
	}
});

test('missing copy source preserves its failure and compensates only new destinations', async () => {
	const app = setup();
	expectOk(await app.ready);
	const source = generateBlobId();
	expectOk(await app.blobStore.put(source, new Blob(['source'])));
	const missing = generateBlobId();
	const result = await app.view.tables.recordings.create({
		title: 'failed',
		audio: source,
		optional: missing,
	});
	expect(expectErr(result)).toMatchObject({
		name: 'BlobNotFound',
		id: missing,
	});
	expect([...app.bytes.keys()]).toEqual([source]);
	expect(app.view.tables.recordings.rows).toEqual([]);
	await app.close();
});

test('close during copy drains destination compensation without deleting its source', async () => {
	const app = setup();
	expectOk(await app.ready);
	const source = generateBlobId();
	expectOk(await app.blobStore.put(source, new Blob(['capture'])));
	const copying = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	app.blobStore.copy = async (sourceId, destinationId) => {
		const bytes = expectOk(await app.blobStore.get(sourceId));
		expectOk(await app.blobStore.put(destinationId, bytes));
		started.resolve();
		await copying.promise;
		return Ok(undefined);
	};
	const result = Promise.allSettled([app.view.tables.recordings.create({
		title: 'closing', audio: source, optional: null,
	})]);
	await started.promise;
	const closing = app.close();
	expect(app.events).toEqual([]);
	copying.resolve();
	expect((await result)[0]).toMatchObject({status: 'rejected', reason: {name: 'StoreUnusableError'}});
	await closing;
	expect([...app.bytes.keys()]).toEqual([source]);
	expect(app.events).toEqual(['delete', 'backing']);
});

test('KV declarations refuse owning blob fields', () => {
	expect(() =>
		defineData({
			id: 'so.epicenter.invalid-blob-kv',
			kv: { audio: field.blob() },
			tables: {},
		}),
	).toThrow('belong to tables, not KV');
});

test('a subscriber closing during the accepted commit does not delete the row bytes', async () => {
	const app = setup();
	expectOk(await app.ready);
	app.view.tables.recordings.subscribe(() => {
		void app.close();
	});
	const row = expectOk(
		await app.view.tables.recordings.create({
			title: 'accepted',
			audio: new Blob(['kept']),
			optional: null,
		}),
	);
	await app.close();
	expect(await app.bytes.get(row.audio)?.text()).toBe('kept');
	expect(app.events).toEqual(['backing']);
});

test('a rejected cleanup still drains other deletions and preserves the creation exception', async () => {
	const app = setup();
	expectOk(await app.ready);
	const occupied = expectOk(
		await app.view.tables.optional.create({ audio: null }),
	);
	const deleting = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let calls = 0;
	app.blobStore.delete = async (id) => {
		calls += 1;
		if (calls === 1) throw new Error('delete threw');
		started.resolve();
		await deleting.promise;
		app.bytes.delete(id);
		app.events.push('delete');
		return Ok(undefined);
	};
	const creation = app.view.tables.recordings.create({
		title: 'refused',
		audio: new Blob(['one']),
		optional: new Blob(['two']),
		content: occupied.content,
	});
	const outcome = Promise.allSettled([creation]);
	await started.promise;
	const closing = app.close();
	expect(app.events).toEqual([]);
	deleting.resolve();
	expect((await outcome)[0]).toMatchObject({
		status: 'rejected',
		reason: { message: expect.stringContaining('already belongs') },
	});
	await closing;
	expect(app.events).toEqual(['delete', 'backing']);
	expect(app.logs).toHaveLength(1);
	expect(app.logs[0]?.data).toMatchObject({
		name: 'BlobStoreFailed',
		cause: { message: 'delete threw' },
	});
});

test('data-only engines refuse attachment creation without a byte store', async () => {
	const raw = new Database(':memory:');
	const port = createSqliteDurablePort({ sqlite: createBunSqliteAdapter(raw) });
	const parts = createStoreOverPort({
		definition: expectOk(compileData(definition)),

		acquire: async () =>
			Ok({ durable: port, loaded: port.load(), dispose: () => raw.close() }),
	});
	expectOk(await parts.ready);
	const table = parts.view.tables.recordings;
	if (table === undefined) throw new Error('The fixture declares recordings');
	expect(() =>
		table.create({
			title: 'no backing',
			audio: new Blob(['audio']),
			optional: null,
		}),
	).toThrow('no blob store');
	expect(table.rows).toEqual([]);
	await parts.close();
});
