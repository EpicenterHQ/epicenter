/**
 * Finished-file creation and local playback through independent durable stores.
 * Verifies bytes-before-row publication, immutable evidence, unknown saves,
 * restart, storage failure, and deletion/closure fences without network reads.
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BlobStore, BlobStoreError } from '@epicenter/blobs';
import { createBunBlobStore } from '@epicenter/blobs/bun';
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
import {
	createStoreOverPort,
	type DeclaredData,
	syncEngineOf,
} from './store.js';
import { captureArchive, prepareArchive } from '../artifact/archive.js';
import { encodeFrame } from '../sync/frames.js';

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
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(directory?: string, retirable = false) {
	const root = directory ?? (await mkdtemp(join(tmpdir(), 'attachment-save-')));
	if (!directory)
		cleanups.push(() => rm(root, { recursive: true, force: true }));
	const raw = new Database(join(root, 'rows.sqlite'));
	const port = createSqliteDurablePort({ sqlite: createBunSqliteAdapter(raw) });
	const blobStore: BlobStore = createBunBlobStore({
		directory: join(root, 'bytes'),
	});
	const { sink } = memorySink();
	const events = new EventTarget();
	const socket = {
		readyState: 1,
		binaryType: '',
		addEventListener: events.addEventListener.bind(events),
		send() {},
		close() {},
	} as unknown as WebSocket;
	const parts = createStoreOverPort({
		definition: expectOk(compileData(definition)),
		blobStore,
		log: createLogger('attachment-test', sink),
		async acquire() {
			return Ok({
				durable: port,
				loaded: port.load(),
				...(retirable
					? {
							replication: {
								address: {
									baseURL: 'https://example.test',
									dataId: definition.id,
									generation: 1,
								},
								transport: {
									async openWebSocket() {
										return socket;
									},
								},
							},
							async discard() {
								raw.run('DELETE FROM _updates');
							},
						}
					: {}),
			});
		},
	});
	expectOk(await parts.ready);
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await parts.close();
		raw.close();
	};
	cleanups.push(close);
	const table = (parts.view as DeclaredData<typeof definition>).tables
		.recordings;
	return {
		...parts,
		close,
		table,
		blobStore,
		root,
		port,
		retire() {
			events.dispatchEvent(
				new MessageEvent('message', {
					data: encodeFrame({ kind: 'retired' }).buffer,
				}),
			);
		},
	};
}
const audio = () => new Blob(['audio'], { type: 'audio/wav' });

test('creation publishes bytes before the row and reopens with the same private content evidence', async () => {
	const first = await setup();
	const put = first.blobStore.attachments!.put;
	first.blobStore.attachments!.put = async (...args) => {
		expect(first.table.ids()).toEqual([]);
		expect(first.port.load().updates).toHaveLength(0);
		return put(...args);
	};
	const row = expectOk(
		await first.table.create({ title: 'saved', audio: audio() }),
	);
	const evidence = attachmentEngineOf(
		first.table.attachment(row.id),
	).evidence();
	expect(evidence?.sha256).toHaveLength(64);
	expect(first.table.get(row.id)).not.toHaveProperty('!attachment');
	expect(first.store.persistence.get()).toBe('saved');
	await first.close();
	const second = await setup(first.root);
	const attachment = second.table.attachment(row.id);
	expect(attachmentEngineOf(attachment).evidence()).toEqual(evidence);
	const source = expectOk(await attachment.source());
	expect(await (await fetch(source.url)).text()).toBe('audio');
	source[Symbol.dispose]();
});

test('byte-storage failure creates no recording row', async () => {
	const current = await setup();
	current.blobStore.attachments!.put = async (id) =>
		BlobStoreError.BlobStoreFailed({ id, cause: 'disk full' });
	expect(
		expectErr(await current.table.create({ title: 'failed', audio: audio() }))
			.name,
	).toBe('Failed');
	expect(current.table.ids()).toEqual([]);
});

test('a lost local publication response retries the same address and creates one durable row', async () => {
	const current = await setup();
	const put = current.blobStore.attachments!.put;
	const addresses: string[] = [];
	current.blobStore.attachments!.put = async (...args) => {
		addresses.push(args[0]);
		const result = await put(...args);
		return addresses.length === 1 && !result.error
			? BlobStoreError.BlobStoreFailed({
					id: args[0],
					cause: 'response lost after durable publication',
				})
			: result;
	};
	const row = expectOk(
		await current.table.create({ title: 'retried', audio: audio() }),
	);
	expect(addresses).toHaveLength(2);
	expect(addresses[0]).toBe(addresses[1]);
	expect(current.table.ids()).toEqual([row.id]);
	await current.close();
	const reopened = await setup(current.root);
	expect(
		await expectOk(await reopened.table.attachment(row.id).read()).text(),
	).toBe('audio');
});

test('two lost publication responses retain immutable bytes and report an unconfirmed address without a row', async () => {
	const current = await setup();
	const put = current.blobStore.attachments!.put;
	current.blobStore.attachments!.put = async (...args) => {
		expectOk(await put(...args));
		return BlobStoreError.BlobStoreFailed({
			id: args[0],
			cause: 'response lost',
		});
	};
	const failure = expectErr(
		await current.table.create({ title: 'unknown', audio: audio() }),
	);
	expect(failure.name).toBe('SaveUnconfirmed');
	expect(current.table.ids()).toEqual([]);
	if (failure.name !== 'SaveUnconfirmed')
		throw new Error('Expected unknown publication');
	const address = attachmentEngineOf(
		current.table.attachment(failure.rowId),
	).storageId;
	expect(await expectOk(await current.blobStore.get(address)).text()).toBe(
		'audio',
	);
});

test('unknown row persistence keeps its completed row and bytes and confirms after retry', async () => {
	const current = await setup();
	const commit = current.port.commit;
	current.port.commit = () => {
		throw new Error('disk full');
	};
	const failure = expectErr(
		await current.table.create({ title: 'unconfirmed', audio: audio() }),
	);
	expect(failure.name).toBe('SaveUnconfirmed');
	if (failure.name !== 'SaveUnconfirmed')
		throw new Error('Expected unresolved save');
	expect(current.table.ids()).toEqual([failure.rowId]);
	expect(current.table.get(failure.rowId)?.audio).toBe('audio/wav');
	expect(
		await expectOk(await current.table.attachment(failure.rowId).read()).text(),
	).toBe('audio');
	current.port.commit = commit;
	await current.store.persistence.flush();
	expect(current.store.persistence.get()).toBe('saved');
	await current.close();
	const reopened = await setup(current.root);
	expect(reopened.table.ids()).toEqual([failure.rowId]);
});

test('ordinary close drains an admitted save through durable row publication', async () => {
	const current = await setup();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const put = current.blobStore.attachments!.put;
	current.blobStore.attachments!.put = async (...args) => {
		entered.resolve();
		await release.promise;
		return put(...args);
	};
	const saving = current.table.create({ title: 'closing', audio: audio() });
	await entered.promise;
	const closing = current.close();
	release.resolve();
	const row = expectOk(await saving);
	await closing;
	const reopened = await setup(current.root);
	expect(
		await expectOk(await reopened.table.attachment(row.id).read()).text(),
	).toBe('audio');
});

test('retirement during byte publication retains bytes but publishes no old-generation row', async () => {
	const current = await setup(undefined, true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const put = current.blobStore.attachments!.put;
	let address: Parameters<typeof put>[0] | undefined;
	current.blobStore.attachments!.put = async (...args) => {
		address = args[0];
		entered.resolve();
		await release.promise;
		return put(...args);
	};
	const saving = current.table.create({ title: 'retired', audio: audio() });
	await entered.promise;
	current.retire();
	release.resolve();
	expect(expectErr(await saving)).toMatchObject({
		name: 'Unavailable',
		reason: 'closed',
	});
	await current.close();
	const reopened = await setup(current.root);
	expect(reopened.table.ids()).toEqual([]);
	if (!address) throw new Error('Publication was never admitted');
	expect(
		expectOk(await reopened.blobStore.stat(address)).attachment,
	).toMatchObject({ originGeneration: 1, pendingUpload: true });
});

test('completed rows synchronize evidence but missing bytes stay unavailable and read-only', async () => {
	const first = await setup();
	const second = await setup();
	const row = expectOk(
		await first.table.create({ title: 'remote', audio: audio() }),
	);
	expectOk(
		syncEngineOf(second.store).applyRemote(
			syncEngineOf(first.store).encodeSnapshot(),
		),
	);
	const attachment = second.table.attachment(row.id);
	expect(attachmentEngineOf(attachment).evidence()).toEqual(
		attachmentEngineOf(first.table.attachment(row.id)).evidence(),
	);
	expect(attachment).not.toHaveProperty('complete');
	expect(expectErr(await attachment.read())).toMatchObject({
		name: 'Unavailable',
		reason: 'local-bytes',
	});
	expect(expectErr(await attachment.source())).toMatchObject({
		name: 'Unavailable',
		reason: 'local-bytes',
	});
});

test('structural reconstruction preserves private attachment evidence without granting local upload origin', async () => {
	const first = await setup();
	const second = await setup();
	const row = expectOk(
		await first.table.create({ title: 'restore', audio: audio() }),
	);
	const archive = expectOk(
		await captureArchive(
			{
				generation: 1,
				head: 1,
				snapshot: {
					position: 1,
					bytes: syncEngineOf(first.store).encodeSnapshot(),
				},
				tail: [],
			},
			first.blobStore,
			{ appId: 'so.epicenter.attachment-test', dataId: definition.id },
		),
	);
	const rebuilt = expectOk(await prepareArchive(archive));
	expectOk(syncEngineOf(second.store).applyRemote(rebuilt.bytes));
	const attachment = second.table.attachment(row.id);
	expect(attachmentEngineOf(attachment).evidence()).toEqual(
		attachmentEngineOf(first.table.attachment(row.id)).evidence(),
	);
	expect(expectErr(await attachment.stat())).toMatchObject({
		reason: 'local-bytes',
	});
});

test('deletion during a local read cannot publish a source or resurrect its row', async () => {
	const current = await setup();
	const row = expectOk(
		await current.table.create({ title: 'deleted', audio: audio() }),
	);
	const attachment = current.table.attachment(row.id);
	const get = current.blobStore.get;
	current.blobStore.get = async (id) => {
		const result = await get(id);
		current.table.delete(row.id);
		return result;
	};
	expect(expectErr(await attachment.source())).toMatchObject({
		name: 'Unavailable',
		reason: 'row-absent',
	});
	expect(current.table.ids()).toEqual([]);
});

test('metadata presence does not load bytes and storage failure is distinct from absence', async () => {
	const current = await setup();
	const row = expectOk(
		await current.table.create({ title: 'metadata', audio: audio() }),
	);
	current.blobStore.get = async () => {
		throw new Error('metadata must not load bytes');
	};
	const attachment = current.table.attachment(row.id);
	expect(expectOk(await attachment.stat())).toMatchObject({
		size: 5,
		contentType: 'audio/wav',
	});
	current.blobStore.stat = async (id) =>
		BlobStoreError.BlobStoreFailed({ id, cause: 'disk failed' });
	expect(expectErr(await attachment.stat()).name).toBe('Failed');
});

test('local evidence differing from the row cannot report presence or become playback', async () => {
	const current = await setup();
	const row = expectOk(
		await current.table.create({ title: 'mismatch', audio: audio() }),
	);
	const stat = current.blobStore.stat;
	current.blobStore.stat = async (id) => {
		const result = expectOk(await stat(id));
		return Ok({
			...result,
			attachment: { ...result.attachment!, sha256: '0'.repeat(64) },
		});
	};
	const attachment = current.table.attachment(row.id);
	expect(expectErr(await attachment.stat()).name).toBe('Failed');
	expect(expectErr(await attachment.read()).name).toBe('Failed');
	expect(expectErr(await attachment.source()).name).toBe('Failed');
});

test('closing releases local playback and refuses later reads and creates', async () => {
	const current = await setup();
	const row = expectOk(
		await current.table.create({ title: 'playback', audio: audio() }),
	);
	const attachment = current.table.attachment(row.id);
	const source = expectOk(await attachment.source());
	await current.close();
	await expect(fetch(source.url)).rejects.toThrow();
	expect(expectErr(await attachment.read())).toMatchObject({
		reason: 'closed',
	});
	expect(() =>
		current.table.create({ title: 'late', audio: audio() }),
	).toThrow();
});

test('creation refuses unfinished bytes and patching cannot change attachment ownership', async () => {
	const current = await setup();
	expect(() =>
		current.table.create({ title: 'unfinished', audio: null } as never),
	).toThrow('finished file');
	const row = expectOk(
		await current.table.create({ title: 'fixed', audio: audio() }),
	);
	expect(() =>
		current.table.update(row.id, { audio: 'audio/webm' } as never),
	).toThrow('cannot be patched');
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
});
