/**
 * Shared Record Blob Conformance Cases
 *
 * Verifies the watermark and raw-file lifecycle through an adapter-owned blob
 * store. Bindings provide only semantic operations plus a physical file count
 * so the same cases can run across browser engines and future owners.
 *
 * Key behaviors:
 * - Reopen retains owed bytes and publication metadata
 * - Acceptance removes the address from the derived owed scan
 * - Tombstone reaps the document, blob membership, and record-owned raw file
 */
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import type { BlobAcceptance } from '../../blob-v1/index.js';
import type { RecordAddress } from '../../protocol/v1/index.js';
import type { BlobInspection, DocumentInspection } from '../replica/index.js';
import type { MaybePromise } from './replica-cases.test-support.js';

export type BlobConformanceReplica = {
	capture(address: RecordAddress, text: string): MaybePromise<string>;
	inspectBlob(address: RecordAddress): MaybePromise<BlobInspection>;
	publication(
		address: RecordAddress,
	): MaybePromise<{ digest: string; text: string } | null>;
	settle(
		address: RecordAddress,
		acceptance: BlobAcceptance,
	): MaybePromise<void>;
	owedBlobs(limit: number): MaybePromise<RecordAddress[]>;
	appendDocument(
		address: RecordAddress,
		update: Uint8Array,
	): MaybePromise<void>;
	inspectDocument(
		address: RecordAddress,
	): MaybePromise<DocumentInspection | null>;
	tombstone(address: RecordAddress): MaybePromise<void>;
	sweepDebris(): MaybePromise<void>;
	contentFileCount(): MaybePromise<number>;
	reopen(): MaybePromise<BlobConformanceReplica>;
	dispose(): MaybePromise<void>;
};

export type BlobConformanceBinding = {
	name: string;
	create(): MaybePromise<BlobConformanceReplica>;
};

const ADDRESS: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

function documentUpdate(value: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	let update: Uint8Array | undefined;
	document.on('updateV2', (next: Uint8Array) => {
		update = new Uint8Array(next);
	});
	document.get('content').insert(0, value);
	document.destroy();
	if (update === undefined) throw new Error('document update was not emitted');
	return update;
}

/** Run blob watermark and physical ownership cases against one replica owner. */
export function runBlobConformanceCases(binding: BlobConformanceBinding): void {
	describe(`blob foundation: ${binding.name}`, () => {
		test('close and reopen retain the owed digest and immutable bytes', async () => {
			let replica = await binding.create();
			try {
				const digest = await replica.capture(ADDRESS, 'durable bytes');
				expect(await replica.inspectBlob(ADDRESS)).toEqual({
					kind: 'owed',
					digest,
				});
				expect(await replica.owedBlobs(16)).toEqual([ADDRESS]);
				replica = await replica.reopen();
				expect(await replica.publication(ADDRESS)).toEqual({
					digest,
					text: 'durable bytes',
				});
				expect(await replica.contentFileCount()).toBe(1);
			} finally {
				await replica.dispose();
			}
		});

		test('matching acceptance removes the record from records_blob_owed', async () => {
			const replica = await binding.create();
			try {
				const digest = await replica.capture(ADDRESS, 'accepted bytes');
				const publication = await replica.publication(ADDRESS);
				if (publication === null)
					throw new Error('blob publication is missing');
				await replica.settle(ADDRESS, {
					kind: 'accepted',
					receipt: {
						authorityLifetime: 'lifetime-one',
						address: ADDRESS,
						protocolVersion: 'epicenter-blob-v1',
						digest,
					},
				});
				expect(await replica.inspectBlob(ADDRESS)).toEqual({
					kind: 'accepted',
					digest,
				});
				expect(await replica.owedBlobs(16)).toEqual([]);
			} finally {
				await replica.dispose();
			}
		});

		test('terminal tombstone reaps document state and the record-owned blob', async () => {
			const replica = await binding.create();
			try {
				await replica.capture(ADDRESS, 'reaped bytes');
				await replica.appendDocument(
					ADDRESS,
					documentUpdate('reaped document'),
				);
				expect(await replica.inspectDocument(ADDRESS)).not.toBeNull();
				expect(await replica.contentFileCount()).toBe(1);

				await replica.tombstone(ADDRESS);
				await replica.sweepDebris();
				expect(await replica.inspectDocument(ADDRESS)).toBeNull();
				expect(await replica.inspectBlob(ADDRESS)).toEqual({ kind: 'absent' });
				expect(await replica.owedBlobs(16)).toEqual([]);
				expect(await replica.contentFileCount()).toBe(0);
			} finally {
				await replica.dispose();
			}
		});
	});
}
