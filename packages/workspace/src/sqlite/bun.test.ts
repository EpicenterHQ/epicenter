import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { field } from '@epicenter/field';
import {
	createRecordAuthority,
	RECORD_SYNC_PROTOCOL_MAJOR,
} from '@epicenter/record-sync';
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import { openStandaloneWorkspace, openWorkspaceReplica } from './bun.js';
import {
	defineTable,
	defineWorkspace as defineWorkspaceCandidate,
	type WorkspaceDefinition,
} from './definition.js';
import { defineTestWorkspace as defineWorkspace } from './test-workspace.js';

test('Bun refuses unlocked definitions before creating storage', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-sqlite-forged-'));
	const path = join(directory, 'forged.db');
	const candidate = defineWorkspaceCandidate({
		appId: 'bun-unlocked-test',
		dataVersion: 1,
		tables: {
			notes: defineTable({ fields: { id: field.string() } }),
		},
	});

	try {
		await expect(
			openStandaloneWorkspace(
				candidate as unknown as WorkspaceDefinition<typeof candidate.tables>,
				{
					storage: { kind: 'bun', path },
					onObserverError() {},
				},
			),
		).rejects.toThrow('must be returned by lockWorkspace()');
		expect(existsSync(path)).toBe(false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Bun reopens a valid initialized database with no user rows', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-sqlite-empty-'));
	const path = join(directory, 'workspace.db');
	const definition = defineWorkspace({
		appId: 'bun-empty-test',
		tables: {
			notes: defineTable({
				fields: { id: field.string(), title: field.string() },
			}),
		},
	});

	try {
		const first = await openStandaloneWorkspace(definition, {
			storage: { kind: 'bun', path },
			onObserverError() {},
		});
		expect(await first.tables.notes.count()).toBe(0);
		await first[Symbol.asyncDispose]();

		const reopened = await openStandaloneWorkspace(definition, {
			storage: { kind: 'bun', path },
			onObserverError() {},
		});
		expect(await reopened.tables.notes.count()).toBe(0);
		await reopened[Symbol.asyncDispose]();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Bun standalone workspace persists typed rows across service lifecycles', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-sqlite-'));
	const path = join(directory, 'workspace.db');
	const definition = defineWorkspace({
		appId: 'bun-local-test',
		name: 'Bun local test',
		tables: {
			notes: defineTable({
				fields: { id: field.string(), title: field.string() },
			}),
		},
	});
	const errors: unknown[] = [];

	try {
		const first = await openStandaloneWorkspace(definition, {
			storage: { kind: 'bun', path },
			onObserverError: (error) => errors.push(error),
		});
		const note = await first.tables.notes.create({ title: 'Persisted' });
		await expect(
			openStandaloneWorkspace(definition, {
				storage: { kind: 'bun', path },
				onObserverError: (error) => errors.push(error),
			}),
		).rejects.toThrow('already has an owner');
		await first[Symbol.asyncDispose]();

		const mismatched = defineWorkspace({
			appId: 'bun-local-test',
			name: 'Bun local test',
			tables: {
				notes: defineTable({
					fields: {
						id: field.string(),
						title: field.string(),
						body: field.string(),
					},
				}),
			},
		});
		await expect(
			openStandaloneWorkspace(mismatched, {
				storage: { kind: 'bun', path },
				onObserverError: (error) => errors.push(error),
			}),
		).rejects.toThrow('schema hash does not match');

		const reopened = await openStandaloneWorkspace(definition, {
			storage: { kind: 'bun', path },
			onObserverError: (error) => errors.push(error),
		});
		expect(await reopened.tables.notes.get(note.id)).toEqual({
			id: note.id,
			title: 'Persisted',
		});
		await reopened[Symbol.asyncDispose]();
		expect(errors).toEqual([]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Bun workspace replicas synchronize automatically through one authority', async () => {
	const definition = defineWorkspace({
		appId: 'bun-replica-test',
		name: 'Bun replica test',
		tables: {
			notes: defineTable({
				fields: { id: field.string(), title: field.string() },
			}),
		},
	});
	const authorityDatabase = new Database(':memory:');
	const recordsEpoch = 'bun-replica-epoch';
	const envelope = {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		recordsEpoch,
	};
	const authority = createRecordAuthority({
		database: createBunSqliteAdapter(authorityDatabase),
		identity: {
			...envelope,
			recordsDescriptor: definition.recordsDescriptor,
			recordsSchemaHash: definition.recordsSchemaHash,
		},
		sha256: async (value) => createHash('sha256').update(value).digest('hex'),
	});
	const sync = {
		bindWorkspace() {},
		async openAuthority() {
			return {
				recordsEpoch,
				recordsDescriptor: definition.recordsDescriptor,
				recordsSchemaHash: definition.recordsSchemaHash,
			};
		},
		async push(request: Parameters<typeof authority.push>[0]) {
			return authority.push(request);
		},
		async pull(request: Parameters<typeof authority.pull>[0]) {
			return authority.pull(request);
		},
		async snapshotChunk(
			request: Parameters<typeof authority.snapshotChunk>[0],
		) {
			return authority.snapshotChunk(request);
		},
	};
	const syncErrors: unknown[] = [];
	const first = await openWorkspaceReplica(definition, {
		storage: { kind: 'memory' },
		sync,
		onSyncError: (error) => syncErrors.push(error),
		onObserverError: (error) => syncErrors.push(error),
		pollIntervalMs: 5,
	});
	const second = await openWorkspaceReplica(definition, {
		storage: { kind: 'memory' },
		sync,
		onSyncError: (error) => syncErrors.push(error),
		onObserverError: (error) => syncErrors.push(error),
		pollIntervalMs: 5,
	});

	try {
		const note = await first.tables.notes.create({ title: 'Automatic' });
		await waitUntil(
			async () =>
				(await second.tables.notes.get(note.id))?.title === 'Automatic',
		);
		expect(second.kind).toBe('replica');
		expect(syncErrors).toEqual([]);
	} finally {
		await first[Symbol.asyncDispose]();
		await second[Symbol.asyncDispose]();
		authorityDatabase.close();
	}
});

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await check()) return;
		await Bun.sleep(5);
	}
	throw new Error('Timed out waiting for replica convergence');
}
