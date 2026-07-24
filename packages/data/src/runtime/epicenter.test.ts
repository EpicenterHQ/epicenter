/**
 * Epicenter Runtime Tests
 *
 * Exercises typed Lens-bound record handles over the production replica store.
 *
 * Key behaviors:
 * - Scalar, document, blob, publication, and subscription surfaces stay typed
 * - Concurrent document handles share one live document and durable append owner
 * - Tombstone and runtime disposal revoke every affected document handle
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectErr, expectOk } from 'wellcrafted/testing';

import type { StagedBlob } from '../blob-v1/index.js';
import { defineLens, defineTable, defineValues } from '../lens/index.js';
import type { Fact, RecordAddress } from '../protocol/v1/index.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
	type ReplicaStore,
} from '../store/replica/index.js';
import { createEpicenterRuntime, type EpicenterRuntime } from './epicenter.js';
import {
	createTestCarrier,
	MemoryBlobFiles,
	TEST_LIMITS,
} from './epicenter.test-support.js';

const lens = defineLens({
	namespace: 'so.epicenter.runtime',
	title: 'Runtime',
	description: 'Runtime tests',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: {
				title: field.string(),
				body: field.string(),
			},
			optional: ['body'],
		}),
		settings: defineValues({
			title: 'Settings',
			values: {
				'editor.theme': field.string(),
				'output.note.cursor': field.boolean(),
			},
		}),
	},
});

type Fixture = {
	database: Database;
	store: ReplicaStore;
	epicenter: EpicenterRuntime<Uint8Array, Uint8Array>;
	bound: ReturnType<typeof bindLens>;
	carrier: ReturnType<typeof createTestCarrier> | null;
	files: MemoryBlobFiles;
};

function bindLens(epicenter: EpicenterRuntime<Uint8Array, Uint8Array>) {
	return epicenter.bind(lens);
}

function setup(
	files = new MemoryBlobFiles(),
	carrier: ReturnType<typeof createTestCarrier> | null = createTestCarrier(),
): Fixture {
	const database = new Database(':memory:', { strict: true });
	const adapter = createBunSqliteAdapter(database);
	const store = openReplicaStore({
		owner: null,
		database: adapter,
		limits: TEST_LIMITS,
		initialize: {
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			authorityLifetime: 'runtime-life',
		},
	});
	const blobs = createReplicaBlobStore(adapter, files);
	const epicenter = createEpicenterRuntime({
		store,
		blobs,
		carrier,
		intervalMs: 60_000,
	});
	return {
		database,
		store,
		epicenter,
		bound: bindLens(epicenter),
		carrier,
		files,
	};
}

async function close(fixture: Fixture): Promise<void> {
	await fixture.epicenter[Symbol.asyncDispose]();
	fixture.database.close();
}

function install(
	store: ReplicaStore,
	input:
		| {
				address: RecordAddress;
				state: 'live';
				payload: Extract<Fact, { state: 'live' }>['payload'];
		  }
		| { address: RecordAddress; state: 'tombstone' | 'unset' },
): void {
	const afterSequence = store.sync().afterSequence;
	store.installFacts({
		request: { authorityLifetime: 'runtime-life', afterSequence },
		response: {
			authorityLifetime: 'runtime-life',
			facts: [{ ...input, sequence: afterSequence + 1 } as Fact],
			hasMore: false,
		},
	});
}

function documentUpdate(text: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	try {
		document.get('content').insert(0, text);
		return new Uint8Array(Y.encodeStateAsUpdateV2(document));
	} finally {
		document.destroy();
	}
}

class ProgrammingTypeErrorBlobFiles extends MemoryBlobFiles {
	override async stage(_source: Uint8Array): Promise<StagedBlob> {
		throw new TypeError('adapter programming error');
	}
}

describe('record-handle runtime', () => {
	test('table create/get/update/delete, absence, validation, and pure handles', async () => {
		const fixture = setup();
		try {
			const notes = fixture.bound.notes;
			const before = notes.record('aaaaaaaaaaaaaaaaaaaaaaaa');
			expect(expectOk(await before.get())).toBeUndefined();
			expect(
				expectOk(await before.update({ title: 'no write' })),
			).toBeUndefined();

			const created = await notes.create({ title: 'first' });
			expect(created.id).toMatch(/^[a-z0-9]{24}$/);
			expect(created.body).toBeUndefined();
			const record = notes.record(created.id);
			expect(expectOk(await record.get())).toEqual(created);
			expect(expectOk(await record.update({ body: 'optional' }))).toEqual({
				...created,
				body: 'optional',
			});
			await expect(
				record.update({ unknown: true } as never),
			).rejects.toBeInstanceOf(TypeError);
			await record.delete();
			await record.delete();
			expect(expectOk(await record.get())).toBeUndefined();
			expect(expectOk(await record.update({ title: 'later' }))).toBeUndefined();
			expectErr(await record.document.open());
			expectErr(await record.blob.capture(new Uint8Array([1])));
		} finally {
			await close(fixture);
		}
	});

	test('scan and entries classify nonconforming facts without losing rows', async () => {
		const fixture = setup();
		try {
			const good = await fixture.bound.notes.create({ title: 'good' });
			const badAddress: RecordAddress = {
				namespace: lens.namespace,
				collection: 'notes',
				recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
			};
			install(fixture.store, {
				address: badAddress,
				state: 'live',
				payload: { title: 42 },
			});
			const scan = await fixture.bound.notes.scan();
			expect(scan.rows.map((row) => row.id)).toEqual([good.id]);
			expect(scan.nonconforming).toHaveLength(1);
			expect(scan.nonconforming[0]).toMatchObject({
				name: 'NonconformingRow',
				raw: { title: 42 },
				issues: [{ field: 'title', kind: 'invalid' }],
			});
			const entries = [];
			for await (const entry of fixture.bound.notes.entries())
				entries.push(entry);
			expect(entries).toHaveLength(2);
			expect(entries.filter((entry) => entry.error !== null)).toHaveLength(1);
		} finally {
			await close(fixture);
		}
	});

	test('values round-trip, dotted computed keys, and tombstone refusal', async () => {
		const fixture = setup();
		try {
			const theme = fixture.bound.settings.record('editor.theme');
			expect(expectOk(await theme.get())).toBeUndefined();
			expectOk(await theme.set('dark'));
			expect(expectOk(await theme.get())).toBe('dark');
			expectOk(await theme.unset());
			expect(expectOk(await theme.get())).toBeUndefined();
			const scope = 'note' as const;
			expectOk(
				await fixture.bound.settings.record(`output.${scope}.cursor`).set(true),
			);
			const address = {
				namespace: lens.namespace,
				collection: 'settings',
				recordKey: 'editor.theme',
			};
			fixture.store.localWrite({ address, op: 'tombstone' });
			expect(expectErr(await theme.set('light')).name).toBe('RecordNotLive');
			expect(expectErr(await theme.unset()).name).toBe('RecordNotLive');
		} finally {
			await close(fixture);
		}
	});

	test('document persists, observes, exports, reopens, and local delete revokes', async () => {
		const fixture = setup();
		try {
			const row = await fixture.bound.notes.create({ title: 'doc' });
			const record = fixture.bound.notes.record(row.id);
			const document = expectOk(await record.document.open());
			let observations = 0;
			const stop = document.observe(() => observations++);
			document.transact(() =>
				document.get('messages').setAttr('title', 'hello'),
			);
			document.transact(() => document.getText('content').insert(0, 'body'));
			expect(document.getText('content').toString()).toBe('body');
			expect(observations).toBe(2);
			expect(document.export()).toBeInstanceOf(Uint8Array);
			await document.whenDurable();
			stop();
			await document[Symbol.asyncDispose]();

			const reopened = expectOk(await record.document.open());
			expect(reopened.get('messages').attrEntries().next().value).toEqual([
				'title',
				'hello',
			]);
			await record.delete();
			expect(() => reopened.transact(() => undefined)).toThrow(
				expect.objectContaining({ name: 'RevokedDocument' }),
			);
			await reopened[Symbol.asyncDispose]();
			expectErr(await record.document.open());
		} finally {
			await close(fixture);
		}
	});

	test('concurrent document handles share one live document and one durable append', async () => {
		const fixture = setup();
		try {
			const firstRow = await fixture.bound.notes.create({ title: 'shared' });
			const firstRecord = fixture.bound.notes.record(firstRow.id);
			const first = expectOk(await firstRecord.document.open());
			const second = expectOk(await firstRecord.document.open());

			first.transact(() => first.getText('content').insert(0, 'a'));
			expect(second.getText('content').toString()).toBe('a');
			expect(second.export()).toEqual(first.export());
			expect(
				fixture.store.inspectDocument({
					namespace: lens.namespace,
					collection: 'notes',
					recordKey: firstRow.id,
				}),
			).toMatchObject({ revision: 1 });

			await first[Symbol.asyncDispose]();
			second.transact(() => second.getText('content').insert(1, 'b'));
			expect(second.getText('content').toString()).toBe('ab');
			expect(
				fixture.store.inspectDocument({
					namespace: lens.namespace,
					collection: 'notes',
					recordKey: firstRow.id,
				}),
			).toMatchObject({ revision: 2 });
			await second[Symbol.asyncDispose]();

			const address = {
				namespace: lens.namespace,
				collection: 'notes',
				recordKey: firstRow.id,
			};
			fixture.store.installAcceptedDocumentUpdate(
				address,
				documentUpdate('remote'),
			);
			const reopened = expectOk(await firstRecord.document.open());
			expect(reopened.getText('content').toString()).toContain('remote');

			const otherRow = await fixture.bound.notes.create({ title: 'other' });
			const other = expectOk(
				await fixture.bound.notes.record(otherRow.id).document.open(),
			);
			expect(other.getText('content').toString()).toBe('');
			reopened.transact(() => reopened.getText('content').insert(0, 'x'));
			expect(other.getText('content').toString()).toBe('');

			await reopened[Symbol.asyncDispose]();
			await other[Symbol.asyncDispose]();
		} finally {
			await close(fixture);
		}
	});

	test('terminal deletion revokes every concurrent document handle', async () => {
		const fixture = setup();
		try {
			const row = await fixture.bound.notes.create({ title: 'revoke all' });
			const record = fixture.bound.notes.record(row.id);
			const first = expectOk(await record.document.open());
			const second = expectOk(await record.document.open());

			await record.delete();

			for (const document of [first, second]) {
				expect(() => document.transact(() => undefined)).toThrow(
					expect.objectContaining({ name: 'RevokedDocument' }),
				);
				await document[Symbol.asyncDispose]();
			}
		} finally {
			await close(fixture);
		}
	});

	test('authority replacement revokes the old in-memory document lineage', async () => {
		const fixture = setup();
		try {
			const row = await fixture.bound.notes.create({ title: 'old' });
			const record = fixture.bound.notes.record(row.id);
			const first = expectOk(await record.document.open());
			const second = expectOk(await record.document.open());
			const oldText = first.getText('content');
			oldText.insert(0, 'old lineage');
			await Bun.sleep(50);

			fixture.carrier?.reset('runtime-life-two');
			fixture.carrier?.install({
				address: {
					namespace: lens.namespace,
					collection: 'notes',
					recordKey: row.id,
				},
				state: 'live',
				payload: { title: 'successor' },
			});
			await record.update({ title: 'trigger replacement' });
			await Bun.sleep(100);

			for (const document of [first, second]) {
				expect(() => document.transact(() => undefined)).toThrow(
					expect.objectContaining({ name: 'RevokedDocument' }),
				);
			}
			const reopened = expectOk(await record.document.open());
			expect(reopened.getText('content').toString()).toBe('');
			oldText.insert(0, 'orphaned');
			expect(reopened.getText('content').toString()).toBe('');

			await first[Symbol.asyncDispose]();
			await second[Symbol.asyncDispose]();
			await reopened[Symbol.asyncDispose]();
		} finally {
			await close(fixture);
		}
	});

	test('remote tombstone delivered by supervisor revokes documents', async () => {
		const fixture = setup();
		try {
			const row = await fixture.bound.notes.create({ title: 'remote' });
			const record = fixture.bound.notes.record(row.id);
			const document = expectOk(await record.document.open());
			const changed: string[][] = [];
			const stop = fixture.bound.notes.subscribe((ids) => changed.push(ids));
			await Bun.sleep(50);
			fixture.carrier?.install({
				address: {
					namespace: lens.namespace,
					collection: 'notes',
					recordKey: row.id,
				},
				state: 'tombstone',
			});
			// Any local write nudges the supervisor, which delivers the fact.
			await fixture.bound.settings.record('editor.theme').set('dark');
			await Bun.sleep(50);
			expect(() => document.transact(() => undefined)).toThrow(
				expect.objectContaining({ name: 'RevokedDocument' }),
			);
			expect(changed.flat()).toContain(row.id);
			stop();
			await document[Symbol.asyncDispose]();
		} finally {
			await close(fixture);
		}
	});

	test('remote unset delivered by supervisor does not revoke documents', async () => {
		// Reversible absence leaves the document chain and its handles intact;
		// only the terminal tombstone revokes (ADR-0160).
		const fixture = setup();
		try {
			const row = await fixture.bound.notes.create({ title: 'held' });
			const record = fixture.bound.notes.record(row.id);
			const first = expectOk(await record.document.open());
			const second = expectOk(await record.document.open());
			first.transact(() => first.getText('content').insert(0, 'held'));
			await Bun.sleep(50);
			fixture.carrier?.install({
				address: {
					namespace: lens.namespace,
					collection: 'notes',
					recordKey: row.id,
				},
				state: 'unset',
			});
			// Any local write nudges the supervisor, which delivers the fact.
			await fixture.bound.settings.record('editor.theme').set('dark');
			await Bun.sleep(50);
			expect(first.export()).toEqual(second.export());
			await first[Symbol.asyncDispose]();
			expect(second.getText('content').toString()).toBe('held');
			await second[Symbol.asyncDispose]();
		} finally {
			await close(fixture);
		}
	});

	test('blob capture/read and conflicting capture outcomes', async () => {
		const fixture = setup();
		try {
			const row = await fixture.bound.notes.create({ title: 'blob' });
			const record = fixture.bound.notes.record(row.id);
			expectOk(await record.blob.capture(new Uint8Array([1, 2, 3])));
			expect(await record.blob.read()).toEqual(new Uint8Array([1, 2, 3]));
			expect(
				expectErr(await record.blob.capture(new Uint8Array([4]))).name,
			).toBe('BlobAlreadyCaptured');
			const unreadable = await fixture.bound.notes.create({
				title: 'unreadable',
			});
			expect(
				expectErr(
					await fixture.bound.notes
						.record(unreadable.id)
						.blob.capture('not bytes' as never),
				).name,
			).toBe('BlobSourceRead');
			expect(fixture.files.stagingSweepCount).toBeGreaterThan(0);
			await record.delete();
			expect(
				expectErr(await record.blob.capture(new Uint8Array([1]))).name,
			).toBe('RecordNotLive');
		} finally {
			await close(fixture);
		}
	});

	test('an unrelated blob adapter TypeError remains exceptional', async () => {
		const fixture = setup(new ProgrammingTypeErrorBlobFiles());
		try {
			const row = await fixture.bound.notes.create({ title: 'adapter bug' });
			await expect(
				fixture.bound.notes
					.record(row.id)
					.blob.capture(new Uint8Array([1, 2, 3])),
			).rejects.toThrow('adapter programming error');
			expect(fixture.files.stagingSweepCount).toBe(1);
		} finally {
			await close(fixture);
		}
	});

	test('runtime disposal revokes every concurrent document handle', async () => {
		const fixture = setup();
		const row = await fixture.bound.notes.create({ title: 'dispose all' });
		const record = fixture.bound.notes.record(row.id);
		const first = expectOk(await record.document.open());
		const second = expectOk(await record.document.open());

		const disposing = fixture.epicenter[Symbol.asyncDispose]();

		for (const document of [first, second]) {
			expect(() => document.transact(() => undefined)).toThrow(
				expect.objectContaining({ name: 'RevokedDocument' }),
			);
		}
		await disposing;
		for (const document of [first, second]) {
			await document[Symbol.asyncDispose]();
		}
		fixture.database.close();
	});

	test('publication reports pending tombstones as ready and canonical blocked evidence', async () => {
		const fixture = setup();
		try {
			const row = await fixture.bound.notes.create({ title: 'blocked' });
			const record = fixture.bound.notes.record(row.id);
			await record.delete();
			expect(await record.publication.get()).toEqual({ state: 'ready' });

			const other = await fixture.bound.notes.create({ title: 'large' });
			fixture.database.run(
				`UPDATE records SET
					parked_op = pending_op,
					parked_args = pending_args,
					parked_code = 'fact-too-large',
					parked_measured = 999,
					parked_limit = 100,
					pending_op = NULL,
					pending_args = NULL
				WHERE namespace = ? AND collection = ? AND record_key = ?`,
				[lens.namespace, 'notes', other.id],
			);
			expect(
				await fixture.bound.notes.record(other.id).publication.get(),
			).toEqual({
				state: 'blocked',
				blocked: [
					{
						plane: 'scalar',
						reason: 'fact-too-large',
						measuredBytes: 999,
						limitBytes: 100,
					},
				],
			});
			expect(await fixture.epicenter.blockedRecords()).toEqual([
				{
					address: {
						namespace: lens.namespace,
						collection: 'notes',
						recordKey: other.id,
					},
					blocked: [
						{
							plane: 'scalar',
							reason: 'fact-too-large',
							measuredBytes: 999,
							limitBytes: 100,
						},
					],
				},
			]);
		} finally {
			await close(fixture);
		}
	});

	test('an absent address reports settled, never ready', async () => {
		const fixture = setup();
		try {
			const status = await fixture.bound.notes
				.record('aaaaaaaaaaaaaaaaaaaaaaaa')
				.publication.get();
			expect(status).toEqual({ state: 'settled' });
		} finally {
			await close(fixture);
		}
	});

	test('blockedRecords enumerates durable evidence a fresh process never observed', async () => {
		const fixture = setup();
		try {
			const row = await fixture.bound.notes.create({ title: 'stale' });
			fixture.database.run(
				`UPDATE records SET
					parked_op = pending_op,
					parked_args = pending_args,
					parked_code = 'patch-base-not-object',
					pending_op = NULL,
					pending_args = NULL
				WHERE namespace = ? AND collection = ? AND record_key = ?`,
				[lens.namespace, 'notes', row.id],
			);
			// A second runtime over the same database has observed nothing;
			// blocked enumeration must come from the store, not runtime memory.
			const adapter = createBunSqliteAdapter(fixture.database);
			const reopened = openReplicaStore({
				owner: null,
				database: adapter,
				limits: TEST_LIMITS,
			});
			const fresh = createEpicenterRuntime({
				store: reopened,
				blobs: createReplicaBlobStore(adapter, new MemoryBlobFiles()),
				carrier: null,
				intervalMs: 60_000,
			});
			try {
				expect(await fresh.blockedRecords()).toEqual([
					{
						address: {
							namespace: lens.namespace,
							collection: 'notes',
							recordKey: row.id,
						},
						blocked: [{ plane: 'scalar', reason: 'patch-base-not-object' }],
					},
				]);
			} finally {
				await fresh[Symbol.asyncDispose]();
			}
		} finally {
			await close(fixture);
		}
	});

	test('publication transitions ready to settled after a full drain', async () => {
		const fixture = setup();
		try {
			const row = await fixture.bound.notes.create({ title: 'publish' });
			const record = fixture.bound.notes.record(row.id);
			expect(await record.publication.get()).toEqual({ state: 'ready' });
			await Bun.sleep(10);
			expect(await record.publication.get()).toEqual({ state: 'settled' });
		} finally {
			await close(fixture);
		}
	});

	test('a carrier-less runtime is local-only and a later carrier-bearing one drains it', async () => {
		const fixture = setup(new MemoryBlobFiles(), null);
		try {
			expect(fixture.epicenter.sync.status.state).toBe('local-only');
			const row = await fixture.bound.notes.create({ title: 'parked' });
			const record = fixture.bound.notes.record(row.id);
			await Bun.sleep(10);
			expect(await record.publication.get()).toEqual({ state: 'ready' });
			expect(fixture.epicenter.sync.status.state).toBe('local-only');

			// A second runtime lifetime over the same store, opened with a
			// carrier, drains the retained work (ADR-0178: authorization is
			// fixed per lifetime, never toggled on a live runtime).
			const adapter = createBunSqliteAdapter(fixture.database);
			const resumed = createEpicenterRuntime({
				store: openReplicaStore({
					owner: null,
					database: adapter,
					limits: TEST_LIMITS,
				}),
				blobs: createReplicaBlobStore(adapter, fixture.files),
				carrier: createTestCarrier(),
				intervalMs: 60_000,
			});
			try {
				await Bun.sleep(10);
				expect(resumed.sync.status.state).toBe('idle');
				expect(
					await resumed.bind(lens).notes.record(row.id).publication.get(),
				).toEqual({ state: 'settled' });
			} finally {
				await resumed[Symbol.asyncDispose]();
			}
		} finally {
			await close(fixture);
		}
	});

	test('subscriptions notify and unsubscribe; disposal invalidates all surfaces', async () => {
		const fixture = setup();
		const notes = fixture.bound.notes;
		const values = fixture.bound.settings.record('editor.theme');
		const tableEvents: string[][] = [];
		let valueEvents = 0;
		let publicationEvents = 0;
		const stopTable = notes.subscribe((ids) => tableEvents.push(ids));
		const stopValue = values.subscribe(() => valueEvents++);
		const stopPublication = values.publication.subscribe(
			() => publicationEvents++,
		);
		const row = await notes.create({ title: 'events' });
		await notes.record(row.id).update({ body: 'changed' });
		await notes.record(row.id).delete();
		await values.set('dark');
		expect(tableEvents.flat()).toEqual([row.id, row.id, row.id]);
		expect(valueEvents).toBe(1);
		expect(publicationEvents).toBe(1);
		stopTable();
		stopValue();
		stopPublication();
		await values.set('light');
		expect(valueEvents).toBe(1);
		await fixture.epicenter[Symbol.asyncDispose]();
		expect(() => fixture.epicenter.bind(lens)).toThrow(/disposed/);
		expect(() => notes.record(row.id)).toThrow(/disposed/);
		await expect(values.get()).rejects.toThrow(/disposed/);
		fixture.database.close();
	});
});
