/**
 * SQLite Replica Runtime Tests
 *
 * Verifies the durable client half of record sync against a real SQLite
 * authority. These tests focus on identity, atomic optimistic writes, exact
 * protocol validation, convergence, and verified snapshot replacement.
 *
 * Key behaviors:
 * - Fresh replicas create durable local identity and outbox state without network I/O
 * - First synchronization durably binds the replica to one records epoch
 * - Actor sequence and outbox advance in the application transaction
 * - Pull pages retract pending creations, fold the page, then replay intent
 * - Lost acknowledgements, remote deletions, and snapshots converge; deletion
 *   is physical absence, never a tombstone record
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	createRecordAuthority,
	type Mutation,
	parsePullResponse,
	type RecordAuthority,
} from '@epicenter/record-sync';
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import { ReplicaInvariantViolationError } from './database.js';
import { defineTable } from './definition.js';
import { field } from './field.js';
import {
	createReplicaRuntime,
	ReplicaAdmissionConflictError,
	ReplicaRecordsEpochMismatchError,
	type ReplicaSyncPort,
	startReplicaSyncSupervisor,
} from './replica.js';
import { defineTestWorkspace as defineWorkspace } from './test-workspace.js';

const definition = defineWorkspace({
	appId: 'replica-tests',
	name: 'Replica tests',
	tables: {
		notes: defineTable({
			fields: {
				id: field.id(),
				title: field.string(),
				pinned: field.boolean(),
			},
		}),
	},
});

const sha256 = async (value: string) =>
	createHash('sha256').update(value).digest('hex');

function createServer(recordsEpoch = 'epoch-1') {
	const native = new Database(':memory:');
	const envelope = {
		protocolMajor: 1,
		recordsEpoch,
	};
	const authority = createRecordAuthority({
		database: createBunSqliteAdapter(native),
		identity: {
			...envelope,
			recordsDescriptor: definition.recordsDescriptor,
			recordsSchemaHash: definition.recordsSchemaHash,
		},
		sha256,
	});
	return { native, authority, envelope };
}

function createPort(
	authority: RecordAuthority,
	recordsEpoch = 'epoch-1',
): ReplicaSyncPort {
	return {
		bindWorkspace(workspaceId) {
			expect(workspaceId).toBe(definition.workspaceId);
		},
		async openAuthority(request) {
			expect(request).toEqual({
				workspaceId: definition.workspaceId,
				recordsDescriptor: definition.recordsDescriptor,
				recordsSchemaHash: definition.recordsSchemaHash,
				protocolMajor: 1,
			});
			return {
				recordsEpoch,
				recordsDescriptor: definition.recordsDescriptor,
				recordsSchemaHash: definition.recordsSchemaHash,
			};
		},
		async push(request) {
			return authority.push(request);
		},
		async pull(request) {
			return authority.pull(request);
		},
		async snapshotChunk(request) {
			return authority.snapshotChunk(request);
		},
	};
}

test('fresh replica writes offline, then binds before draining and pulling', async () => {
	const server = createServer();
	server.authority.push({
		kind: 'push',
		...server.envelope,
		mutations: [
			{
				actorId: 'remote',
				actorSequence: 1,
				operations: [
					{
						kind: 'createRow',
						table: 'notes',
						rowId: 'remote',
						cells: { title: 'from authority', pinned: true },
					},
				],
			},
		],
	});
	const native = new Database(':memory:');
	const calls: string[] = [];
	const base = createPort(server.authority);
	const port: ReplicaSyncPort = {
		...base,
		async openAuthority(request, signal) {
			calls.push('open');
			return base.openAuthority(request, signal);
		},
		async push(request, signal) {
			calls.push('push');
			expect(
				native
					.query('SELECT records_epoch FROM __epicenter_replica WHERE id = 1')
					.get(),
			).toEqual({ records_epoch: 'epoch-1' });
			return base.push(request, signal);
		},
		async pull(request, signal) {
			calls.push('pull');
			return base.pull(request, signal);
		},
	};
	const { runtime } = await openReplica({
		native,
		port,
		actorId: 'offline-actor',
	});

	expect(calls).toEqual([]);
	expect(runtime.inspect()).toMatchObject({
		actorId: 'offline-actor',
		recordsEpoch: null,
		outbox: [],
	});
	runtime.database.tables.notes.create(note('local', 'created offline'));
	expect(runtime.database.tables.notes.get('local')).toEqual(
		note('local', 'created offline'),
	);
	expect(runtime.inspect().outbox).toHaveLength(1);

	await runtime.syncOnce();

	expect(calls).toEqual(['open', 'push', 'pull']);
	expect(runtime.inspect()).toMatchObject({
		recordsEpoch: 'epoch-1',
		appliedServerSequence: 2,
		outbox: [],
	});
	expect(runtime.database.tables.notes.get('remote')).toEqual(
		note('remote', 'from authority', true),
	);
	native.close();
	server.native.close();
});

test('failed first binding preserves local work and the next sync retries', async () => {
	const server = createServer();
	const base = createPort(server.authority);
	let openAttempts = 0;
	let pushAttempts = 0;
	const port: ReplicaSyncPort = {
		...base,
		async openAuthority(request, signal) {
			openAttempts++;
			if (openAttempts === 1) throw new Error('offline during bind');
			return base.openAuthority(request, signal);
		},
		async push(request, signal) {
			pushAttempts++;
			return base.push(request, signal);
		},
	};
	const { native, runtime } = await openReplica({
		port,
		actorId: 'retry-actor',
	});
	runtime.database.tables.notes.create(note('pending', 'survives'));

	await expect(runtime.syncOnce()).rejects.toThrow('offline during bind');
	expect(runtime.database.tables.notes.get('pending')).toEqual(
		note('pending', 'survives'),
	);
	expect(runtime.inspect()).toMatchObject({
		recordsEpoch: null,
		outbox: [{ actorId: 'retry-actor', actorSequence: 1 }],
	});
	expect(pushAttempts).toBe(0);

	await runtime.syncOnce();
	expect(openAttempts).toBe(2);
	expect(pushAttempts).toBe(1);
	expect(runtime.inspect()).toMatchObject({
		recordsEpoch: 'epoch-1',
		outbox: [],
	});
	native.close();
	server.native.close();
});

test('an unbound replica preserves identity and pending work across reopen', async () => {
	const server = createServer();
	const native = new Database(':memory:');
	const first = await openReplica({
		native,
		port: createPort(server.authority),
		actorId: 'durable-actor',
	});
	first.runtime.database.tables.notes.create(note('before', 'online'));

	const offlinePort: ReplicaSyncPort = {
		bindWorkspace() {},
		async openAuthority() {
			throw new Error('offline');
		},
		async push() {
			throw new Error('offline');
		},
		async pull() {
			throw new Error('offline');
		},
		async snapshotChunk() {
			throw new Error('offline');
		},
	};
	const reopened = await openReplica({
		native,
		port: offlinePort,
		actorId: 'must-not-replace',
	});
	reopened.runtime.database.tables.notes.create(
		note('offline', 'still writable'),
	);
	expect(reopened.runtime.database.tables.notes.get('offline')).toEqual(
		note('offline', 'still writable'),
	);
	expect(reopened.runtime.inspect()).toMatchObject({
		actorId: 'durable-actor',
		nextActorSequence: 3,
		recordsEpoch: null,
	});
	expect(reopened.runtime.inspect().outbox).toHaveLength(2);
	await expect(reopened.runtime.syncOnce()).rejects.toThrow('offline');
	native.close();
	server.native.close();
});

test('authority discovery rejects a descriptor that disagrees with its epoch', async () => {
	const server = createServer();
	const base = createPort(server.authority);
	const port: ReplicaSyncPort = {
		...base,
		async openAuthority() {
			return {
				recordsEpoch: 'epoch-1',
				recordsDescriptor: 'different descriptor',
				recordsSchemaHash: definition.recordsSchemaHash,
			};
		},
	};
	const { native, runtime } = await openReplica({
		port,
		actorId: 'actor-a',
	});

	await expect(runtime.syncOnce()).rejects.toThrow(
		'authority-definition-mismatch',
	);
	expect(runtime.inspect().recordsEpoch).toBeNull();
	native.close();
	server.native.close();
});

async function openReplica({
	native = new Database(':memory:'),
	port,
	actorId,
	pullLimit,
}: {
	native?: Database;
	port: ReplicaSyncPort;
	actorId: string;
	pullLimit?: number;
}) {
	const runtime = await createReplicaRuntime({
		definition,
		sqlite: createBunSqliteAdapter(native),
		sync: port,
		protocolMajor: 1,
		createActorId: () => actorId,
		sha256,
		onObserverError: () => {},
		pullLimit,
	});
	return { native, runtime };
}

function note(id: string, title: string, pinned = false) {
	return { id, title, pinned };
}

test('fresh local identity persists and restart preserves its sequence', async () => {
	const server = createServer();
	const native = new Database(':memory:');
	const first = await openReplica({
		native,
		port: createPort(server.authority),
		actorId: 'actor-first',
	});
	first.runtime.database.tables.notes.create(note('n1', 'one'));
	expect(first.runtime.inspect()).toMatchObject({
		actorId: 'actor-first',
		nextActorSequence: 2,
		appliedServerSequence: 0,
	});

	const restarted = await openReplica({
		native,
		port: createPort(server.authority),
		actorId: 'actor-must-not-replace',
	});
	expect(restarted.runtime.inspect()).toMatchObject({
		actorId: 'actor-first',
		nextActorSequence: 2,
	});
	expect(restarted.runtime.database.tables.notes.get('n1')).toEqual(
		note('n1', 'one'),
	);
	native.close();
	server.native.close();
});

test('one application transaction creates one atomic ordered outbox mutation', async () => {
	const server = createServer();
	const { native, runtime } = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-a',
	});
	runtime.database.transact(({ tables }) => {
		tables.notes.create(note('n1', 'one'));
		tables.notes.create(note('n2', 'two', true));
	});
	const [mutation] = runtime.inspect().outbox;
	expect(mutation).toMatchObject({ actorId: 'actor-a', actorSequence: 1 });
	expect(mutation?.operations).toHaveLength(2);
	expect(runtime.inspect().nextActorSequence).toBe(2);

	native.exec(
		`CREATE TRIGGER reject_outbox BEFORE INSERT ON __epicenter_replica_outbox BEGIN SELECT RAISE(ABORT, 'reject outbox'); END`,
	);
	expect(() =>
		runtime.database.tables.notes.create(note('rollback', 'no')),
	).toThrow('reject outbox');
	expect(runtime.database.tables.notes.get('rollback')).toBeNull();
	expect(runtime.inspect().nextActorSequence).toBe(2);
	native.close();
	server.native.close();
});

test('lost push acknowledgement retries safely and own echo prunes outbox', async () => {
	const server = createServer();
	const base = createPort(server.authority);
	let loseAck = true;
	const port: ReplicaSyncPort = {
		...base,
		async push(request) {
			const response = await base.push(request);
			if (loseAck) {
				loseAck = false;
				throw new Error('connection lost');
			}
			return response;
		},
	};
	const { native, runtime } = await openReplica({ port, actorId: 'actor-a' });
	runtime.database.tables.notes.create(note('n1', 'one'));
	await expect(runtime.syncOnce()).rejects.toThrow('connection lost');
	expect(runtime.inspect().outbox).toHaveLength(1);
	await runtime.syncOnce();
	expect(runtime.inspect()).toMatchObject({
		appliedServerSequence: 1,
		outbox: [],
	});
	expect(runtime.database.tables.notes.get('n1')).toEqual(note('n1', 'one'));
	native.close();
	server.native.close();
});

test('two replicas converge by server order while different cells merge', async () => {
	const server = createServer();
	const a = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-a',
	});
	const b = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-b',
	});
	a.runtime.database.tables.notes.create(note('from-a', 'created by a'));
	b.runtime.database.tables.notes.create(note('from-b', 'created by b', true));
	await a.runtime.syncOnce();
	await b.runtime.syncOnce();
	await a.runtime.syncOnce();
	expect(a.runtime.database.tables.notes.get('from-b')).toEqual(
		note('from-b', 'created by b', true),
	);
	expect(b.runtime.database.tables.notes.get('from-a')).toEqual(
		note('from-a', 'created by a'),
	);

	a.runtime.database.tables.notes.create(note('merge', 'base'));
	await a.runtime.syncOnce();
	await b.runtime.syncOnce();
	a.runtime.database.tables.notes.patch('merge', { title: 'title-a' });
	b.runtime.database.tables.notes.patch('merge', { pinned: true });
	await a.runtime.syncOnce();
	await b.runtime.syncOnce();
	await a.runtime.syncOnce();
	expect(a.runtime.database.tables.notes.get('merge')).toEqual(
		note('merge', 'title-a', true),
	);
	expect(b.runtime.database.tables.notes.get('merge')).toEqual(
		note('merge', 'title-a', true),
	);
	a.native.close();
	b.native.close();
	server.native.close();
});

test('pull retracts pending creations so own echoes fold and pending intent replays', async () => {
	const server = createServer();
	const base = createPort(server.authority);
	const port: ReplicaSyncPort = {
		...base,
		// Acknowledge without forwarding: the authority is seeded directly
		// below, so the second creation stays pending across the pull.
		async push() {
			return { kind: 'push', ok: true };
		},
	};
	const { native, runtime } = await openReplica({ port, actorId: 'actor-a' });
	runtime.database.tables.notes.create(note('accepted-row', 'accepted'));
	const [first] = runtime.inspect().outbox;
	if (!first) throw new Error('expected pending mutation');
	server.authority.push({
		kind: 'push',
		...server.envelope,
		mutations: [first],
	});
	server.authority.push({
		kind: 'push',
		...server.envelope,
		mutations: [
			{
				actorId: 'remote',
				actorSequence: 1,
				operations: [
					{
						kind: 'createRow',
						table: 'notes',
						rowId: 'remote-row',
						cells: { title: 'remote', pinned: true },
					},
				],
			},
		],
	});
	runtime.database.tables.notes.create(note('pending-row', 'pending'));

	await runtime.syncOnce();

	// Accepted prefix: the page's own createRow echo and the remote creation
	// folded onto absent identities because pending creations were retracted.
	expect(runtime.database.tables.notes.get('accepted-row')).toEqual(
		note('accepted-row', 'accepted'),
	);
	expect(runtime.database.tables.notes.get('remote-row')).toEqual(
		note('remote-row', 'remote', true),
	);
	// Pending intent replayed after the page: still visible, still queued.
	expect(runtime.database.tables.notes.get('pending-row')).toEqual(
		note('pending-row', 'pending'),
	);
	expect(runtime.inspect()).toMatchObject({ appliedServerSequence: 2 });
	expect(
		runtime.inspect().outbox.map(({ actorSequence }) => actorSequence),
	).toEqual([2]);
	native.close();
	server.native.close();
});

test('a pending updateRow to a remotely deleted row replays as a no-op and never resurrects it', async () => {
	const server = createServer();
	const a = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-a',
	});
	const b = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-b',
	});
	a.runtime.database.tables.notes.create(note('doomed', 'alive'));
	await a.runtime.syncOnce();
	await b.runtime.syncOnce();
	expect(b.runtime.database.tables.notes.get('doomed')).toEqual(
		note('doomed', 'alive'),
	);

	a.runtime.database.tables.notes.remove('doomed');
	await a.runtime.syncOnce();
	b.runtime.database.tables.notes.patch('doomed', { title: 'zombie' });
	await b.runtime.syncOnce();
	await a.runtime.syncOnce();

	expect(b.runtime.database.tables.notes.get('doomed')).toBeNull();
	expect(a.runtime.database.tables.notes.get('doomed')).toBeNull();
	expect(b.runtime.inspect().outbox).toEqual([]);
	a.native.close();
	b.native.close();
	server.native.close();
});

test("a push refused with 'create-conflict' is an invariant violation demanding rebootstrap", async () => {
	const port: ReplicaSyncPort = {
		bindWorkspace() {},
		async openAuthority() {
			return {
				recordsEpoch: 'epoch-1',
				recordsDescriptor: definition.recordsDescriptor,
				recordsSchemaHash: definition.recordsSchemaHash,
			};
		},
		async push() {
			return { kind: 'push', ok: false, reason: 'create-conflict' };
		},
		async pull() {
			throw new Error('pull must not run after a refused push');
		},
		async snapshotChunk() {
			throw new Error('unexpected snapshot chunk request');
		},
	};
	const { native, runtime } = await openReplica({ port, actorId: 'actor-a' });
	runtime.database.tables.notes.create(note('dup', 'duplicate'));

	const error = await runtime.syncOnce().then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(error).toBeInstanceOf(ReplicaInvariantViolationError);
	expect((error as Error).message).toContain('rebootstrap');
	native.close();
});

test('durable authority refusals stop the sync supervisor instead of retrying', async () => {
	const reasons = [
		'protocol-mismatch',
		'records-epoch-mismatch',
		'actor-sequence-gap',
	] as const;

	for (const reason of reasons) {
		let pushAttempts = 0;
		const port: ReplicaSyncPort = {
			bindWorkspace() {},
			async openAuthority() {
				return {
					recordsEpoch: 'epoch-1',
					recordsDescriptor: definition.recordsDescriptor,
					recordsSchemaHash: definition.recordsSchemaHash,
				};
			},
			async push() {
				pushAttempts++;
				return { kind: 'push' as const, ok: false as const, reason };
			},
			async pull() {
				throw new Error('pull must not run after a refused push');
			},
			async snapshotChunk() {
				throw new Error('unexpected snapshot chunk request');
			},
		};
		const { native, runtime } = await openReplica({
			port,
			actorId: `actor-${reason}`,
		});
		runtime.database.tables.notes.create(note('pending', reason));
		const errors: unknown[] = [];
		const supervisor = startReplicaSyncSupervisor(runtime, {
			onError: (error) => errors.push(error),
			pollIntervalMs: 0,
			retryDelaysMs: [0],
		});

		supervisor.request();
		await waitFor(() => errors.length === 1);
		supervisor.request();
		await Bun.sleep(10);
		expect(pushAttempts).toBe(1);
		expect((errors[0] as Error).name).toBe(
			reason === 'records-epoch-mismatch'
				? 'ReplicaRecordsEpochMismatchError'
				: 'ReplicaSyncRefusalError',
		);
		expect(runtime.inspect().outbox).toHaveLength(1);
		await supervisor.dispose();
		native.close();
	}
});

test("a push refused with 'row-too-large' stops retries and preserves pending intent", async () => {
	let pushAttempts = 0;
	const port: ReplicaSyncPort = {
		bindWorkspace() {},
		async openAuthority() {
			return {
				recordsEpoch: 'epoch-1',
				recordsDescriptor: definition.recordsDescriptor,
				recordsSchemaHash: definition.recordsSchemaHash,
			};
		},
		async push() {
			pushAttempts++;
			return { kind: 'push', ok: false, reason: 'row-too-large' };
		},
		async pull() {
			throw new Error('pull must not run after a refused push');
		},
		async snapshotChunk() {
			throw new Error('unexpected snapshot chunk request');
		},
	};
	const { native, runtime } = await openReplica({ port, actorId: 'actor-a' });
	runtime.database.tables.notes.create(note('large', 'pending'));
	const errors: unknown[] = [];
	const supervisor = startReplicaSyncSupervisor(runtime, {
		onError: (error) => errors.push(error),
		pollIntervalMs: 0,
		retryDelaysMs: [0],
	});

	supervisor.request();
	await waitFor(() => errors.length === 1);
	supervisor.request();
	await Bun.sleep(10);
	expect(pushAttempts).toBe(1);
	expect(errors[0]).toBeInstanceOf(ReplicaAdmissionConflictError);
	expect(runtime.inspect().outbox).toHaveLength(1);
	await supervisor.dispose();
	native.close();
});

test('invalid remote rows quarantine, later updates promote, and deletion is absence', async () => {
	const server = createServer();
	const { native, runtime } = await openReplica({
		port: createPort(server.authority),
		actorId: 'local',
	});
	const push = (mutation: Mutation) =>
		server.authority.push({
			kind: 'push',
			...server.envelope,
			mutations: [mutation],
		});
	push({
		actorId: 'remote',
		actorSequence: 1,
		operations: [
			{
				kind: 'createRow',
				table: 'notes',
				rowId: 'n1',
				cells: { title: 'partial' },
			},
		],
	});
	await runtime.syncOnce();
	expect(runtime.database.tables.notes.get('n1')).toBeNull();
	expect(
		native.query('SELECT * FROM __epicenter_quarantine').all(),
	).toHaveLength(1);
	push({
		actorId: 'remote',
		actorSequence: 2,
		operations: [
			{
				kind: 'updateRow',
				table: 'notes',
				rowId: 'n1',
				cells: { pinned: false },
			},
		],
	});
	await runtime.syncOnce();
	expect(runtime.database.tables.notes.get('n1')).toEqual(
		note('n1', 'partial'),
	);
	push({
		actorId: 'remote',
		actorSequence: 3,
		operations: [{ kind: 'deleteRow', table: 'notes', rowId: 'n1' }],
	});
	push({
		actorId: 'remote',
		actorSequence: 4,
		operations: [
			{
				kind: 'updateRow',
				table: 'notes',
				rowId: 'n1',
				cells: { title: 'zombie' },
			},
		],
	});
	await runtime.syncOnce();
	expect(runtime.database.tables.notes.get('n1')).toBeNull();
	expect(native.query('SELECT * FROM __epicenter_quarantine').all()).toEqual(
		[],
	);
	// Deletion leaves no residue: there is no tombstone table at all.
	expect(
		native
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__epicenter_tombstones'",
			)
			.all(),
	).toEqual([]);
	native.close();
	server.native.close();
});

test('corrupt page rolls back projection and cursor together', async () => {
	const server = createServer();
	server.authority.push({
		kind: 'push',
		...server.envelope,
		mutations: [
			{
				actorId: 'remote',
				actorSequence: 1,
				operations: [
					{
						kind: 'createRow',
						table: 'notes',
						rowId: 'n1',
						cells: { title: 'one', pinned: false },
					},
				],
			},
		],
	});
	const base = createPort(server.authority);
	const port: ReplicaSyncPort = {
		...base,
		async pull(request) {
			const response = parsePullResponse(await base.pull(request));
			if (response.ok && !response.snapshotRequired && response.mutations[0]) {
				response.mutations[0].serverSequence = 2;
				response.newCursor = 2;
			}
			return response;
		},
	};
	const { native, runtime } = await openReplica({ port, actorId: 'local' });
	await expect(runtime.syncOnce()).rejects.toThrow('contiguous server page');
	expect(runtime.inspect().appliedServerSequence).toBe(0);
	expect(runtime.database.tables.notes.get('n1')).toBeNull();
	native.close();
	server.native.close();
});

test('verified snapshot installs its high-water and prunes accepted local work', async () => {
	const server = createServer();
	const port = createPort(server.authority);
	const { native, runtime } = await openReplica({ port, actorId: 'actor-a' });
	runtime.database.tables.notes.create(note('local', 'accepted'));
	const [pending] = runtime.inspect().outbox;
	if (!pending) throw new Error('expected pending mutation');
	server.authority.push({
		kind: 'push',
		...server.envelope,
		mutations: [pending],
	});
	const manifest = await server.authority.publishSnapshot({
		maxChunkBytes: 512 * 1024,
	});
	// Snapshot chunks stage live rows only: {table, rowId, cells}, no
	// deleted flag and no deletion entries.
	const chunk = server.authority.snapshotChunk({
		kind: 'snapshotChunk',
		...server.envelope,
		generation: manifest.generation,
		index: 0,
	});
	if (!chunk.ok) throw new Error('expected a staged snapshot chunk');
	expect(chunk.chunk.rows).toEqual([
		{
			table: 'notes',
			rowId: 'local',
			cells: { title: 'accepted', pinned: false },
		},
	]);
	await runtime.syncOnce();
	expect(runtime.inspect()).toMatchObject({
		appliedServerSequence: 1,
		outbox: [],
	});
	expect(runtime.database.tables.notes.get('local')).toEqual(
		note('local', 'accepted'),
	);
	native.close();
	server.native.close();
});

test('snapshot install prunes by high-water, replays pending intent, and omitted rows stay absent', async () => {
	const server = createServer();
	const { native, runtime } = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-a',
	});
	runtime.database.transact(({ tables }) => {
		tables.notes.create(note('ghost', 'mine'));
		tables.notes.create(note('kept', 'original'));
	});
	await runtime.syncOnce();
	runtime.database.tables.notes.patch('kept', { title: 'pending-kept' });
	runtime.database.tables.notes.patch('ghost', { title: 'still mine' });
	server.authority.push({
		kind: 'push',
		...server.envelope,
		mutations: [
			{
				actorId: 'remote',
				actorSequence: 1,
				operations: [{ kind: 'deleteRow', table: 'notes', rowId: 'ghost' }],
			},
		],
	});
	await server.authority.publishSnapshot({ maxChunkBytes: 512 * 1024 });

	await runtime.syncOnce();

	// The snapshot omitted 'ghost': the pending updateRow replayed as a
	// no-op and did not resurrect the row.
	expect(runtime.database.tables.notes.get('ghost')).toBeNull();
	// 'kept' survived the snapshot and the pending update replayed onto it.
	expect(runtime.database.tables.notes.get('kept')).toEqual(
		note('kept', 'pending-kept'),
	);
	expect(runtime.inspect()).toMatchObject({
		appliedServerSequence: 4,
		outbox: [],
	});
	native.close();
	server.native.close();
});

test('snapshot high-water cannot prune intent the authority never echoed', async () => {
	const server = createServer();
	const { native, runtime } = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-a',
	});
	runtime.database.tables.notes.create(note('local', 'pending'));
	server.authority.push({
		kind: 'push',
		...server.envelope,
		mutations: [
			{
				actorId: 'actor-a',
				actorSequence: 1,
				operations: [
					{
						kind: 'createRow',
						table: 'notes',
						rowId: 'collision-1',
						cells: { title: 'one', pinned: false },
					},
				],
			},
			{
				actorId: 'actor-a',
				actorSequence: 2,
				operations: [
					{
						kind: 'createRow',
						table: 'notes',
						rowId: 'collision-2',
						cells: { title: 'two', pinned: false },
					},
				],
			},
		],
	});
	await server.authority.publishSnapshot({ maxChunkBytes: 512 * 1024 });

	await expect(runtime.syncOnce()).rejects.toThrow(
		'actor high-water contradicts local intent',
	);
	expect(runtime.inspect().outbox).toHaveLength(1);
	expect(runtime.database.tables.notes.get('local')).toEqual(
		note('local', 'pending'),
	);
	native.close();
	server.native.close();
});

test('actor sequence exhaustion rolls back the application write', async () => {
	const server = createServer();
	const { native, runtime } = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-a',
	});
	native
		.query(
			'UPDATE __epicenter_replica SET next_actor_sequence = ? WHERE id = 1',
		)
		.run(Number.MAX_SAFE_INTEGER);

	expect(() =>
		runtime.database.tables.notes.create(note('too-late', 'rolled back')),
	).toThrow('actor sequence is exhausted');
	expect(runtime.database.tables.notes.get('too-late')).toBeNull();
	expect(runtime.inspect().outbox).toEqual([]);
	native.close();
	server.native.close();
});

test('epoch mismatch freezes writes and preserves pending local work', async () => {
	const firstServer = createServer('epoch-1');
	const native = new Database(':memory:');
	let currentPort = createPort(firstServer.authority, 'epoch-1');
	const port: ReplicaSyncPort = {
		bindWorkspace: (workspaceId) => currentPort.bindWorkspace(workspaceId),
		openAuthority: (request, signal) =>
			currentPort.openAuthority(request, signal),
		push: (request, signal) => currentPort.push(request, signal),
		pull: (request, signal) => currentPort.pull(request, signal),
		snapshotChunk: (request, signal) =>
			currentPort.snapshotChunk(request, signal),
	};
	const first = await openReplica({
		native,
		port,
		actorId: 'actor-a',
	});
	expect(() => first.runtime.readRecoveryCheckpoint()).toThrow(
		'only after an epoch mismatch',
	);
	await first.runtime.syncOnce();
	first.runtime.database.tables.notes.create(note('pending', 'local recovery'));
	const replacement = createServer('epoch-2');
	currentPort = createPort(replacement.authority, 'epoch-2');
	const error = await first.runtime.syncOnce().then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(error).toBeInstanceOf(ReplicaRecordsEpochMismatchError);
	expect(error).toMatchObject({
		localRecordsEpoch: 'epoch-1',
		currentRecordsEpoch: 'epoch-2',
		pendingMutationCount: 1,
	});
	expect(first.runtime.database.tables.notes.get('pending')).toEqual(
		note('pending', 'local recovery'),
	);
	expect(first.runtime.inspect()).toMatchObject({
		recordsEpoch: 'epoch-1',
		outbox: [{ actorId: 'actor-a', actorSequence: 1 }],
		epochMismatch: { currentRecordsEpoch: 'epoch-2' },
	});
	const checkpoint = first.runtime.readRecoveryCheckpoint();
	expect(checkpoint).toEqual({
		format: 'epicenter.records-recovery/1',
		workspaceId: definition.workspaceId,
		recordsEpoch: 'epoch-1',
		recordsDescriptor: definition.recordsDescriptor,
		recordsSchemaHash: definition.recordsSchemaHash,
		rows: [
			{
				table: 'notes',
				rowId: 'pending',
				cells: { title: 'local recovery', pinned: false },
			},
		],
		pendingMutations: [
			{
				actorId: 'actor-a',
				actorSequence: 1,
				operations: [
					{
						kind: 'createRow',
						table: 'notes',
						rowId: 'pending',
						cells: { title: 'local recovery', pinned: false },
					},
				],
			},
		],
	});
	expect(() =>
		first.runtime.database.tables.notes.create(note('blocked', 'too late')),
	).toThrow(ReplicaRecordsEpochMismatchError);

	const reopened = await openReplica({
		native,
		port,
		actorId: 'must-not-replace-actor',
	});
	expect(reopened.runtime.inspect()).toMatchObject({
		actorId: 'actor-a',
		recordsEpoch: 'epoch-1',
		outbox: [{ actorId: 'actor-a', actorSequence: 1 }],
		epochMismatch: {
			currentRecordsEpoch: 'epoch-2',
			currentRecordsSchemaHash: definition.recordsSchemaHash,
		},
	});
	expect(() =>
		reopened.runtime.database.tables.notes.create(
			note('still-blocked', 'restart cannot unfreeze'),
		),
	).toThrow(ReplicaRecordsEpochMismatchError);
	expect(reopened.runtime.readRecoveryCheckpoint()).toEqual(checkpoint);
	native.close();
	firstServer.native.close();
	replacement.native.close();
});

test('epoch replacement between discovery and push durably freezes the replica', async () => {
	const firstServer = createServer('epoch-1');
	const replacement = createServer('epoch-2');
	let currentPort = createPort(firstServer.authority, 'epoch-1');
	let replaceAfterOpen = false;
	const port: ReplicaSyncPort = {
		bindWorkspace: (workspaceId) => currentPort.bindWorkspace(workspaceId),
		async openAuthority(request, signal) {
			const descriptor = await currentPort.openAuthority(request, signal);
			if (replaceAfterOpen) {
				replaceAfterOpen = false;
				currentPort = createPort(replacement.authority, 'epoch-2');
			}
			return descriptor;
		},
		push: (request, signal) => currentPort.push(request, signal),
		pull: (request, signal) => currentPort.pull(request, signal),
		snapshotChunk: (request, signal) =>
			currentPort.snapshotChunk(request, signal),
	};
	const native = new Database(':memory:');
	const replica = await openReplica({ native, port, actorId: 'actor-a' });
	await replica.runtime.syncOnce();
	replica.runtime.database.tables.notes.create(note('pending', 'preserve me'));
	replaceAfterOpen = true;

	await expect(replica.runtime.syncOnce()).rejects.toMatchObject({
		name: 'ReplicaRecordsEpochMismatchError',
		localRecordsEpoch: 'epoch-1',
		currentRecordsEpoch: 'epoch-2',
		pendingMutationCount: 1,
	});
	expect(replica.runtime.database.tables.notes.get('pending')).toEqual(
		note('pending', 'preserve me'),
	);
	expect(() =>
		replica.runtime.database.tables.notes.create(note('blocked', 'too late')),
	).toThrow(ReplicaRecordsEpochMismatchError);

	native.close();
	firstServer.native.close();
	replacement.native.close();
});

test('epoch replacement between discovery and pull freezes a clean replica', async () => {
	const firstServer = createServer('epoch-1');
	const replacement = createServer('epoch-2');
	let currentPort = createPort(firstServer.authority, 'epoch-1');
	let replaceAfterOpen = false;
	const port: ReplicaSyncPort = {
		bindWorkspace: (workspaceId) => currentPort.bindWorkspace(workspaceId),
		async openAuthority(request, signal) {
			const descriptor = await currentPort.openAuthority(request, signal);
			if (replaceAfterOpen) {
				replaceAfterOpen = false;
				currentPort = createPort(replacement.authority, 'epoch-2');
			}
			return descriptor;
		},
		push: (request, signal) => currentPort.push(request, signal),
		pull: (request, signal) => currentPort.pull(request, signal),
		snapshotChunk: (request, signal) =>
			currentPort.snapshotChunk(request, signal),
	};
	const replica = await openReplica({ port, actorId: 'actor-a' });
	await replica.runtime.syncOnce();
	replaceAfterOpen = true;

	await expect(replica.runtime.syncOnce()).rejects.toBeInstanceOf(
		ReplicaRecordsEpochMismatchError,
	);
	expect(() =>
		replica.runtime.database.tables.notes.create(note('blocked', 'too late')),
	).toThrow(ReplicaRecordsEpochMismatchError);

	replica.native.close();
	firstServer.native.close();
	replacement.native.close();
});

test('epoch replacement during snapshot download freezes the replica', async () => {
	const firstServer = createServer('epoch-1');
	firstServer.authority.push({
		kind: 'push',
		...firstServer.envelope,
		mutations: [
			{
				actorId: 'remote',
				actorSequence: 1,
				operations: [
					{
						kind: 'createRow',
						table: 'notes',
						rowId: 'snapshot-row',
						cells: { title: 'snapshot', pinned: false },
					},
				],
			},
		],
	});
	await firstServer.authority.publishSnapshot({ maxChunkBytes: 1_024 });
	const replacement = createServer('epoch-2');
	const firstPort = createPort(firstServer.authority, 'epoch-1');
	const replacementPort = createPort(replacement.authority, 'epoch-2');
	let currentPort = firstPort;
	const port: ReplicaSyncPort = {
		bindWorkspace: (workspaceId) => currentPort.bindWorkspace(workspaceId),
		openAuthority: (request, signal) =>
			currentPort.openAuthority(request, signal),
		push: (request, signal) => currentPort.push(request, signal),
		pull: (request, signal) => currentPort.pull(request, signal),
		async snapshotChunk(request, signal) {
			currentPort = replacementPort;
			return currentPort.snapshotChunk(request, signal);
		},
	};
	const replica = await openReplica({ port, actorId: 'actor-a' });

	await expect(replica.runtime.syncOnce()).rejects.toBeInstanceOf(
		ReplicaRecordsEpochMismatchError,
	);
	expect(() =>
		replica.runtime.database.tables.notes.create(note('blocked', 'too late')),
	).toThrow(ReplicaRecordsEpochMismatchError);

	replica.native.close();
	firstServer.native.close();
	replacement.native.close();
});

test('fresh replica bootstraps the authority current records epoch', async () => {
	const server = createServer('epoch-current');
	server.authority.push({
		kind: 'push',
		...server.envelope,
		mutations: [
			{
				actorId: 'remote',
				actorSequence: 1,
				operations: [
					{
						kind: 'createRow',
						table: 'notes',
						rowId: 'current',
						cells: { title: 'current epoch', pinned: false },
					},
				],
			},
		],
	});
	const fresh = await openReplica({
		port: createPort(server.authority, 'epoch-current'),
		actorId: 'fresh-actor',
	});

	await fresh.runtime.syncOnce();

	expect(fresh.runtime.inspect().recordsEpoch).toBe('epoch-current');
	expect(fresh.runtime.database.tables.notes.get('current')).toEqual(
		note('current', 'current epoch'),
	);
	fresh.native.close();
	server.native.close();
});

test('sync supervisor retries failures and aborts in-flight disposal', async () => {
	let attempts = 0;
	let activeSignal: AbortSignal | undefined;
	const errors: unknown[] = [];
	const supervisor = startReplicaSyncSupervisor(
		{
			async syncOnce(signal) {
				attempts++;
				activeSignal = signal;
				if (attempts === 1) throw new Error('offline');
				await new Promise<void>((_resolve, reject) => {
					signal?.addEventListener('abort', () => reject(signal.reason), {
						once: true,
					});
				});
			},
		},
		{
			onError: (error) => errors.push(error),
			pollIntervalMs: 0,
			retryDelaysMs: [0],
		},
	);

	supervisor.request();
	await waitFor(() => attempts === 2);
	await supervisor.dispose();

	expect(activeSignal?.aborted).toBe(true);
	expect(errors).toHaveLength(1);
});

test('a long-offline outbox drains through admission-sized push batches', async () => {
	const server = createServer();
	const native = new Database(':memory:');
	const pushedBatchSizes: number[] = [];
	const port = createPort(server.authority);
	const batchingPort: ReplicaSyncPort = {
		...port,
		async push(request) {
			pushedBatchSizes.push(request.mutations.length);
			return server.authority.push(request);
		},
	};
	const { runtime } = await openReplica({
		native,
		port: batchingPort,
		actorId: 'batching-actor',
	});
	for (let index = 0; index < 70; index++) {
		runtime.database.tables.notes.create(note(`n${index}`, `title ${index}`));
	}
	await runtime.syncOnce();
	// mutationsPerPush is 64: 70 pending mutations must split across pushes
	// instead of one oversized request that admission would refuse forever.
	expect(pushedBatchSizes).toEqual([64, 6]);
	expect(runtime.inspect().outbox).toHaveLength(0);
	expect(runtime.database.tables.notes.count()).toBe(70);
	native.close();
	server.native.close();
});

test('sync supervisor stops permanently on a replica invariant violation', async () => {
	let attempts = 0;
	const errors: unknown[] = [];
	const supervisor = startReplicaSyncSupervisor(
		{
			async syncOnce() {
				attempts++;
				throw new ReplicaInvariantViolationError('replica is corrupt');
			},
		},
		{
			onError: (error) => errors.push(error),
			pollIntervalMs: 0,
			retryDelaysMs: [0],
		},
	);

	supervisor.request();
	await waitFor(() => errors.length === 1);
	// A later request must not resurrect a corrupt replica's sync loop.
	supervisor.request();
	await Bun.sleep(10);
	expect(attempts).toBe(1);
	expect(errors[0]).toBeInstanceOf(ReplicaInvariantViolationError);
	await supervisor.dispose();
});

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await Bun.sleep(1);
	}
	throw new Error('Timed out waiting for replica test condition');
}
