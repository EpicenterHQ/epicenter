/**
 * Bun Workspace Runtime Tests
 *
 * Verifies file-backed local persistence and the Bun runtime's current-state
 * synchronization wiring.
 *
 * Key behaviors:
 * - rows, KV, and row documents survive runtime close and reopen
 * - synchronized local writes reach an in-process workspace authority
 * - Account reset and synchronization never read or consume Device storage
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { defineTable, defineWorkspace } from '@epicenter/workspace/sqlite';
import {
	createAccountBunWorkspaceRuntime,
	createDeviceBunWorkspaceRuntime,
} from '@epicenter/workspace/sqlite/bun';
import { expectOk } from 'wellcrafted/testing';
import { accountStorageIdentity } from '../../../workspace/src/sqlite/account-runtime.js';
import type { CurrentStateReplicaTransport } from '../../../workspace/src/sqlite/current-state-replica.js';
import { CurrentStateTransportInterruption } from '../../../workspace/src/sqlite/current-state-transport.js';
import { initializeLocalWorkspaceStorage } from '../../../workspace/src/sqlite/local-workspace-storage.js';
import { openAccountRowAuthority } from './authority.js';

const definition = defineWorkspace({
	id: 'bun-test',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
	kv: {
		theme: field.select(['light', 'dark']),
		language: field.string(),
		deviceFlag: field.boolean(),
	},
});

function openAuthority() {
	const database = new Database(':memory:');
	const authority = openAccountRowAuthority({
		database: createBunSqliteAdapter(database),
	}).workspace('workspace');
	return { authority, database };
}

function createTransport(
	authority: ReturnType<typeof openAuthority>['authority'],
) {
	const requests = { push: 0, pull: 0, acquire: 0 };
	const transport: CurrentStateReplicaTransport = {
		async push(request) {
			requests.push += 1;
			return authority.push(request);
		},
		async pull(request) {
			requests.pull += 1;
			return authority.pull(request);
		},
		async acquire(request) {
			requests.acquire += 1;
			return authority.acquire(request);
		},
	};
	return { transport, requests };
}

test('local Bun runtime reopens durable rows, KV, and documents', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-runtime-'));
	try {
		let rowId = '';
		{
			await using runtime = createDeviceBunWorkspaceRuntime({
				workspacesRoot: root,
			});
			const workspace = await runtime.open(definition);
			const row = await workspace.tables.notes.create({ title: 'Durable' });
			rowId = row.id;
			expectOk(await workspace.kv.set('theme', 'dark'));
			using document = await workspace.tables.notes.document.open(row.id);
			document.get('editor').insert(0, 'persisted');
			await document.whenDurable();
		}

		await using reopened = createDeviceBunWorkspaceRuntime({
			workspacesRoot: root,
		});
		const workspace = await reopened.open(definition);
		expect(expectOk(await workspace.tables.notes.get(rowId))?.title).toBe(
			'Durable',
		);
		expect(expectOk(await workspace.kv.get('theme'))).toBe('dark');
		using document = await workspace.tables.notes.document.open(rowId);
		expect(document.get('editor').toString()).toBe('persisted');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('synchronized Bun runtime automatically pushes and pulls current state', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-sync-'));
	const authorityState = openAuthority();
	const { transport, requests } = createTransport(authorityState.authority);
	try {
		await using runtime = createAccountBunWorkspaceRuntime({
			workspacesRoot: root,
			account: {
				deploymentId: 'https://example.test',
				principalId: asPrincipalId('alice'),
				transport: () => transport,
			},
			recordPollIntervalMs: 60_000,
		});
		const workspace = await runtime.open(definition);
		const row = await workspace.tables.notes.create({ title: 'Synced' });
		expect(await workspace.sync?.settle()).toEqual({ outcome: 'caught-up' });
		await waitFor(() => authorityRows(authorityState.database).length === 1);
		expect(authorityRows(authorityState.database)[0]).toMatchObject({
			rowId: row.id,
			fields: { title: 'Synced' },
		});
		await workspace.tables.notes.delete(row.id);
		expect(await workspace.sync?.settle()).toEqual({ outcome: 'caught-up' });
		await waitFor(() => authorityRows(authorityState.database).length === 0);
		expect(requests.push).toBeGreaterThanOrEqual(2);
		expect(requests.pull).toBeGreaterThanOrEqual(2);
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('typed Bun transport interruption reports pending and retries automatically', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-retry-'));
	const authorityState = openAuthority();
	const base = createTransport(authorityState.authority).transport;
	let isFirstPush = true;
	const transport: CurrentStateReplicaTransport = {
		async push(request) {
			if (isFirstPush) {
				isFirstPush = false;
				throw new CurrentStateTransportInterruption(
					'offline',
					'network unavailable',
				);
			}
			return base.push(request);
		},
		pull: base.pull,
		acquire: base.acquire,
	};
	try {
		await using runtime = createAccountBunWorkspaceRuntime({
			workspacesRoot: root,
			account: {
				deploymentId: 'https://example.test',
				principalId: asPrincipalId('alice'),
				transport: () => transport,
			},
			recordPollIntervalMs: 60_000,
		});
		const workspace = await runtime.open(definition);
		const row = await workspace.tables.notes.create({
			title: 'Queued offline',
		});
		await waitFor(() => workspace.sync?.status.phase === 'pending');
		expect(workspace.sync?.status).toEqual({
			phase: 'pending',
			reason: 'offline',
		});
		expect(await workspace.sync?.settle()).toEqual({
			outcome: 'pending',
			reason: 'offline',
		});
		await waitFor(() =>
			authorityRows(authorityState.database).some(
				(authorityRow) => authorityRow.rowId === row.id,
			),
		);
		await waitFor(() => workspace.sync?.status.phase === 'caught-up');
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('protocol mismatch requires upgrade while local editing stays durable', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-upgrade-'));
	const mismatch = async () => ({ result: 'protocol-mismatch' as const });
	const transport: CurrentStateReplicaTransport = {
		push: mismatch,
		pull: mismatch,
		acquire: mismatch,
	};
	try {
		await using runtime = createAccountBunWorkspaceRuntime({
			workspacesRoot: root,
			account: {
				deploymentId: 'https://example.test',
				principalId: asPrincipalId('alice'),
				transport: () => transport,
			},
			recordPollIntervalMs: 60_000,
		});
		const workspace = await runtime.open(definition);
		await waitFor(() => workspace.sync?.status.phase === 'upgrade-required');
		const row = await workspace.tables.notes.create({ title: 'Needs upgrade' });

		expect(await workspace.sync?.settle()).toEqual({
			outcome: 'upgrade-required',
		});
		expect(expectOk(await workspace.tables.notes.get(row.id))?.title).toBe(
			'Needs upgrade',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('Account clean-break reset leaves Device storage untouched and unimported', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-account-reset-'));
	const authorityState = openAuthority();
	const { transport } = createTransport(authorityState.authority);
	const devicePath = deviceWorkspacePath(root);
	const account = {
		deploymentId: 'https://example.test',
		principalId: asPrincipalId('alice'),
		transport: () => transport,
	};
	const accountPath = join(
		root,
		'accounts',
		accountStorageIdentity(account).key,
		definition.id,
		'store.sqlite3',
	);
	try {
		let deviceRowId = '';
		{
			await using device = createDeviceBunWorkspaceRuntime({
				workspacesRoot: root,
			});
			const workspace = await device.open(definition);
			const row = await workspace.tables.notes.create({ title: 'Device' });
			deviceRowId = row.id;
			expectOk(await workspace.kv.set('theme', 'dark'));
			using document = await workspace.tables.notes.document.open(row.id);
			document.get('editor').insert(0, 'device draft');
			await document.whenDurable();
		}
		expect(existsSync(devicePath)).toBe(true);

		mkdirSync(
			join(
				root,
				'accounts',
				accountStorageIdentity(account).key,
				definition.id,
			),
			{ recursive: true },
		);
		{
			const legacyAccount = new Database(accountPath, { create: true });
			const sqlite = createBunSqliteAdapter(legacyAccount);
			initializeLocalWorkspaceStorage(sqlite);
			sqlite.run(
				`INSERT INTO rows(table_key, row_id, fields_json) VALUES (?, ?, ?)`,
				['notes', 'zzzzzzzzzzzzzzzzzzzzzzzz', '{"title":"Old Account"}'],
			);
			legacyAccount.close();
		}

		{
			await using accountRuntime = createAccountBunWorkspaceRuntime({
				workspacesRoot: root,
				account,
				recordPollIntervalMs: 60_000,
			});
			const accountWorkspace = await accountRuntime.open(definition);
			expect((await accountWorkspace.tables.notes.list()).rows).toEqual([]);
			expect(
				expectOk(await accountWorkspace.tables.notes.get(deviceRowId)),
			).toBeUndefined();

			await using deviceRuntime = createDeviceBunWorkspaceRuntime({
				workspacesRoot: root,
			});
			const deviceWorkspace = await deviceRuntime.open(definition);
			expect(
				expectOk(await deviceWorkspace.tables.notes.get(deviceRowId))?.title,
			).toBe('Device');
			expect(expectOk(await deviceWorkspace.kv.get('theme'))).toBe('dark');
			using document =
				await deviceWorkspace.tables.notes.document.open(deviceRowId);
			expect(document.get('editor').toString()).toBe('device draft');
		}

		const resetAccount = new Database(accountPath, { readonly: true });
		expect(
			resetAccount
				.query('SELECT * FROM rows WHERE row_id = ?')
				.all('zzzzzzzzzzzzzzzzzzzzzzzz'),
		).toEqual([]);
		expect(resetAccount.query('PRAGMA user_version').get()).not.toEqual({
			user_version: 1,
		});
		resetAccount.close();
		expect(existsSync(devicePath)).toBe(true);
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('explicit Add commits scalar Device data before explicit deletion', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-device-add-'));
	const authorityState = openAuthority();
	const { transport } = createTransport(authorityState.authority);
	try {
		await using device = createDeviceBunWorkspaceRuntime({
			workspacesRoot: root,
		});
		await using account = createAccountBunWorkspaceRuntime({
			workspacesRoot: root,
			account: {
				deploymentId: 'https://example.test',
				principalId: asPrincipalId('alice'),
				transport: () => transport,
			},
			recordPollIntervalMs: 60_000,
		});
		const deviceWorkspace = await device.open(definition);
		const accountWorkspace = await account.open(definition);
		const row = await deviceWorkspace.tables.notes.create({ title: 'Add me' });
		expectOk(await deviceWorkspace.kv.set('theme', 'dark'));

		const copy = await device.capture(definition);
		await account.add(definition, copy);
		expect(
			expectOk(await accountWorkspace.tables.notes.get(row.id))?.title,
		).toBe('Add me');
		expect(expectOk(await accountWorkspace.kv.get('theme'))).toBe('dark');

		await device.delete(definition);
		expect((await deviceWorkspace.tables.notes.list()).rows).toEqual([]);
		expect(expectOk(await deviceWorkspace.kv.get('theme'))).toBeUndefined();
		expect(await accountWorkspace.sync?.settle()).toEqual({
			outcome: 'caught-up',
		});
		expect(authorityRows(authorityState.database)).toContainEqual({
			rowId: row.id,
			fields: { title: 'Add me' },
		});
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('retrying add() stays idempotent while the destination holds the copied document open', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-add-retry-open-'));
	const authorityState = openAuthority();
	const { transport } = createTransport(authorityState.authority);
	try {
		await using device = createDeviceBunWorkspaceRuntime({
			workspacesRoot: root,
		});
		await using account = createAccountBunWorkspaceRuntime({
			workspacesRoot: root,
			account: {
				deploymentId: 'https://example.test',
				principalId: asPrincipalId('alice'),
				transport: () => transport,
			},
			recordPollIntervalMs: 60_000,
		});
		const deviceWorkspace = await device.open(definition);
		const accountWorkspace = await account.open(definition);
		const row = await deviceWorkspace.tables.notes.create({ title: 'Add me' });
		{
			using document = await deviceWorkspace.tables.notes.document.open(row.id);
			document.get('editor').insert(0, 'device body');
			await document.whenDurable();
		}
		const copy = await device.capture(definition);
		await account.add(definition, copy);

		// The documented recovery path for an interrupted copy is retry-add. A
		// destination that opened the imported document must not turn the retry
		// into a persistence-attachment conflict.
		using opened = await accountWorkspace.tables.notes.document.open(row.id);
		await account.add(definition, copy);
		expect(opened.get('editor').toString()).toBe('device body');
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a retained deletion marker silently refuses a copied create without resurrecting the row', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-add-marker-'));
	const authorityState = openAuthority();
	const { transport } = createTransport(authorityState.authority);
	try {
		await using account = createAccountBunWorkspaceRuntime({
			workspacesRoot: root,
			account: {
				deploymentId: 'https://example.test',
				principalId: asPrincipalId('alice'),
				transport: () => transport,
			},
			recordPollIntervalMs: 60_000,
		});
		const workspace = await account.open(definition);
		const doomed = await workspace.tables.notes.create({ title: 'Doomed' });
		expect(await workspace.sync?.settle()).toEqual({ outcome: 'caught-up' });
		await workspace.tables.notes.delete(doomed.id);
		expect(await workspace.sync?.settle()).toEqual({ outcome: 'caught-up' });

		// The authority silently refuses a create at a retained deletion marker.
		// The copy stays optional and the Device source remains by default
		// (ADR-0147), so the refused row is simply absent from the account; it
		// must not resurrect through the copy path.
		const conflicting = {
			rows: [
				{
					table: 'notes',
					rowId: doomed.id,
					fields: { title: 'Old Device copy' },
				},
			],
			kv: { language: 'copied' },
		};
		await account.add(definition, conflicting);
		expect(await workspace.sync?.settle()).toEqual({ outcome: 'caught-up' });
		expect((await workspace.tables.notes.get(doomed.id)).data).toBeUndefined();
		expect((await workspace.kv.get('language')).data).toBe('copied');
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('Device delete revokes an open document handle before deleting storage', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-delete-open-'));
	try {
		await using device = createDeviceBunWorkspaceRuntime({
			workspacesRoot: root,
		});
		const workspace = await device.open(definition);
		const row = await workspace.tables.notes.create({ title: 'Doomed' });
		using document = await workspace.tables.notes.document.open(row.id);
		document.get('editor').insert(0, 'draft');
		await document.whenDurable();

		// Destructive cleanup revokes and drains active handles first: an open
		// handle must not turn explicit deletion into a partial failure that has
		// already destroyed the scalar rows.
		await device.delete(definition);
		expect(() => document.get('editor')).toThrow(
			'Device workspace data was deleted',
		);
		expect((await workspace.tables.notes.list()).rows).toEqual([]);
		const recaptured = await device.capture(definition);
		expect(recaptured.rows).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('logical export captures a settled cut, documents, and explicit omissions', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-export-'));
	const authorityState = openAuthority();
	const { transport } = createTransport(authorityState.authority);
	try {
		await using device = createDeviceBunWorkspaceRuntime({
			workspacesRoot: root,
		});
		const deviceWorkspace = await device.open(definition);
		const withDocument = await deviceWorkspace.tables.notes.create({
			title: 'Documented',
		});
		const scalarOnly = await deviceWorkspace.tables.notes.create({
			title: 'Scalar only',
		});
		expectOk(await deviceWorkspace.kv.set('theme', 'dark'));
		{
			using document = await deviceWorkspace.tables.notes.document.open(
				withDocument.id,
			);
			document.get('editor').insert(0, 'body');
			await document.whenDurable();
		}
		const deviceExport = await device.export(definition);
		expect(deviceExport.settlement).toBeNull();
		expect(deviceExport.kv).toEqual({ theme: 'dark' });
		expect(
			deviceExport.rows.find((row) => row.rowId === withDocument.id)?.document,
		).toBeInstanceOf(Uint8Array);
		// A row without local document state carries no document field: the
		// deterministic, explicit omission record.
		expect(
			deviceExport.rows.find((row) => row.rowId === scalarOnly.id),
		).not.toContainKey('document');

		await using account = createAccountBunWorkspaceRuntime({
			workspacesRoot: root,
			account: {
				deploymentId: 'https://example.test',
				principalId: asPrincipalId('alice'),
				transport: () => transport,
			},
			recordPollIntervalMs: 60_000,
		});
		const accountWorkspace = await account.open(definition);
		const accountRow = await accountWorkspace.tables.notes.create({
			title: 'Account',
		});
		{
			using document = await accountWorkspace.tables.notes.document.open(
				accountRow.id,
			);
			document.get('editor').insert(0, 'account body');
			await document.whenDurable();
		}
		const accountExport = await account.export(definition);
		expect(accountExport.settlement).toEqual({ outcome: 'caught-up' });
		expect(
			accountExport.rows.find((row) => row.rowId === accountRow.id)?.document,
		).toBeInstanceOf(Uint8Array);
		expect(authorityRows(authorityState.database)).toContainEqual({
			rowId: accountRow.id,
			fields: { title: 'Account' },
		});
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('export stays available while the authority is unreachable', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-export-offline-'));
	const offline = async () => {
		throw new CurrentStateTransportInterruption(
			'offline',
			'network unavailable',
		);
	};
	const transport: CurrentStateReplicaTransport = {
		push: offline,
		pull: offline,
		acquire: offline,
	};
	try {
		await using account = createAccountBunWorkspaceRuntime({
			workspacesRoot: root,
			account: {
				deploymentId: 'https://example.test',
				principalId: asPrincipalId('alice'),
				transport: () => transport,
			},
			recordPollIntervalMs: 60_000,
		});
		const workspace = await account.open(definition);
		const queued = await workspace.tables.notes.create({ title: 'Queued' });
		const exported = await account.export(definition);
		expect(exported.settlement).toEqual({
			outcome: 'pending',
			reason: 'offline',
		});
		// Locally visible unsynchronized content is captured, never omitted.
		expect(exported.rows).toContainEqual({
			table: 'notes',
			rowId: queued.id,
			fields: { title: 'Queued' },
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('Device and Account own separate roots while duplicate Account owners fail', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-ownership-'));
	const authorityState = openAuthority();
	const { transport } = createTransport(authorityState.authority);
	const accountOptions = {
		workspacesRoot: root,
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: () => transport,
		},
	};
	try {
		const device = createDeviceBunWorkspaceRuntime({ workspacesRoot: root });
		const account = createAccountBunWorkspaceRuntime(accountOptions);
		expect(() =>
			createDeviceBunWorkspaceRuntime({ workspacesRoot: root }),
		).toThrow('already has an owner');
		expect(() => createAccountBunWorkspaceRuntime(accountOptions)).toThrow(
			'already has an owner',
		);
		await device[Symbol.asyncDispose]();
		await account[Symbol.asyncDispose]();

		await using released = createDeviceBunWorkspaceRuntime({
			workspacesRoot: root,
		});
		await released.open(definition);
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

function deviceWorkspacePath(root: string): string {
	return join(root, 'device', definition.id, 'store.sqlite3');
}

function authorityRows(database: Database) {
	return database
		.query<{ rowId: string; fieldsJson: string }, []>(
			`SELECT row_id AS rowId, fields_json AS fieldsJson
			 FROM row_authority_rows ORDER BY row_id`,
		)
		.all()
		.map((row) => ({ rowId: row.rowId, fields: JSON.parse(row.fieldsJson) }));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for sync');
		await Bun.sleep(10);
	}
}
