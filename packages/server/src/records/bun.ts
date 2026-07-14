import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	openRecordAuthority,
	type RecordAuthority,
	restoreRecordAuthority,
	type Sha256,
} from '@epicenter/record-sync';
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import { RECORDS_COMPACTION_POLICY } from './compaction.js';
import type { Records, RecordsPartition } from './contracts.js';

type OpenAuthority = {
	database: Database;
	authority: RecordAuthority;
	compaction?: Promise<void>;
};

function partitionKey({ principalId, workspaceId }: RecordsPartition): string {
	return JSON.stringify([principalId, workspaceId]);
}

function databaseFilename(partition: RecordsPartition): string {
	return `${createHash('sha256').update(partitionKey(partition)).digest('hex')}.sqlite`;
}

/** Open the persistent Bun record authorities rooted in one deployment directory. */
export function createBunRecords({
	dir,
	sha256,
}: {
	dir: string;
	sha256: Sha256;
}) {
	mkdirSync(dir, { recursive: true });
	const authorities = new Map<string, OpenAuthority>();
	let isClosed = false;

	function load(partition: RecordsPartition): OpenAuthority {
		if (isClosed) throw new Error('Bun records backend is closed');
		const key = partitionKey(partition);
		const cached = authorities.get(key);
		if (cached) return cached;

		const database = new Database(join(dir, databaseFilename(partition)), {
			create: true,
			strict: true,
		});
		try {
			const restored = restoreRecordAuthority({
				database: createBunSqliteAdapter(database),
				sha256,
			});
			if (!restored)
				throw new Error(
					'Records workspace must be opened before synchronization',
				);
			const opened = { database, authority: restored.authority };
			authorities.set(key, opened);
			return opened;
		} catch (error) {
			database.close();
			throw error;
		}
	}

	async function compact(opened: OpenAuthority): Promise<void> {
		const compaction = (opened.compaction ?? Promise.resolve())
			.catch(() => {})
			.then(() =>
				opened.authority.maybePublishSnapshot(RECORDS_COMPACTION_POLICY),
			)
			.then(() => {})
			.catch(() => {});
		opened.compaction = compaction;
		try {
			await compaction;
		} finally {
			if (opened.compaction === compaction) opened.compaction = undefined;
		}
	}

	const records: Records = {
		async open(partition, request) {
			if (isClosed) throw new Error('Bun records backend is closed');
			const key = partitionKey(partition);
			const cached = authorities.get(key);
			if (cached) {
				const opened = openRecordAuthority({
					database: createBunSqliteAdapter(cached.database),
					request,
					sha256,
				});
				if (!opened.ok) return opened;
				cached.authority = opened.authority;
				return {
					ok: true,
					recordsEpoch: opened.recordsEpoch,
					recordsDescriptor: opened.recordsDescriptor,
					recordsSchemaHash: opened.recordsSchemaHash,
				};
			}
			const database = new Database(join(dir, databaseFilename(partition)), {
				create: true,
				strict: true,
			});
			try {
				const opened = openRecordAuthority({
					database: createBunSqliteAdapter(database),
					request,
					sha256,
				});
				if (!opened.ok) {
					database.close();
					return opened;
				}
				authorities.set(key, {
					database,
					authority: opened.authority,
				});
				return {
					ok: true,
					recordsEpoch: opened.recordsEpoch,
					recordsDescriptor: opened.recordsDescriptor,
					recordsSchemaHash: opened.recordsSchemaHash,
				};
			} catch (error) {
				database.close();
				throw error;
			}
		},
		async push(partition, request) {
			const opened = load(partition);
			const response = opened.authority.push(request);
			if (response.ok) await compact(opened);
			return response;
		},
		async pull(partition, request) {
			return load(partition).authority.pull(request);
		},
		async snapshotChunk(partition, request) {
			return load(partition).authority.snapshotChunk(request);
		},
		async readTablesState(partition, request) {
			return load(partition).authority.readTablesState(request);
		},
		async applyTables(partition, request) {
			const opened = load(partition);
			const response = opened.authority.applyTables(request);
			if (response.ok) await compact(opened);
			return response;
		},
	};

	return {
		records,
		close(): void {
			if (isClosed) return;
			isClosed = true;
			for (const { database } of authorities.values()) database.close();
			authorities.clear();
		},
	};
}

export type BunRecords = ReturnType<typeof createBunRecords>;
