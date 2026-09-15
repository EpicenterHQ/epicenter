/**
 * Row-owned attachment completion and local reads.
 * Uses the real SQLite persistence controller to verify row-before-bytes ordering,
 * failure reporting, immutable completion, deletion fences, and explicit recovery.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { type BlobId, type BlobStore, BlobStoreError } from '@epicenter/blobs';
import {
	compileData,
	defineData,
	defineTable,
	field,
} from '@epicenter/data/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { attachmentEngineOf } from './attachment.js';
import { createSqliteDurablePort } from './log.js';
import { createStoreOverPort, type DeclaredData } from './store.js';

const definition = defineData({
	id: 'so.epicenter.attachment-test',
	kv: {},
	tables: {
		recordings: defineTable({
			title: field.string(),
			audio: field.attachment(),
		}),
	},
});

async function setup({
	raw = new Database(':memory:'),
	bytes = new Map<BlobId, Blob>(),
} = {}) {
	const port = createSqliteDurablePort({ sqlite: createBunSqliteAdapter(raw) });
	const blobStore: BlobStore = {
		async put(id, blob) {
			if (bytes.has(id)) return BlobStoreError.BlobAlreadyExists({ id });
			bytes.set(id, blob);
			return Ok(undefined);
		},
		async get(id) {
			const blob = bytes.get(id);
			return blob ? Ok(blob) : BlobStoreError.BlobNotFound({ id });
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
		async copy(source, into) {
			const blob = await blobStore.get(source);
			return blob.error ? blob : blobStore.put(into, blob.data);
		},
		async delete(id) {
			bytes.delete(id);
			return Ok(undefined);
		},
	};
	const { sink } = memorySink();
	const parts = createStoreOverPort({
		definition: expectOk(compileData(definition)),
		local: true,
		blobStore,
		log: createLogger('attachment-test', sink),
		async acquire() {
			return Ok({ durable: port, loaded: port.load() });
		},
	});
	expectOk(await parts.ready);
	const table = (parts.view as DeclaredData<typeof definition>).tables
		.recordings;
	const row = table.create({ title: 'recording', audio: null });
	return {
		...parts,
		table,
		row,
		attachment: table.attachment(row.id),
		blobStore,
		bytes,
		port,
		raw,
	};
}

test('completion persists the row before bytes and plays locally after close/reopen', async () => {
	const { attachment, table, row, blobStore, port, raw, bytes, close } =
		await setup();
	const originalPut = blobStore.put;
	blobStore.put = async (id, blob) => {
		expect(port.load().updates.length).toBeGreaterThan(0);
		expect(table.get(row.id)?.audio).toBeNull();
		return originalPut(id, blob);
	};
	expectOk(
		await attachment.complete(new Blob(['audio'], { type: 'audio/wav' })),
	);
	expect(table.get(row.id)?.audio).toBe('audio/wav');
	const source = expectOk(await attachment.source());
	expect(await (await fetch(source.url)).text()).toBe('audio');
	source[Symbol.dispose]();
	await close();
	const reopened = await setup({ raw, bytes });
	expect(
		await expectOk(await reopened.table.attachment(row.id).read()).text(),
	).toBe('audio');
	await reopened.close();
	raw.close();
});

test('a failed initial row flush does not write bytes or report saved audio', async () => {
	const { table, bytes, port, close, raw } = await setup();
	const commit = port.commit;
	port.commit = () => {
		throw new Error('disk full');
	};
	const row = table.create({ title: 'blocked', audio: null });
	const attachment = table.attachment(row.id);
	expect(expectErr(await attachment.complete(new Blob(['audio']))).name).toBe(
		'PersistenceBlocked',
	);
	expect(bytes.size).toBe(0);
	expect(table.get(row.id)?.audio).toBeNull();
	port.commit = commit;
	await close();
	raw.close();
});

test('a failed completion flush preserves bytes and retries only identical audio on the admitted handle', async () => {
	const { attachment, table, row, bytes, port, blobStore, close, raw } =
		await setup();
	const commit = port.commit;
	const put = blobStore.put;
	blobStore.put = async (id, blob) => {
		const result = await put(id, blob);
		port.commit = () => {
			throw new Error('disk full');
		};
		return result;
	};
	expect(
		expectErr(
			await attachment.complete(new Blob(['audio'], { type: 'audio/wav' })),
		).name,
	).toBe('PersistenceBlocked');
	expect(bytes.size).toBe(1);
	expect(table.get(row.id)?.audio).toBeNull();
	port.commit = commit;
	expect(
		expectErr(
			await attachment.complete(new Blob(['other'], { type: 'audio/wav' })),
		).name,
	).toBe('AlreadyCompleted');
	expectOk(
		await attachment.complete(new Blob(['audio'], { type: 'audio/wav' })),
	);
	expect(table.get(row.id)?.audio).toBe('audio/wav');
	await close();
	raw.close();
});

test('deleting the row during byte publication cannot resurrect it or affect another row', async () => {
	const { attachment, table, row, blobStore, close, raw } = await setup();
	const put = blobStore.put;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	blobStore.put = async (id, blob) => {
		entered.resolve();
		await release.promise;
		return put(id, blob);
	};
	const pending = attachment.complete(new Blob(['old']));
	await entered.promise;
	table.delete(row.id);
	const next = table.create({ title: 'next', audio: null });
	release.resolve();
	expect(expectErr(await pending)).toMatchObject({
		name: 'Unavailable',
		reason: 'row-absent',
	});
	expect(table.get(row.id)).toBeUndefined();
	expect(table.get(next.id)?.audio).toBeNull();
	await close();
	raw.close();
});

test('close fences a delayed completion while preserving its published bytes', async () => {
	const { attachment, blobStore, bytes, close, raw } = await setup();
	const put = blobStore.put;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	blobStore.put = async (id, blob) => {
		entered.resolve();
		await release.promise;
		return put(id, blob);
	};
	const pending = attachment.complete(new Blob(['audio']));
	await entered.promise;
	const closing = close();
	release.resolve();
	expect(expectErr(await pending)).toMatchObject({
		name: 'Unavailable',
		reason: 'closed',
	});
	await closing;
	expect(bytes.size).toBe(1);
	raw.close();
});

test('null cells do not adopt local bytes on reopen; a capture journal can explicitly finish the original row', async () => {
	const { attachment, row, bytes, blobStore, close, raw } = await setup();
	const engine = attachmentEngineOf(attachment);
	expectOk(await engine.prepare());
	expectOk(
		await blobStore.put(
			engine.storageId,
			new Blob(['staged'], { type: 'audio/wav' }),
		),
	);
	await close();
	const reopened = await setup({ raw, bytes });
	const original = reopened.table.attachment(row.id);
	expect(expectErr(await original.read())).toMatchObject({
		name: 'Unavailable',
		reason: 'incomplete',
	});
	expect(expectErr(await attachmentEngineOf(original).prepare()).name).toBe(
		'AlreadyCompleted',
	);
	expectOk(await attachmentEngineOf(original).completeFromLocal('audio/wav'));
	expectOk(await attachmentEngineOf(original).completeFromLocal('audio/wav'));
	expect(await expectOk(await original.read()).text()).toBe('staged');
	await reopened.close();
	raw.close();
});

test('missing local bytes are explicit even when the row records completion', async () => {
	const { attachment, bytes, close, raw } = await setup();
	expectOk(await attachment.complete(new Blob(['audio'])));
	bytes.clear();
	expect(expectErr(await attachment.read())).toMatchObject({
		name: 'Unavailable',
		reason: 'local-bytes',
	});
	expect(expectErr(await attachment.source())).toMatchObject({
		name: 'Unavailable',
		reason: 'local-bytes',
	});
	await close();
	raw.close();
});

test('attachment cells cannot be patched and declarations cannot give a row two attachments', async () => {
	const { table, row, close, raw } = await setup();
	expect(() => table.update(row.id, { audio: 'audio/wav' } as never)).toThrow(
		'cannot be patched',
	);
	expect(() =>
		defineData({
			id: 'so.epicenter.invalid',
			kv: {},
			tables: {
				files: defineTable({
					first: field.attachment(),
					second: field.attachment(),
				}),
			},
		}),
	).toThrow('at most one');
	expect(() =>
		defineData({
			id: 'so.epicenter.invalid-kv',
			kv: { audio: field.attachment() },
			tables: {},
		}),
	).toThrow('KV');
	await close();
	raw.close();
});

test('creating with a file uses the same completion owner and returns a durable playable row', async () => {
	const { table, store, close, raw } = await setup();
	const created = expectOk(
		await table.create({
			title: 'import',
			audio: new Blob(['imported'], { type: 'audio/wav' }),
		}),
	);
	expect(created.audio).toBe('audio/wav');
	expect(store.persistence.get()).toBe('saved');
	expect(await expectOk(await table.attachment(created.id).read()).text()).toBe(
		'imported',
	);
	await close();
	raw.close();
});

test('attachment metadata checks presence without reading audio bytes', async () => {
	const { attachment, blobStore, bytes, close, raw } = await setup();
	expectOk(
		await attachment.complete(new Blob(['audio'], { type: 'audio/wav' })),
	);
	blobStore.get = async () => {
		throw new Error('metadata must not materialize audio');
	};
	expect(expectOk(await attachment.stat())).toEqual({
		size: 5,
		contentType: 'audio/wav',
	});
	bytes.clear();
	expect(expectErr(await attachment.stat())).toMatchObject({
		name: 'Unavailable',
		reason: 'local-bytes',
	});
	await close();
	raw.close();
});

test('closing a library disposes retained local playback sources', async () => {
	const { attachment, close, raw } = await setup();
	expectOk(await attachment.complete(new Blob(['audio'])));
	const source = expectOk(await attachment.source());
	await close();
	await expect(fetch(source.url)).rejects.toThrow();
	source[Symbol.dispose]();
	raw.close();
});

test('native completion refuses missing bytes and mismatched publication metadata', async () => {
	const { attachment, blobStore, close, raw } = await setup();
	const engine = attachmentEngineOf(attachment);
	expect(expectErr(await engine.completeFromLocal('audio/wav'))).toMatchObject({
		name: 'Unavailable',
		reason: 'local-bytes',
	});
	expectOk(
		await blobStore.put(
			engine.storageId,
			new Blob(['wrong format'], { type: 'audio/webm' }),
		),
	);
	expect(expectErr(await engine.completeFromLocal('audio/wav')).name).toBe(
		'Failed',
	);
	expect(expectErr(await attachment.read())).toMatchObject({
		name: 'Unavailable',
		reason: 'incomplete',
	});
	await close();
	raw.close();
});
