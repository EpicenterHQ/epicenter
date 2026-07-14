/**
 * Portable Tables Apply HTTP Integration Tests
 *
 * Verifies the complete local deployment path from an externally edited
 * portable SQLite file through the workspace HTTP client, authenticated Hono
 * route, and persistent Bun records authority.
 *
 * Key behaviors:
 * - Applying an export makes authority tables exactly match the SQLite file
 * - A concurrent authority write forces a fresh preview before admission
 * - The authenticated principal and generated workspace ID select persistence
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipalId } from '@epicenter/identity';
import { RECORD_SYNC_PROTOCOL_MAJOR } from '@epicenter/record-sync';
import {
	createHttpReplicaSyncPort,
	defineTable,
	defineWorkspace,
	field,
	lockWorkspace,
	WORKSPACE_VERSION_LOCK_FORMAT,
} from '@epicenter/workspace/sqlite';
import {
	applyPortableTables,
	exportPortableWorkspace,
	openStandaloneWorkspace,
	readPortableTables,
} from '@epicenter/workspace/sqlite/bun';
import { Hono } from 'hono';
import { createBunRecords } from '../records/bun.js';
import type { Env } from '../types.js';
import { mountRecordsApp } from './records.js';

const notes = defineTable({
	fields: {
		id: field.string(),
		title: field.string(),
	},
});
const candidate = defineWorkspace({
	appId: 'portable-http-test',
	version: 1,
	tables: { notes },
	kv: {},
});
const definition = lockWorkspace(candidate, {
	format: WORKSPACE_VERSION_LOCK_FORMAT,
	appId: candidate.appId,
	versions: [candidate.proposedLockEntry],
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-tables-http-'));
	const records = createBunRecords({
		dir: join(root, 'records'),
		sha256: async (value) => createHash('sha256').update(value).digest('hex'),
	});
	const app = new Hono<Env>();
	mountRecordsApp(app, {
		resolveRecords: () => records.records,
		auth: async (c, next) => {
			c.set('principal', { id: asPrincipalId('alice') });
			await next();
		},
	});
	const authority = createHttpReplicaSyncPort({
		baseUrl: 'https://epicenter.test',
		fetch: async (input, init) => app.request(input, init),
	});
	return {
		root,
		authority,
		cleanup() {
			records.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test('edited SQLite reaches exact authority state after a concurrent head move', async () => {
	const { root, authority, cleanup } = setup();
	const workspace = await openStandaloneWorkspace(definition, {
		storage: { kind: 'memory' },
		onObserverError() {},
	});
	const exportDirectory = join(root, 'export');

	try {
		const retained = await workspace.tables.notes.create({ title: 'Original' });
		const removed = await workspace.tables.notes.create({ title: 'Remove me' });
		await exportPortableWorkspace(definition, workspace, {
			directory: exportDirectory,
		});
		const tablesPath = join(exportDirectory, 'tables.sqlite3');

		expect(
			await applyPortableTables(definition, {
				tablesPath,
				authority,
				confirm: () => true,
			}),
		).toEqual({ status: 'applied', head: 1 });

		const addedId = 'added-outside-epicenter';
		const sqlite = new Database(tablesPath);
		try {
			sqlite.run('UPDATE notes SET title = ? WHERE id = ?', [
				'Edited outside Epicenter',
				retained.id,
			]);
			sqlite.run('DELETE FROM notes WHERE id = ?', [removed.id]);
			sqlite.run('INSERT INTO notes (id, title) VALUES (?, ?)', [
				addedId,
				'Added outside Epicenter',
			]);
		} finally {
			sqlite.close();
		}

		const opened = await authority.openAuthority({
			workspaceId: definition.workspaceId,
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			recordsDescriptor: definition.recordsDescriptor,
			recordsSchemaHash: definition.recordsSchemaHash,
		});
		if (
			typeof opened !== 'object' ||
			opened === null ||
			typeof (opened as { recordsEpoch?: unknown }).recordsEpoch !== 'string'
		) {
			throw new Error('Expected the authority records epoch');
		}
		const recordsEpoch = (opened as { recordsEpoch: string }).recordsEpoch;
		const reviews: Array<{ head: number; before: unknown }> = [];
		expect(
			await applyPortableTables(definition, {
				tablesPath,
				authority,
				async confirm(plan, head) {
					reviews.push({
						head,
						before: plan.updates[0]?.changes.title?.before,
					});
					if (reviews.length === 1) {
						expect(
							await authority.applyTables({
								kind: 'tablesApply',
								protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
								recordsEpoch,
								expectedHead: head,
								operations: [
									{
										kind: 'updateRow',
										table: 'notes',
										rowId: retained.id,
										cells: { title: 'Concurrent authority edit' },
									},
								],
							}),
						).toEqual({ kind: 'tablesApply', ok: true, newHead: 2 });
					}
					return true;
				},
			}),
		).toEqual({ status: 'applied', head: 3 });

		expect(reviews).toEqual([
			{ head: 1, before: 'Original' },
			{ head: 2, before: 'Concurrent authority edit' },
		]);
		const finalState = await authority.readTablesState({
			kind: 'tablesState',
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			recordsEpoch,
		});
		expect(finalState).toEqual({
			kind: 'tablesState',
			ok: true,
			head: 3,
			rows: [...readPortableTables(definition, tablesPath)],
		});
	} finally {
		await workspace[Symbol.asyncDispose]();
		cleanup();
	}
});
