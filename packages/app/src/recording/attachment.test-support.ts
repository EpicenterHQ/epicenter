import { afterEach } from 'bun:test';
import { type BlobId, type BlobStore, BlobStoreError } from '@epicenter/blobs';
import type { BlobDestination } from '@epicenter/blobs/native';
import { defineData, defineTable, field } from '@epicenter/data/definition';
import { createMemoryRecord } from '@epicenter/data/memory';
import { openAccountStore } from '@epicenter/data/store';
import { Ok } from 'wellcrafted/result';

const definition = defineData({
	id: 'so.epicenter.recording-test',
	kv: {},
	tables: {
		recordings: defineTable({ audio: field.attachment() }),
	},
});
const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
	for (const close of cleanups) await close();
	cleanups.clear();
});

export async function createRecordingAttachment({
	appId,
	replica,
	local,
}: BlobDestination & { local?: BlobStore }) {
	const bytes = new Map<BlobId, Blob>();
	const memory: BlobStore = {
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
			return Promise.all(ids.map((id) => memory.stat(id)));
		},
		async copy(from, into) {
			const source = await memory.get(from);
			return source.error ? source : memory.put(into, source.data);
		},
		async delete(id) {
			bytes.delete(id);
			return Ok(undefined);
		},
	};
	const blobStore = local ?? memory;
	const record = createMemoryRecord();
	const data = await openAccountStore({
		definition,
		sqlite: record.sqlite,
		blobStore,
		attachmentDestination: structuredClone({ appId, replica }),
		dispose: () => record.close(),
	});
	cleanups.add(async () => {
		await data[Symbol.asyncDispose]();
	});
	const table = data.tables.recordings;
	return { data, table, blobStore };
}
