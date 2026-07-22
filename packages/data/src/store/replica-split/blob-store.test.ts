/**
 * Complete split replica blob-store tests.
 *
 * Mirrors the production blob cases against split blob membership, including
 * publication proof checks, durable parking, debris sweeps, and crash hooks.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import {
	BLOB_PUBLICATION_VERSION,
	type BlobAcceptance,
	type BlobFileStore,
	type OwnedBlobFile,
	type StagedBlob,
} from '../../blob-v1/index.js';
import { sha256HexBytes } from '../../protocol/v1/canonical.js';
import type { RecordAddress } from '../../protocol/v1/index.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import { createSplitReplicaBlobStore } from './blob-store.js';
import { openSplitReplicaStore } from './replica-store.js';

const ADDRESS: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'assets',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

const OTHER_ADDRESS: RecordAddress = {
	...ADDRESS,
	recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
};

class MemoryBlobFiles implements BlobFileStore<Uint8Array, Uint8Array> {
	readonly staging = new Map<string, Uint8Array>();
	readonly content = new Map<string, Uint8Array>();
	#nextStage = 1;

	async stage(source: Uint8Array): Promise<StagedBlob> {
		const id = `stage-${this.#nextStage}`;
		this.#nextStage += 1;
		const bytes = new Uint8Array(source);
		this.staging.set(id, bytes);
		return { id, digest: sha256HexBytes(bytes) };
	}

	async promote(staged: StagedBlob, owner: OwnedBlobFile): Promise<void> {
		const bytes = this.staging.get(staged.id);
		if (bytes === undefined) throw new Error('staged bytes are missing');
		this.content.set(this.key(owner), bytes);
		this.staging.delete(staged.id);
	}

	async open(owner: OwnedBlobFile): Promise<Uint8Array> {
		const bytes = this.content.get(this.key(owner));
		if (bytes === undefined) throw new Error('owned blob bytes are missing');
		if (sha256HexBytes(bytes) !== owner.digest) {
			throw new Error('owned blob bytes failed digest verification');
		}
		return new Uint8Array(bytes);
	}

	async sweepStaging(): Promise<void> {
		this.staging.clear();
	}

	async sweepContent(owned: readonly OwnedBlobFile[]): Promise<void> {
		const retained = new Set(owned.map((owner) => this.key(owner)));
		for (const key of this.content.keys()) {
			if (!retained.has(key)) this.content.delete(key);
		}
	}

	key(owner: OwnedBlobFile): string {
		return `${owner.ownerKey}/${owner.digest}`;
	}
}

function setup(
	files = new MemoryBlobFiles(),
	hooks: Parameters<typeof createSplitReplicaBlobStore>[2] = {},
) {
	const database = new Database(':memory:', { strict: true });
	const adapter = createBunSqliteAdapter(database);
	const replica = openSplitReplicaStore({
		database: adapter,
		limits: makeLimits(),
		initialize: {
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			authorityLifetime: 'lifetime-one',
		},
	});
	for (const address of [ADDRESS, OTHER_ADDRESS]) {
		replica.localWrite({ address, op: 'replace', value: {} });
	}
	return {
		database,
		files,
		replica,
		blobs: createSplitReplicaBlobStore(adapter, files, hooks),
	};
}

function accepted(address: RecordAddress, digest: string): BlobAcceptance {
	return {
		kind: 'accepted',
		receipt: {
			authorityLifetime: 'lifetime-one',
			address,
			protocolVersion: BLOB_PUBLICATION_VERSION,
			digest,
		},
	};
}

describe('record blob store', () => {
	test('enforces one write-once slot while keeping equal bytes independently owned', async () => {
		const context = setup();
		try {
			const first = await context.blobs.capture(
				ADDRESS,
				new TextEncoder().encode('same bytes'),
			);
			expect(
				await context.blobs.capture(
					ADDRESS,
					new TextEncoder().encode('same bytes'),
				),
			).toBe(first);
			await expect(
				context.blobs.capture(ADDRESS, new TextEncoder().encode('different')),
			).rejects.toThrow(/different bytes/);

			const second = await context.blobs.capture(
				OTHER_ADDRESS,
				new TextEncoder().encode('same bytes'),
			);
			expect(second).toBe(first);
			expect(context.files.staging.size).toBe(0);
			expect(context.files.content.size).toBe(2);
			await context.blobs.sweepDebris();
			expect(context.files.content.size).toBe(2);
		} finally {
			context.database.close();
		}
	});

	test('publishes bytes and clears an obligation only for an exact receipt', async () => {
		const context = setup();
		try {
			const bytes = new TextEncoder().encode('publication');
			const digest = await context.blobs.capture(ADDRESS, bytes);
			const publication = await context.blobs.publication(ADDRESS);
			expect(publication?.request).toEqual({
				authorityLifetime: 'lifetime-one',
				address: ADDRESS,
				protocolVersion: BLOB_PUBLICATION_VERSION,
				digest,
			});
			expect(publication?.bytes).toEqual(bytes);

			await expect(
				context.blobs.settle(ADDRESS, accepted(ADDRESS, '0'.repeat(64))),
			).rejects.toThrow(/does not match/);
			expect(context.blobs.inspect(ADDRESS).kind).toBe('pending');
			await context.blobs.settle(ADDRESS, accepted(ADDRESS, digest));
			expect(context.blobs.inspect(ADDRESS)).toEqual({
				kind: 'accepted',
				digest,
			});
			expect(await context.blobs.publication(ADDRESS)).toBeNull();
		} finally {
			context.database.close();
		}
	});

	test('parks a durable authority refusal instead of retrying it', async () => {
		const context = setup();
		try {
			const digest = await context.blobs.capture(
				ADDRESS,
				new TextEncoder().encode('local'),
			);
			await context.blobs.settle(ADDRESS, {
				kind: 'blob-conflict',
				receipt: {
					authorityLifetime: 'lifetime-one',
					address: ADDRESS,
					protocolVersion: BLOB_PUBLICATION_VERSION,
					digest,
				},
				acceptedDigest: 'f'.repeat(64),
			});
			expect(context.blobs.inspect(ADDRESS)).toEqual({
				kind: 'parked',
				digest,
				parkedCode: 'blob-conflict',
			});
			expect(await context.blobs.publication(ADDRESS)).toBeNull();
		} finally {
			context.database.close();
		}
	});

	for (const boundary of [
		'afterStage',
		'afterPromote',
		'afterMembership',
	] as const) {
		test(`recovers a crash ${boundary}`, async () => {
			const crash = new Error(`crash ${boundary}`);
			const context = setup(new MemoryBlobFiles(), {
				[boundary]: () => {
					throw crash;
				},
			});
			try {
				await expect(
					context.blobs.capture(ADDRESS, new TextEncoder().encode(boundary)),
				).rejects.toBe(crash);
				if (boundary === 'afterStage') {
					expect(context.files.staging.size).toBe(1);
					expect(context.files.content.size).toBe(0);
					expect(context.blobs.inspect(ADDRESS)).toEqual({ kind: 'absent' });
				} else if (boundary === 'afterPromote') {
					expect(context.files.staging.size).toBe(0);
					expect(context.files.content.size).toBe(1);
					expect(context.blobs.inspect(ADDRESS)).toEqual({ kind: 'absent' });
				} else {
					expect(context.files.content.size).toBe(1);
					expect(context.blobs.inspect(ADDRESS).kind).toBe('pending');
				}

				await context.blobs.reopenSweep();
				await context.blobs.reopenSweep();
				expect(context.files.staging.size).toBe(0);
				expect(context.files.content.size).toBe(
					boundary === 'afterMembership' ? 1 : 0,
				);
			} finally {
				context.database.close();
			}
		});
	}

	test('tombstone reaps membership while unset preserves it', async () => {
		const tombstone = setup();
		try {
			await tombstone.blobs.capture(ADDRESS, new TextEncoder().encode('owned'));
			tombstone.replica.localWrite({ address: ADDRESS, op: 'tombstone' });
			expect(tombstone.blobs.inspect(ADDRESS)).toEqual({ kind: 'absent' });
			await tombstone.blobs.sweepDebris();
			expect(tombstone.files.content.size).toBe(0);
		} finally {
			tombstone.database.close();
		}

		const unset = setup();
		try {
			const digest = await unset.blobs.capture(
				ADDRESS,
				new TextEncoder().encode('retained'),
			);
			unset.replica.localWrite({ address: ADDRESS, op: 'unset' });
			expect(unset.blobs.inspect(ADDRESS)).toEqual({ kind: 'pending', digest });
			await unset.blobs.sweepDebris();
			expect(unset.files.content.size).toBe(1);
		} finally {
			unset.database.close();
		}
	});

	test('a delayed sweep rechecks current ownership at the same address', async () => {
		const context = setup();
		try {
			const digest = await context.blobs.capture(
				ADDRESS,
				new TextEncoder().encode('rehydrated'),
			);
			context.replica.erase();
			context.replica.installFacts({
				request: { afterSequence: 0 },
				response: {
					authorityLifetime: 'lifetime-two',
					facts: [
						{ address: ADDRESS, sequence: 1, state: 'live', payload: {} },
					],
					hasMore: false,
				},
			});
			await context.blobs.capture(
				ADDRESS,
				new TextEncoder().encode('rehydrated'),
			);
			await context.blobs.sweepDebris();
			expect(context.files.content.size).toBe(1);
			expect(context.blobs.inspect(ADDRESS)).toEqual({
				kind: 'pending',
				digest,
			});
		} finally {
			context.database.close();
		}
	});
});
