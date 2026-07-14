/**
 * Cloudflare Records Backend Tests
 *
 * Verifies the SQLite Durable Object implementation and the portable Records
 * registry that routes authenticated partitions to deterministic object names.
 *
 * Key behaviors:
 * - The first open mints and durably preserves one records epoch
 * - Schema mismatches cannot replace the stored identity
 * - Failed first initialization can retry without a half-open object
 * - Principal and workspace pairs route to independent Durable Objects
 * - Push and pull cross the Records registry through the DO RPC contract
 * - Reviewed table changes admit atomically only at the expected head
 * - Production compaction sends stale cursors through bounded snapshots
 */

import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import {
	RECORD_SYNC_PROTOCOL_MAJOR,
	type RequestEnvelope,
} from '@epicenter/record-sync';

mock.module('cloudflare:workers', () => ({
	DurableObject: class {
		protected ctx: DurableObjectState;

		constructor(ctx: DurableObjectState, _env: Cloudflare.Env) {
			this.ctx = ctx;
		}
	},
}));

type SqlValue = ArrayBuffer | string | number | null;

function createStorage() {
	const database = new Database(':memory:', { strict: true });
	return {
		database,
		storage: {
			sql: {
				exec<TRow extends Record<string, SqlValue>>(
					sql: string,
					...bindings: SqlValue[]
				) {
					const statementCount = sql
						.split(';')
						.filter((part) => part.trim()).length;
					if (statementCount > 1) {
						database.exec(sql);
						return { toArray: () => [] as TRow[] };
					}
					const bunBindings = bindings.map((value) =>
						value instanceof ArrayBuffer ? new Uint8Array(value) : value,
					);
					const query = database.query<
						TRow,
						(string | number | null | Uint8Array)[]
					>(sql);
					const isRead = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql);
					if (isRead) {
						const rows = query.all(...bunBindings);
						return { toArray: () => rows };
					}
					query.run(...bunBindings);
					return { toArray: () => [] as TRow[] };
				},
			},
			transactionSync<TResult>(run: () => TResult): TResult {
				return database.transaction(run)();
			},
		} as unknown as DurableObjectStorage,
	};
}

async function setup() {
	const { RecordAuthorityDurableObject, createDurableObjectRecords } =
		await import('./cloudflare.js');
	const objects = new Map<
		string,
		{
			storage: ReturnType<typeof createStorage>;
			object: InstanceType<typeof RecordAuthorityDurableObject>;
		}
	>();
	const names: string[] = [];
	const namespace = {
		getByName(name: string) {
			names.push(name);
			const existing = objects.get(name);
			if (existing) return existing.object;
			const storage = createStorage();
			const object = new RecordAuthorityDurableObject(
				{ storage: storage.storage } as DurableObjectState,
				{} as Cloudflare.Env,
			);
			objects.set(name, { storage, object });
			return object;
		},
	};
	return {
		names,
		objects,
		records: createDurableObjectRecords(
			namespace as unknown as DurableObjectNamespace<
				InstanceType<typeof RecordAuthorityDurableObject>
			>,
		),
		RecordAuthorityDurableObject,
	};
}

const partition = {
	principalId: asPrincipalId('alice'),
	workspaceId: 'wiki',
};
const bindingRequest = {
	protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
	recordsDescriptor: 'schema descriptor 1',
	recordsSchemaHash: 'schema-1',
};

async function open(
	records: Awaited<ReturnType<typeof setup>>['records'],
	target = partition,
	recordsSchemaHash = 'schema-1',
): Promise<RequestEnvelope> {
	const result = await records.open(target, {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		recordsDescriptor: 'schema descriptor 1',
		recordsSchemaHash,
	});
	if (!result.ok) throw new Error(`Open refused: ${result.reason}`);
	return {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		recordsEpoch: result.recordsEpoch,
	};
}

test('records epoch and mutation log survive Durable Object restart', async () => {
	const context = await setup();
	const envelope = await open(context.records);
	expect(
		await context.records.push(partition, {
			...envelope,
			kind: 'push',
			mutations: [
				{
					actorId: 'actor-1',
					actorSequence: 1,
					operations: [
						{
							kind: 'createRow',
							table: 'pages',
							rowId: 'page-1',
							cells: { title: 'Hello' },
						},
					],
				},
			],
		}),
	).toEqual({ kind: 'push', ok: true });

	const name = context.names[0];
	if (!name) throw new Error('Expected a Durable Object name');
	const owned = context.objects.get(name);
	if (!owned) throw new Error('Expected a Durable Object instance');
	owned.object = new context.RecordAuthorityDurableObject(
		{ storage: owned.storage.storage } as DurableObjectState,
		{} as Cloudflare.Env,
	);

	const reopened = await open(context.records);
	expect(reopened.recordsEpoch).toBe(envelope.recordsEpoch);
	const pulled = await context.records.pull(partition, {
		...reopened,
		kind: 'pull',
		cursor: 0,
		limit: 100,
	});
	expect(
		pulled.ok && !pulled.snapshotRequired && pulled.mutations,
	).toHaveLength(1);
});

test('open describes the stored schema without replacing its identity', async () => {
	const { records } = await setup();
	const envelope = await open(records);
	expect(
		await records.open(partition, {
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			recordsDescriptor: 'different descriptor',
			recordsSchemaHash: 'different-schema',
		}),
	).toEqual({
		ok: true,
		recordsEpoch: envelope.recordsEpoch,
		recordsDescriptor: 'schema descriptor 1',
		recordsSchemaHash: 'schema-1',
	});
	expect((await open(records)).recordsEpoch).toBe(envelope.recordsEpoch);
});

test('failed first initialization leaves the Durable Object retryable', async () => {
	const { RecordAuthorityDurableObject } = await setup();
	const owned = createStorage();
	const storage = owned.storage as unknown as {
		transactionSync<TResult>(run: () => TResult): TResult;
	};
	const transactionSync = storage.transactionSync.bind(storage);
	let failNextTransaction = true;
	storage.transactionSync = <TResult>(run: () => TResult): TResult => {
		if (failNextTransaction) {
			failNextTransaction = false;
			throw new Error('injected initialization failure');
		}
		return transactionSync(run);
	};
	const object = new RecordAuthorityDurableObject(
		{ storage: owned.storage } as DurableObjectState,
		{} as Cloudflare.Env,
	);

	await expect(object.open(bindingRequest)).rejects.toThrow(
		'injected initialization failure',
	);
	const reopened = await object.open(bindingRequest);
	expect(reopened.ok).toBe(true);
	if (!reopened.ok) throw new Error('Expected retry to open authority');
	expect(
		await object.push({
			...bindingRequest,
			recordsEpoch: reopened.recordsEpoch,
			kind: 'push',
			mutations: [],
		}),
	).toEqual({ kind: 'push', ok: true });
});

test('authenticated principal and workspace pair determine the object name', async () => {
	const { names, records } = await setup();
	await open(records, partition);
	await open(records, {
		principalId: asPrincipalId('bob'),
		workspaceId: 'wiki',
	});
	await open(records, {
		principalId: asPrincipalId('alice'),
		workspaceId: 'notes',
	});

	expect(new Set(names)).toEqual(
		new Set(['["alice","wiki"]', '["bob","wiki"]', '["alice","notes"]']),
	);
});

test('tables apply persists one expected-head transition', async () => {
	const { records } = await setup();
	const envelope = await open(records);
	expect(
		await records.applyTables(partition, {
			...envelope,
			kind: 'tablesApply',
			expectedHead: 0,
			operations: [
				{
					kind: 'createRow',
					table: 'pages',
					rowId: 'page-1',
					cells: { title: 'Reviewed' },
				},
			],
		}),
	).toEqual({ kind: 'tablesApply', ok: true, newHead: 1 });
	expect(
		await records.applyTables(partition, {
			...envelope,
			kind: 'tablesApply',
			expectedHead: 0,
			operations: [
				{
					kind: 'updateRow',
					table: 'pages',
					rowId: 'page-1',
					cells: { title: 'Stale' },
				},
			],
		}),
	).toEqual({ kind: 'tablesApply', ok: false, reason: 'head-moved' });
	expect(
		await records.readTablesState(partition, {
			...envelope,
			kind: 'tablesState',
		}),
	).toEqual({
		kind: 'tablesState',
		ok: true,
		head: 1,
		rows: [
			{
				table: 'pages',
				rowId: 'page-1',
				cells: { title: 'Reviewed' },
			},
		],
	});
});

test('production compaction serves a snapshot and chunks to a stale cursor', async () => {
	const { records } = await setup();
	const envelope = await open(records);
	expect(
		await records.push(partition, {
			...envelope,
			kind: 'push',
			mutations: Array.from({ length: 1_000 }, (_, index) => ({
				actorId: 'actor-compact',
				actorSequence: index + 1,
				operations: [
					{
						kind: 'createRow' as const,
						table: 'pages',
						rowId: `page-${index}`,
						cells: { title: `Page ${index}` },
					},
				],
			})),
		}),
	).toEqual({ kind: 'push', ok: true });
	const pulled = await records.pull(partition, {
		...envelope,
		kind: 'pull',
		cursor: 0,
		limit: 100,
	});
	expect(pulled.ok && pulled.snapshotRequired).toBe(true);
	if (!pulled.ok || !pulled.snapshotRequired)
		throw new Error('Expected snapshot bootstrap');
	const chunk = await records.snapshotChunk(partition, {
		...envelope,
		kind: 'snapshotChunk',
		generation: pulled.manifest.generation,
		index: 0,
	});
	expect(chunk.ok).toBe(true);
});
