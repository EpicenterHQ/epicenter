/**
 * Current-State Replica Tests
 *
 * Verifies the reset-only synchronized Account replica against the new
 * authority feed. These tests protect local visibility, fixed local cuts,
 * exact retry, stale-install guards, and disposable complete acquisition.
 *
 * Key behaviors:
 * - same-address admissions compact without changing their birth sequence
 * - accepted sealed intent remains visible until fixed pull retirement
 * - fixed cuts ignore later scalar work
 * - moving current rows and deletions install without regression
 * - floor-raced acquisition restarts while preserving every local intent
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	type AcquireRequest,
	CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	type CurrentStateWireRowIntent,
	type PullRequest,
	type PushRequest,
	parsePullResponse,
	rowRoundDigest,
} from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { createSqliteDocumentLog } from '../../../workspace/src/document-provider/sqlite-document-log.js';
import {
	type CurrentStateReplica,
	type CurrentStateReplicaTransport,
	createCurrentStateReplica,
} from '../../../workspace/src/sqlite/current-state-replica.js';
import {
	type CurrentStateRowAuthority,
	openAccountRowAuthority,
} from './authority.js';

const ROW_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ROW_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ROW_C = 'cccccccccccccccccccccccc';
const ROW_D = 'dddddddddddddddddddddddd';

function openAuthority() {
	const database = new Database(':memory:');
	const authority = openAccountRowAuthority({
		database: createBunSqliteAdapter(database),
	}).workspace('workspace');
	return { authority, database };
}

function createTransport(authority: CurrentStateRowAuthority) {
	const pushRequests: PushRequest[] = [];
	const pullRequests: PullRequest[] = [];
	const acquireRequests: AcquireRequest[] = [];
	const transport: CurrentStateReplicaTransport & {
		pushRequests: PushRequest[];
		pullRequests: PullRequest[];
		acquireRequests: AcquireRequest[];
	} = {
		pushRequests,
		pullRequests,
		acquireRequests,
		async push(request) {
			pushRequests.push(structuredClone(request));
			return authority.push(request);
		},
		async pull(request) {
			pullRequests.push(structuredClone(request));
			return authority.pull(request);
		},
		async acquire(request) {
			acquireRequests.push(structuredClone(request));
			return authority.acquire(request);
		},
	};
	return transport;
}

function setup(options?: {
	transport?: CurrentStateReplicaTransport;
	pageLimit?: number;
	acquirePageLimit?: number;
	onRowsDeleted?: (addresses: { table: string; rowId: string }[]) => void;
	onAcquisitionPromoted?: () => void;
}) {
	const authorityState = openAuthority();
	const database = new Database(':memory:');
	const transport =
		options?.transport ?? createTransport(authorityState.authority);
	const replica = createCurrentStateReplica({
		sqlite: createBunSqliteAdapter(database),
		transport,
		...(options?.pageLimit === undefined
			? {}
			: { pageLimit: options.pageLimit }),
		...(options?.acquirePageLimit === undefined
			? {}
			: { acquirePageLimit: options.acquirePageLimit }),
		...(options?.onRowsDeleted === undefined
			? {}
			: { onRowsDeleted: options.onRowsDeleted }),
		...(options?.onAcquisitionPromoted === undefined
			? {}
			: { onAcquisitionPromoted: options.onAcquisitionPromoted }),
	});
	return {
		authorityState,
		database,
		replica,
		transport,
		dispose() {
			database.close();
			authorityState.database.close();
		},
	};
}

function createRow(rowId: string, title: string): CurrentStateWireRowIntent {
	return {
		kind: 'create',
		table: 'notes',
		rowId,
		fields: { title },
	};
}

async function settleCut(replica: CurrentStateReplica, cut: number) {
	for (;;) {
		const result = await replica.synchronizeThrough(cut);
		if (result.outcome !== 'progress') return result;
	}
}

test('lost first-push response retries one durable client-owned identity', async () => {
	const authorityState = openAuthority();
	const base = createTransport(authorityState.authority);
	const pushedReplicaIds: string[] = [];
	let loseFirstResponse = true;
	const transport: CurrentStateReplicaTransport = {
		pull: base.pull,
		acquire: base.acquire,
		async push(request) {
			pushedReplicaIds.push(request.replicaId);
			const response = await base.push(request);
			if (loseFirstResponse) {
				loseFirstResponse = false;
				throw new Error('push response was lost');
			}
			return response;
		},
	};
	const database = new Database(':memory:');
	try {
		const replica = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(database),
			transport,
		});
		const initialId = database
			.query<{ replica_id: string }, []>('SELECT replica_id FROM replica')
			.get()?.replica_id;
		if (!initialId) throw new Error('Expected a durable replica identity');
		expect(initialId).toMatch(/^[a-z0-9]{24}$/);
		replica.admit(createRow(ROW_A, 'lost response'));
		await expect(replica.synchronizeOnce()).rejects.toThrow(
			'push response was lost',
		);

		const reopened = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(database),
			transport,
		});
		expect(
			database
				.query<{ replica_id: string }, []>('SELECT replica_id FROM replica')
				.get()?.replica_id,
		).toBe(initialId);
		await reopened.synchronizeOnce();
		expect(pushedReplicaIds).toEqual([initialId, initialId]);
		expect(
			authorityState.database
				.query<{ count: number }, []>(
					'SELECT COUNT(*) AS count FROM row_authority_replicas',
				)
				.get()?.count,
		).toBe(1);
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('first-push storage limit stays pending with local work queued', async () => {
	const authorityState = openAuthority();
	const base = createTransport(authorityState.authority);
	let pushAttempts = 0;
	const transport: CurrentStateReplicaTransport = {
		pull: base.pull,
		acquire: base.acquire,
		async push() {
			pushAttempts += 1;
			return { result: 'storage-limit' };
		},
	};
	const database = new Database(':memory:');
	try {
		const replica = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(database),
			transport,
		});
		replica.admit(createRow(ROW_A, 'queued locally'));

		await expect(replica.synchronizeOnce()).resolves.toEqual({
			outcome: 'pending',
			reason: 'storage-limit',
		});
		await expect(replica.synchronizeOnce()).resolves.toEqual({
			outcome: 'pending',
			reason: 'storage-limit',
		});
		expect(pushAttempts).toBe(2);
		expect(replica.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'queued locally',
		});
		expect(base.pushRequests).toEqual([]);
		expect(
			authorityState.authority.hasReplica(
				database
					.query<{ replica_id: string }, []>('SELECT replica_id FROM replica')
					.get()!.replica_id,
			),
		).toBe(false);
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('restored replica rejects a stale accepted receipt and enters recovery', async () => {
	const authorityState = openAuthority();
	const database = new Database(':memory:');
	try {
		const transport = createTransport(authorityState.authority);
		const replica = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(database),
			transport,
		});
		const replicaId = database
			.query<{ replica_id: string }, []>('SELECT replica_id FROM replica')
			.get()?.replica_id;
		if (!replicaId) throw new Error('Expected a durable replica identity');
		const foreign = [createRow(ROW_A, 'foreign')];
		const foreignAccepted = authorityState.authority.push({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'push',
			replicaId,
			round: 1,
			requestDigest: rowRoundDigest(foreign),
			intents: foreign,
		});
		if (foreignAccepted.result !== 'accepted') {
			throw new Error('Expected the foreign first round to be accepted');
		}
		transport.push = async (request) => {
			transport.pushRequests.push(structuredClone(request));
			return foreignAccepted;
		};

		replica.admit(createRow(ROW_B, 'local remains'));
		await expect(replica.synchronizeOnce()).resolves.toEqual({
			outcome: 'recovery-required',
			reason: 'lineage-mismatch',
		});
		expect(replica.readCurrentRow('notes', ROW_B)).toEqual({
			title: 'local remains',
		});
		expect(transport.pushRequests).toHaveLength(1);
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('old-major first push parks networking as upgrade-required', async () => {
	const database = new Database(':memory:');
	const transport: CurrentStateReplicaTransport = {
		async push() {
			return { result: 'protocol-mismatch' };
		},
		async pull() {
			return { result: 'protocol-mismatch' };
		},
		async acquire() {
			return { result: 'protocol-mismatch' };
		},
	};
	try {
		const replica = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(database),
			transport,
		});
		replica.admit(createRow(ROW_A, 'local survives'));
		await expect(replica.synchronizeOnce()).resolves.toEqual({
			outcome: 'upgrade-required',
		});
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: { set: { afterUpgrade: true }, unset: [] },
		});
		expect(replica.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'local survives',
			afterUpgrade: true,
		});
	} finally {
		database.close();
	}
});

test('push, pull, and acquire protocol mismatches all require upgrade', async () => {
	for (const operation of ['push', 'pull', 'acquire'] as const) {
		const authorityState = openAuthority();
		const base = createTransport(authorityState.authority);
		const database = new Database(':memory:');
		const transport: CurrentStateReplicaTransport = {
			push: base.push,
			pull: base.pull,
			acquire: base.acquire,
		};
		switch (operation) {
			case 'push':
				transport.push = async () => ({ result: 'protocol-mismatch' });
				break;
			case 'pull':
				transport.pull = async () => ({ result: 'protocol-mismatch' });
				break;
			case 'acquire':
				transport.pull = async (request) => {
					return {
						result: 'acquisition-required',
						receipt: {
							acceptedRound: 0,
							requestDigest: null,
							appliedThrough: 0,
						},
						retentionFloor: 0,
					};
				};
				transport.acquire = async () => ({ result: 'protocol-mismatch' });
				break;
			default:
				operation satisfies never;
		}
		try {
			const replica = createCurrentStateReplica({
				sqlite: createBunSqliteAdapter(database),
				transport,
			});
			if (operation === 'push') replica.admit(createRow(ROW_A, 'pending'));
			await expect(replica.synchronizeOnce()).resolves.toEqual({
				outcome: 'upgrade-required',
			});
			if (operation === 'acquire') {
				expect(
					database
						.query<{ name: string }, []>(
							`SELECT name FROM sqlite_master
							 WHERE type = 'table'
							   AND name LIKE 'acquisition_scratch_%'`,
						)
						.all(),
				).toEqual([]);
			}
		} finally {
			database.close();
			authorityState.database.close();
		}
	}
});

test('same-address compaction preserves birth and advances only changed desired state', () => {
	const { database, replica, dispose } = setup();
	try {
		replica.admit(createRow(ROW_A, 'one'));
		expect(replica.captureAdmissionCut()).toBe(1);
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: { set: { title: 'two' }, unset: [] },
		});
		expect(replica.captureAdmissionCut()).toBe(2);
		expect(
			database
				.query<{ birth_sequence: number }, []>(
					'SELECT birth_sequence FROM intents',
				)
				.get()?.birth_sequence,
		).toBe(1);

		// The projected title already equals this desired state.
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: { set: { title: 'two' }, unset: [] },
		});
		expect(replica.captureAdmissionCut()).toBe(2);

		replica.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
		expect(replica.captureAdmissionCut()).toBe(3);
		expect(database.query('SELECT * FROM intents').all()).toEqual([]);
		expect(replica.readCurrentRow('notes', ROW_A)).toBeUndefined();
	} finally {
		dispose();
	}
});

test('lost accepted response retries immutable intent while the edit stays visible', async () => {
	const authorityState = openAuthority();
	const base = createTransport(authorityState.authority);
	let loseAcceptedResponse = true;
	const transport: CurrentStateReplicaTransport = {
		pull: base.pull,
		acquire: base.acquire,
		async push(request) {
			const response = await base.push(request);
			if (loseAcceptedResponse) {
				loseAcceptedResponse = false;
				throw new Error('accepted response was lost');
			}
			return response;
		},
	};
	const database = new Database(':memory:');
	try {
		const replica = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(database),
			transport,
		});
		replica.admit(createRow(ROW_A, 'visible'));
		await expect(replica.synchronizeOnce()).rejects.toThrow(
			'accepted response was lost',
		);
		expect(replica.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'visible',
		});
		expect(
			database.query<{ sealed: number }, []>('SELECT sealed FROM intents').get()
				?.sealed,
		).toBe(1);

		const reopened = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(database),
			transport: base,
		});
		await reopened.synchronizeOnce();
		expect(base.pushRequests).toHaveLength(2);
		expect(base.pushRequests[0]?.requestDigest).toBe(
			base.pushRequests[1]?.requestDigest,
		);
		expect(base.pushRequests[0]?.intents).toEqual(
			base.pushRequests[1]?.intents,
		);
		expect(reopened.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'visible',
		});
		expect(reopened.status()).toMatchObject({
			pendingIntents: 0,
			hasSealed: false,
		});
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('push acceptance alone never removes the visible sealed overlay', async () => {
	const authorityState = openAuthority();
	const base = createTransport(authorityState.authority);
	let failFirstPull = true;
	const transport: CurrentStateReplicaTransport = {
		push: base.push,
		acquire: base.acquire,
		async pull(request) {
			if (failFirstPull) {
				failFirstPull = false;
				throw new Error('pull interrupted after acceptance');
			}
			return base.pull(request);
		},
	};
	const database = new Database(':memory:');
	try {
		const replica = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(database),
			transport,
		});
		replica.admit(createRow(ROW_A, 'still visible'));
		await expect(replica.synchronizeOnce()).rejects.toThrow(
			'pull interrupted after acceptance',
		);
		expect(replica.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'still visible',
		});
		expect(replica.status()).toMatchObject({
			pendingIntents: 1,
			hasSealed: true,
		});
		await replica.synchronizeOnce();
		expect(replica.status()).toMatchObject({
			pendingIntents: 0,
			hasSealed: false,
		});
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('fresh floor-zero replica completes through ordinary pull without acquisition', async () => {
	const authorityState = openAuthority();
	const writerDatabase = new Database(':memory:');
	const readerDatabase = new Database(':memory:');
	try {
		const writer = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(writerDatabase),
			transport: createTransport(authorityState.authority),
		});
		writer.admit(createRow(ROW_A, 'already remote'));
		await settleCut(writer, writer.captureAdmissionCut());

		const readerTransport = createTransport(authorityState.authority);
		const reader = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(readerDatabase),
			transport: readerTransport,
		});
		const readerReplicaId = readerDatabase
			.query<{ replica_id: string }, []>('SELECT replica_id FROM replica')
			.get()?.replica_id;
		if (!readerReplicaId) throw new Error('Expected durable reader replica id');
		await reader.synchronizeOnce();
		expect(reader.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'already remote',
		});
		expect(readerTransport.acquireRequests).toEqual([]);
		expect(readerTransport.pushRequests).toEqual([]);
		expect(authorityState.authority.hasReplica(readerReplicaId)).toBe(false);
		expect(
			readerDatabase
				.query<{ acquired: number }, []>('SELECT acquired FROM replica')
				.get()?.acquired,
		).toBe(1);
	} finally {
		writerDatabase.close();
		readerDatabase.close();
		authorityState.database.close();
	}
});

test('moving current rows and deletions install monotonically', async () => {
	const authorityState = openAuthority();
	const writerDatabase = new Database(':memory:');
	const readerDatabase = new Database(':memory:');
	try {
		const writer = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(writerDatabase),
			transport: createTransport(authorityState.authority),
		});
		writer.admit(createRow(ROW_A, 'remove'));
		writer.admit(createRow(ROW_B, 'initial'));
		await settleCut(writer, writer.captureAdmissionCut());

		const base = createTransport(authorityState.authority);
		let moved = false;
		const readerTransport: CurrentStateReplicaTransport = {
			push: base.push,
			acquire: base.acquire,
			async pull(request) {
				const response = parsePullResponse(await base.pull(request));
				if (!moved && request.through === undefined) {
					moved = true;
					writer.admit({
						kind: 'update',
						table: 'notes',
						rowId: ROW_B,
						fields: { set: { title: 'moved' }, unset: [] },
					});
					await settleCut(writer, writer.captureAdmissionCut());
					writer.admit({
						kind: 'delete',
						table: 'notes',
						rowId: ROW_A,
					});
					await settleCut(writer, writer.captureAdmissionCut());
				}
				return response;
			},
		};
		const deleted: { table: string; rowId: string }[] = [];
		const reader = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(readerDatabase),
			transport: readerTransport,
			pageLimit: 1,
			onRowsDeleted: (addresses) => deleted.push(...addresses),
		});

		await reader.synchronizeOnce();
		// Marker 2 selected the newer scalar postimage beyond fixed head 2.
		expect(reader.readCurrentRow('notes', ROW_B)).toEqual({ title: 'moved' });
		await reader.synchronizeOnce();
		expect(reader.readCurrentRow('notes', ROW_A)).toBeUndefined();
		expect(deleted).toContainEqual({ table: 'notes', rowId: ROW_A });
		expect(
			readerDatabase
				.query<{ row_id: string; installed_sequence: number }, []>(
					'SELECT row_id, installed_sequence FROM installed_guards',
				)
				.all(),
		).toEqual([
			{ row_id: ROW_A, installed_sequence: 4 },
			{ row_id: ROW_B, installed_sequence: 3 },
		]);
	} finally {
		writerDatabase.close();
		readerDatabase.close();
		authorityState.database.close();
	}
});

test('beyond-floor acquisition removes remotely deleted rows and revokes documents', async () => {
	const authorityState = openAuthority();
	const writerDatabase = new Database(':memory:');
	const readerDatabase = new Database(':memory:');
	try {
		const writer = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(writerDatabase),
			transport: createTransport(authorityState.authority),
		});
		writer.admit(createRow(ROW_A, 'remote'));
		await settleCut(writer, writer.captureAdmissionCut());

		const deleted: { table: string; rowId: string }[] = [];
		const reader = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(readerDatabase),
			transport: createTransport(authorityState.authority),
			onRowsDeleted: (addresses) => deleted.push(...addresses),
		});
		await reader.synchronizeOnce();
		expect(reader.readCurrentRow('notes', ROW_A)).toEqual({ title: 'remote' });

		writer.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
		await settleCut(writer, writer.captureAdmissionCut());
		authorityState.authority.compactThrough(2);

		await reader.synchronizeOnce();
		expect(reader.readCurrentRow('notes', ROW_A)).toBeUndefined();
		expect(deleted).toEqual([{ table: 'notes', rowId: ROW_A }]);
	} finally {
		writerDatabase.close();
		readerDatabase.close();
		authorityState.database.close();
	}
});

test('pending create survives complete acquisition', async () => {
	const authorityState = openAuthority();
	const writerDatabase = new Database(':memory:');
	const readerDatabase = new Database(':memory:');
	try {
		const writer = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(writerDatabase),
			transport: createTransport(authorityState.authority),
		});
		writer.admit(createRow(ROW_A, 'remote'));
		await settleCut(writer, writer.captureAdmissionCut());

		const base = createTransport(authorityState.authority);
		let reader: CurrentStateReplica;
		let admittedDuringGap = false;
		const transport: CurrentStateReplicaTransport = {
			push: base.push,
			acquire: base.acquire,
			async pull(request) {
				const response = parsePullResponse(await base.pull(request));
				if (response.result === 'acquisition-required' && !admittedDuringGap) {
					admittedDuringGap = true;
					reader.admit(createRow(ROW_B, 'pending local'));
				}
				return response;
			},
		};
		reader = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(readerDatabase),
			transport,
		});
		await reader.synchronizeOnce();

		writer.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
		await settleCut(writer, writer.captureAdmissionCut());
		authorityState.authority.compactThrough(2);
		await reader.synchronizeOnce();

		expect(reader.readCurrentRow('notes', ROW_B)).toEqual({
			title: 'pending local',
		});
		expect(reader.status().pendingIntents).toBe(1);
	} finally {
		writerDatabase.close();
		readerDatabase.close();
		authorityState.database.close();
	}
});

test('pending update to a remotely deleted row does not resurrect it', async () => {
	const authorityState = openAuthority();
	const writerDatabase = new Database(':memory:');
	const readerDatabase = new Database(':memory:');
	try {
		const writer = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(writerDatabase),
			transport: createTransport(authorityState.authority),
		});
		writer.admit(createRow(ROW_A, 'remote'));
		await settleCut(writer, writer.captureAdmissionCut());

		const base = createTransport(authorityState.authority);
		let reader: CurrentStateReplica;
		let admittedDuringGap = false;
		const transport: CurrentStateReplicaTransport = {
			push: base.push,
			acquire: base.acquire,
			async pull(request) {
				const response = parsePullResponse(await base.pull(request));
				if (response.result === 'acquisition-required' && !admittedDuringGap) {
					admittedDuringGap = true;
					reader.admit({
						kind: 'update',
						table: 'notes',
						rowId: ROW_A,
						fields: { set: { title: 'must not return' }, unset: [] },
					});
				}
				return response;
			},
		};
		reader = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(readerDatabase),
			transport,
		});
		await reader.synchronizeOnce();

		writer.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
		await settleCut(writer, writer.captureAdmissionCut());
		authorityState.authority.compactThrough(2);
		await reader.synchronizeOnce();
		expect(reader.readCurrentRow('notes', ROW_A)).toBeUndefined();
		expect(reader.status().pendingIntents).toBe(1);

		await settleCut(reader, reader.captureAdmissionCut());
		expect(reader.readCurrentRow('notes', ROW_A)).toBeUndefined();
		expect(reader.status().pendingIntents).toBe(0);
		const acquired = authorityState.authority.acquire({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'acquire',
			replicaId: 'zzzzzzzzzzzzzzzzzzzzzzzz',
		});
		if (acquired.result !== 'page')
			throw new Error('Expected acquisition page');
		expect(acquired.rows).toEqual([]);
	} finally {
		writerDatabase.close();
		readerDatabase.close();
		authorityState.database.close();
	}
});

test('floor-raced acquisition restarts and preserves accepted local overlay', async () => {
	const authorityState = openAuthority();
	const seederDatabase = new Database(':memory:');
	const offlineDatabase = new Database(':memory:');
	try {
		const seeder = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(seederDatabase),
			transport: createTransport(authorityState.authority),
		});
		for (const [rowId, title] of [
			[ROW_A, 'a'],
			[ROW_B, 'b'],
			[ROW_C, 'c'],
		] as const) {
			seeder.admit(createRow(rowId, title));
		}
		await settleCut(seeder, seeder.captureAdmissionCut());

		const base = createTransport(authorityState.authority);
		let acquisitionStarts = 0;
		let raceInjected = false;
		const offlineTransport: CurrentStateReplicaTransport = {
			push: base.push,
			pull: base.pull,
			async acquire(request) {
				if (request.afterAddress === undefined) acquisitionStarts += 1;
				const response = await base.acquire(request);
				if (!raceInjected && request.afterAddress === undefined) {
					raceInjected = true;
					seeder.admit({
						kind: 'update',
						table: 'notes',
						rowId: ROW_A,
						fields: { set: { title: 'after anchor' }, unset: [] },
					});
					await settleCut(seeder, seeder.captureAdmissionCut());
					authorityState.authority.compactThrough(
						authorityState.database
							.query<{ server_sequence: number }, []>(
								'SELECT server_sequence FROM row_authority_meta',
							)
							.get()?.server_sequence ?? 0,
					);
				}
				return response;
			},
		};
		let promotions = 0;
		const offline = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(offlineDatabase),
			transport: offlineTransport,
			acquirePageLimit: 1,
			onAcquisitionPromoted: () => {
				promotions += 1;
			},
		});
		// Floor zero bootstraps with the ordinary current-state pull.
		await offline.synchronizeOnce();
		seeder.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_B,
			fields: { set: { title: 'advanced while offline' }, unset: [] },
		});
		await settleCut(seeder, seeder.captureAdmissionCut());
		authorityState.authority.compactThrough(4);

		offline.admit(createRow(ROW_D, 'offline local'));
		const cut = offline.captureAdmissionCut();
		await settleCut(offline, cut);
		expect(acquisitionStarts).toBeGreaterThanOrEqual(2);
		expect(promotions).toBe(1);
		expect(offline.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'after anchor',
		});
		expect(offline.readCurrentRow('notes', ROW_D)).toEqual({
			title: 'offline local',
		});
		expect(offline.status()).toMatchObject({
			pendingIntents: 0,
			hasSealed: false,
		});
		expect(
			offlineDatabase
				.query<{ name: string }, []>(
					`SELECT name FROM sqlite_master
					 WHERE type = 'table' AND name LIKE 'acquisition_scratch_%'`,
				)
				.all(),
		).toEqual([]);
	} finally {
		seederDatabase.close();
		offlineDatabase.close();
		authorityState.database.close();
	}
});

test('lineage mismatch preserves recovery data and a fresh lineage registers', async () => {
	const { authorityState, database, replica, dispose } = setup();
	try {
		expect(replica.captureRecovery()).toBeNull();
		replica.admit(createRow(ROW_A, 'initial'));
		await settleCut(replica, replica.captureAdmissionCut());
		const replicaId = database
			.query<{ replica_id: string }, []>('SELECT replica_id FROM replica')
			.get()?.replica_id;
		if (!replicaId) throw new Error('Expected durable replica id');
		const divergent: CurrentStateWireRowIntent[] = [createRow(ROW_B, 'clone')];
		expect(
			authorityState.authority.push({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'push',
				replicaId,
				round: 2,
				requestDigest: rowRoundDigest(divergent),
				intents: divergent,
			}).result,
		).toBe('accepted');

		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: { set: { title: 'ambiguous local' }, unset: [] },
		});
		await expect(replica.synchronizeOnce()).resolves.toEqual({
			outcome: 'recovery-required',
			reason: 'lineage-mismatch',
		});
		expect(replica.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'ambiguous local',
		});
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: { set: { localOnly: true }, unset: [] },
		});
		expect(replica.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'ambiguous local',
			localOnly: true,
		});
		expect(replica.status()).toMatchObject({ isRecoveryRequired: true });
		expect(replica.captureRecovery()).toEqual({
			rows: [
				{
					table: 'notes',
					rowId: ROW_A,
					fields: { title: 'ambiguous local', localOnly: true },
				},
			],
			kv: {},
		});

		replica.startFreshLineage();
		const freshReplicaId = database
			.query<{ replica_id: string }, []>('SELECT replica_id FROM replica')
			.get()?.replica_id;
		expect(freshReplicaId).not.toBe(replicaId);
		expect(replica.status()).toMatchObject({
			isAcquired: false,
			isRecoveryRequired: false,
		});
		await expect(replica.synchronizeOnce()).resolves.toEqual({
			outcome: 'caught-up',
		});
		expect(replica.status()).toMatchObject({
			isAcquired: true,
			isRecoveryRequired: false,
		});
		expect(replica.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'initial',
		});
		expect(replica.readCurrentRow('notes', ROW_B)).toEqual({ title: 'clone' });
	} finally {
		dispose();
	}
});

test('opening the new synchronized owner resets old canonical storage and stale scratch', () => {
	const authorityState = openAuthority();
	const database = new Database(':memory:');
	try {
		database.run(`
			CREATE TABLE rows(table_key TEXT, row_id TEXT, fields_json TEXT);
			CREATE TABLE documents(table_key TEXT, row_id TEXT, yjs_state BLOB);
			CREATE TABLE intents(table_key TEXT, row_id TEXT, sealed INTEGER);
			CREATE TABLE replica(id INTEGER PRIMARY KEY, replica_id TEXT);
			PRAGMA user_version = 1;
		`);
		database.run(`INSERT INTO rows VALUES ('notes', ?, '{"old":true}')`, [
			ROW_A,
		]);
		const transport = createTransport(authorityState.authority);
		createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(database),
			transport,
		});
		expect(database.query('SELECT * FROM rows').all()).toEqual([]);
		expect(
			database.query<{ user_version: number }, []>('PRAGMA user_version').get()
				?.user_version,
		).toBe(4);

		database.run(`
			CREATE TABLE acquisition_scratch_rows(
				table_key TEXT, row_id TEXT, fields_json TEXT
			)
		`);
		createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(database),
			transport,
		});
		expect(
			database
				.query<{ name: string }, []>(
					`SELECT name FROM sqlite_master
					 WHERE type = 'table' AND name LIKE 'acquisition_scratch_%'`,
				)
				.all(),
		).toEqual([]);
	} finally {
		database.close();
		authorityState.database.close();
	}
});

function encodeDocumentText(text: string): Uint8Array {
	const document = new Y.Doc();
	try {
		document.get('editor').insert(0, text);
		return new Uint8Array(Y.encodeStateAsUpdateV2(document));
	} finally {
		document.destroy();
	}
}

/** Replica plus its co-located owner-side document log over one database. */
function setupWithDocuments(options?: {
	transport?: CurrentStateReplicaTransport;
	authorityState?: ReturnType<typeof openAuthority>;
}) {
	const authorityState = options?.authorityState ?? openAuthority();
	const database = new Database(':memory:');
	const sqlite = createBunSqliteAdapter(database);
	const documents = createSqliteDocumentLog({
		database: sqlite,
		isRowLive: ({ table, rowId }) =>
			replica.readCurrentRow(table, rowId) !== undefined,
	});
	const replica = createCurrentStateReplica({
		sqlite,
		transport: options?.transport ?? createTransport(authorityState.authority),
		documents,
	});
	return {
		authorityState,
		database,
		documents,
		replica,
		dispose() {
			database.close();
			if (options?.authorityState === undefined) {
				authorityState.database.close();
			}
		},
	};
}

test('locally admitted deletion removes the document log with the intent', () => {
	const { documents, replica, dispose } = setupWithDocuments();
	try {
		// The row exists only as a local create intent; a foreign key from a
		// confirmed rows table could never see it.
		replica.admit(createRow(ROW_A, 'intent only'));
		documents.append(
			{ table: 'notes', rowId: ROW_A },
			encodeDocumentText('draft'),
		);
		expect(documents.capture({ table: 'notes', rowId: ROW_A })).toBeInstanceOf(
			Uint8Array,
		);

		replica.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
		expect(documents.capture({ table: 'notes', rowId: ROW_A })).toBeUndefined();
		expect(() =>
			documents.append(
				{ table: 'notes', rowId: ROW_A },
				encodeDocumentText('late'),
			),
		).toThrow('absent row');
	} finally {
		dispose();
	}
});

test('canceling an open create keeps the document when confirmed state remains visible', () => {
	const { database, documents, replica, dispose } = setupWithDocuments();
	try {
		replica.admit(createRow(ROW_A, 'open create'));
		// Model confirmed state arriving below the still-open create. Deleting the
		// create cancels that intent and reveals this existing row; it does not end
		// the address's visible lifetime.
		database
			.query(
				'INSERT INTO rows(table_key, row_id, fields_json) VALUES (?, ?, ?)',
			)
			.run('notes', ROW_A, JSON.stringify({ title: 'confirmed' }));
		documents.append(
			{ table: 'notes', rowId: ROW_A },
			encodeDocumentText('must survive'),
		);

		replica.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });

		expect(replica.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'confirmed',
		});
		expect(documents.capture({ table: 'notes', rowId: ROW_A })).toBeInstanceOf(
			Uint8Array,
		);
	} finally {
		dispose();
	}
});

test('installed authority deletion markers remove the document log', async () => {
	const authorityState = openAuthority();
	const writerDatabase = new Database(':memory:');
	const reader = setupWithDocuments({ authorityState });
	try {
		const writer = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(writerDatabase),
			transport: createTransport(authorityState.authority),
		});
		writer.admit(createRow(ROW_A, 'shared'));
		await settleCut(writer, writer.captureAdmissionCut());

		await reader.replica.synchronizeOnce();
		reader.documents.append(
			{ table: 'notes', rowId: ROW_A },
			encodeDocumentText('reader content'),
		);

		writer.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
		await settleCut(writer, writer.captureAdmissionCut());
		await reader.replica.synchronizeOnce();

		expect(reader.replica.readCurrentRow('notes', ROW_A)).toBeUndefined();
		expect(
			reader.documents.capture({ table: 'notes', rowId: ROW_A }),
		).toBeUndefined();
	} finally {
		writerDatabase.close();
		reader.dispose();
	}
});

test('acquisition promotion removes vanished rows’ logs and keeps intent-only logs', async () => {
	const authorityState = openAuthority();
	const writerDatabase = new Database(':memory:');
	const reader = setupWithDocuments({ authorityState });
	try {
		const writer = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(writerDatabase),
			transport: createTransport(authorityState.authority),
		});
		writer.admit(createRow(ROW_A, 'confirmed'));
		await settleCut(writer, writer.captureAdmissionCut());

		await reader.replica.synchronizeOnce();
		reader.documents.append(
			{ table: 'notes', rowId: ROW_A },
			encodeDocumentText('confirmed doc'),
		);
		reader.replica.admit(createRow(ROW_B, 'pending create'));
		reader.documents.append(
			{ table: 'notes', rowId: ROW_B },
			encodeDocumentText('pending doc'),
		);

		writer.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
		await settleCut(writer, writer.captureAdmissionCut());
		authorityState.authority.compactThrough(2);

		await reader.replica.synchronizeOnce();
		expect(reader.replica.readCurrentRow('notes', ROW_A)).toBeUndefined();
		expect(
			reader.documents.capture({ table: 'notes', rowId: ROW_A }),
		).toBeUndefined();
		// The pending create is untouched by promotion; its document survives.
		expect(reader.replica.readCurrentRow('notes', ROW_B)).toEqual({
			title: 'pending create',
		});
		expect(
			reader.documents.capture({ table: 'notes', rowId: ROW_B }),
		).toBeInstanceOf(Uint8Array);
	} finally {
		writerDatabase.close();
		reader.dispose();
	}
});

test('acquisition keeps the document when a local create overlays a removed row', async () => {
	const authorityState = openAuthority();
	const writerDatabase = new Database(':memory:');
	const base = createTransport(authorityState.authority);
	let reader: ReturnType<typeof setupWithDocuments>;
	let admittedDuringAcquisition = false;
	const transport: CurrentStateReplicaTransport = {
		push: base.push,
		pull: base.pull,
		async acquire(request) {
			const response = await base.acquire(request);
			if (!admittedDuringAcquisition) {
				admittedDuringAcquisition = true;
				reader.replica.admit(createRow(ROW_A, 'local replacement'));
				reader.documents.append(
					{ table: 'notes', rowId: ROW_A },
					encodeDocumentText('local replacement doc'),
				);
			}
			return response;
		},
	};
	reader = setupWithDocuments({
		authorityState,
		transport,
	});
	try {
		const writer = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(writerDatabase),
			transport: createTransport(authorityState.authority),
		});
		writer.admit(createRow(ROW_A, 'confirmed'));
		await settleCut(writer, writer.captureAdmissionCut());
		authorityState.authority.compactThrough(1);
		await reader.replica.synchronizeOnce();
		expect(reader.replica.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'confirmed',
		});

		writer.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
		await settleCut(writer, writer.captureAdmissionCut());
		authorityState.authority.compactThrough(2);
		await reader.replica.synchronizeOnce();

		expect(reader.replica.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'local replacement',
		});
		expect(
			reader.documents.capture({ table: 'notes', rowId: ROW_A }),
		).toBeInstanceOf(Uint8Array);
	} finally {
		writerDatabase.close();
		reader.dispose();
	}
});

test('retiring a refused imported create removes its document with the scalar life', async () => {
	const authorityState = openAuthority();
	const writerDatabase = new Database(':memory:');
	const reader = setupWithDocuments({ authorityState });
	try {
		const writer = createCurrentStateReplica({
			sqlite: createBunSqliteAdapter(writerDatabase),
			transport: createTransport(authorityState.authority),
		});
		writer.admit(createRow(ROW_A, 'short lived'));
		await settleCut(writer, writer.captureAdmissionCut());
		await reader.replica.synchronizeOnce();
		writer.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
		await settleCut(writer, writer.captureAdmissionCut());
		await reader.replica.synchronizeOnce();

		// This is the Bun add-to-account ordering: scalar create first, then the
		// imported document. The authority retains the deletion marker and
		// silently refuses the stale preserved-id create.
		reader.replica.admit(createRow(ROW_A, 'imported'));
		reader.documents.append(
			{ table: 'notes', rowId: ROW_A },
			encodeDocumentText('imported doc'),
		);
		expect(
			reader.documents.capture({ table: 'notes', rowId: ROW_A }),
		).toBeInstanceOf(Uint8Array);

		await reader.replica.synchronizeOnce();

		expect(reader.replica.readCurrentRow('notes', ROW_A)).toBeUndefined();
		expect(
			reader.documents.capture({ table: 'notes', rowId: ROW_A }),
		).toBeUndefined();
	} finally {
		writerDatabase.close();
		reader.dispose();
	}
});

test('captureVisible folds compact document state and startFresh clears logs', async () => {
	const { authorityState, database, documents, replica, dispose } =
		setupWithDocuments();
	try {
		replica.admit(createRow(ROW_A, 'kept'));
		await settleCut(replica, replica.captureAdmissionCut());
		documents.append(
			{ table: 'notes', rowId: ROW_A },
			encodeDocumentText('captured content'),
		);

		const copy = replica.captureVisible();
		const captured = copy.rows[0]?.document;
		expect(captured).toBeInstanceOf(Uint8Array);
		const replay = new Y.Doc();
		try {
			Y.applyUpdateV2(replay, captured as Uint8Array);
			expect(replay.get('editor').toString()).toBe('captured content');
		} finally {
			replay.destroy();
		}

		// Force a lineage mismatch, then prove the fresh lineage clears logs.
		const replicaId = database
			.query<{ replica_id: string }, []>('SELECT replica_id FROM replica')
			.get()?.replica_id;
		if (!replicaId) throw new Error('Expected durable replica id');
		const divergent: CurrentStateWireRowIntent[] = [createRow(ROW_B, 'clone')];
		expect(
			authorityState.authority.push({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'push',
				replicaId,
				round: 2,
				requestDigest: rowRoundDigest(divergent),
				intents: divergent,
			}).result,
		).toBe('accepted');
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: { set: { title: 'diverged' }, unset: [] },
		});
		await expect(replica.synchronizeOnce()).resolves.toEqual({
			outcome: 'recovery-required',
			reason: 'lineage-mismatch',
		});
		// The recovery copy still folds locally durable document state.
		expect(replica.captureRecovery()?.rows[0]?.document).toBeInstanceOf(
			Uint8Array,
		);

		replica.startFreshLineage();
		expect(documents.capture({ table: 'notes', rowId: ROW_A })).toBeUndefined();
		expect(documents.load({ table: 'notes', rowId: ROW_A })).toEqual([]);
	} finally {
		dispose();
	}
});
