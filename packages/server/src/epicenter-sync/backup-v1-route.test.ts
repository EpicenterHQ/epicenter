/**
 * Backup V1 Route Tests
 *
 * Verifies the authenticated JSON surface over the principal-owned Backup
 * registry and Restore activation seam.
 *
 * Key behaviors:
 * - The bearer gate runs before any Backup owner lookup
 * - Public registry responses omit host filesystem paths
 * - Restore and Delete validate exact Backup IDs and report missing entries
 */
import { describe, expect, test } from 'bun:test';

import { Principal } from '@epicenter/auth';
import { asPrincipalId, type PrincipalId } from '@epicenter/identity';
import { Hono } from 'hono';

import type { Env } from '../types.js';
import {
	BACKUP_V1_REGISTRY_PATH,
	createBackupV1App,
	mountBackupV1App,
} from './backup-v1-route.js';

const PRINCIPAL = asPrincipalId('alice');
const BACKUP_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_BACKUP_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ENTRY_PATH = `${BACKUP_V1_REGISTRY_PATH}/${BACKUP_ID}`;
const RESTORE_PATH = `${ENTRY_PATH}/restore`;

function setup({
	mounted = false,
	restoreInProgress = false,
	crudOnly = false,
}: {
	mounted?: boolean;
	restoreInProgress?: boolean;
	crudOnly?: boolean;
} = {}) {
	const principals: PrincipalId[] = [];
	const restored: Array<{ principalId: PrincipalId; backupId: string }> = [];
	const deleted: string[] = [];
	const backups = [
		{
			backupId: BACKUP_ID,
			directory: '/private/backups/aaaaaaaaaaaaaaaaaaaaaaaa',
			recordCount: 3,
		},
	];
	const app = new Hono<Env>();
	const options = {
		locateRegistry(principalId: PrincipalId) {
			principals.push(principalId);
			return {
				async create() {
					const backup = {
						backupId: OTHER_BACKUP_ID,
						directory: '/private/backups/bbbbbbbbbbbbbbbbbbbbbbbb',
						recordCount: 4,
					};
					backups.push(backup);
					return backup;
				},
				async list() {
					return backups;
				},
				async delete(backupId: string) {
					const index = backups.findIndex(
						(backup) => backup.backupId === backupId,
					);
					if (index === -1) return false;
					deleted.push(backupId);
					backups.splice(index, 1);
					return true;
				},
			};
		},
		async restoreBackup(principalId: PrincipalId, backupId: string) {
			if (restoreInProgress) return { kind: 'restore-in-progress' as const };
			if (!backups.some((backup) => backup.backupId === backupId)) {
				return { kind: 'backup-not-found' as const };
			}
			restored.push({ principalId, backupId });
			return {
				kind: 'restored' as const,
				authorityLifetime: '12345678-1234-4123-8123-123456789abc',
				recordCount: 3,
			};
		},
	};
	const routeOptions = crudOnly
		? { locateRegistry: options.locateRegistry }
		: options;
	if (mounted) {
		mountBackupV1App(app, {
			...routeOptions,
			auth: async (c, next) => {
				if (c.req.header('authorization') !== 'Bearer token') {
					return c.json({ error: 'unauthorized' } as const, 401);
				}
				c.set('principal', Principal.assert({ id: PRINCIPAL }));
				await next();
			},
		});
	} else {
		app.use('*', async (c, next) => {
			c.set('principal', Principal.assert({ id: PRINCIPAL }));
			await next();
		});
		app.route('/', createBackupV1App(routeOptions));
	}
	return { app, backups, deleted, principals, restored };
}

describe('Backup V1 routes', () => {
	test('bearer gate refuses every operation before locating the registry', async () => {
		const context = setup({ mounted: true });
		for (const request of [
			{ path: BACKUP_V1_REGISTRY_PATH, method: 'POST' },
			{ path: BACKUP_V1_REGISTRY_PATH, method: 'GET' },
			{ path: RESTORE_PATH, method: 'POST' },
			{ path: ENTRY_PATH, method: 'DELETE' },
		]) {
			const response = await context.app.request(request.path, {
				method: request.method,
			});
			expect(response.status).toBe(401);
		}
		expect(context.principals).toEqual([]);
	});

	test('create and list return registry metadata without filesystem paths', async () => {
		const context = setup();
		const created = await context.app.request(BACKUP_V1_REGISTRY_PATH, {
			method: 'POST',
		});
		expect(created.status).toBe(201);
		expect((await created.json()) as unknown).toEqual({
			backup: { backupId: OTHER_BACKUP_ID, recordCount: 4 },
		});

		const listed = await context.app.request(BACKUP_V1_REGISTRY_PATH);
		expect(listed.status).toBe(200);
		expect((await listed.json()) as unknown).toEqual({
			backups: [
				{ backupId: BACKUP_ID, recordCount: 3 },
				{ backupId: OTHER_BACKUP_ID, recordCount: 4 },
			],
		});
		expect(context.principals).toEqual([PRINCIPAL, PRINCIPAL]);
	});

	test('CRUD-only mount does not advertise an unimplemented Restore route', async () => {
		const context = setup({ mounted: true, crudOnly: true });
		const authorized = { authorization: 'Bearer token' };
		expect(
			(
				await context.app.request(BACKUP_V1_REGISTRY_PATH, {
					method: 'POST',
					headers: authorized,
				})
			).status,
		).toBe(201);
		expect(
			(
				await context.app.request(BACKUP_V1_REGISTRY_PATH, {
					headers: authorized,
				})
			).status,
		).toBe(200);
		expect(
			(
				await context.app.request(ENTRY_PATH, {
					method: 'DELETE',
					headers: authorized,
				})
			).status,
		).toBe(200);
		expect(
			(
				await context.app.request(RESTORE_PATH, {
					method: 'POST',
					headers: authorized,
				})
			).status,
		).toBe(404);
	});

	test('restore activates the selected principal Backup and returns its new lifetime', async () => {
		const context = setup();
		const response = await context.app.request(RESTORE_PATH, {
			method: 'POST',
		});
		expect(response.status).toBe(200);
		expect((await response.json()) as unknown).toEqual({
			restored: {
				backupId: BACKUP_ID,
				authorityLifetime: '12345678-1234-4123-8123-123456789abc',
				recordCount: 3,
			},
		});
		expect(context.restored).toEqual([
			{ principalId: PRINCIPAL, backupId: BACKUP_ID },
		]);
	});

	test('delete removes one selected Backup and confirms its ID', async () => {
		const context = setup();
		const response = await context.app.request(ENTRY_PATH, {
			method: 'DELETE',
		});
		expect(response.status).toBe(200);
		expect((await response.json()) as unknown).toEqual({
			deleted: { backupId: BACKUP_ID },
		});
		expect(context.deleted).toEqual([BACKUP_ID]);
	});

	test('concurrent Restore reports a stable conflict', async () => {
		const context = setup({ restoreInProgress: true });
		const response = await context.app.request(RESTORE_PATH, {
			method: 'POST',
		});
		expect(response.status).toBe(409);
		expect((await response.json()) as unknown).toEqual({
			error: 'restore-in-progress',
		});
	});

	test('invalid and missing IDs never invoke Restore or Delete', async () => {
		const context = setup();
		for (const request of [
			{
				path: `${BACKUP_V1_REGISTRY_PATH}/short/restore`,
				method: 'POST',
				status: 400,
				error: 'invalid-backup-id',
			},
			{
				path: `${BACKUP_V1_REGISTRY_PATH}/AAAAAAAAAAAAAAAAAAAAAAAA`,
				method: 'DELETE',
				status: 400,
				error: 'invalid-backup-id',
			},
			{
				path: `${BACKUP_V1_REGISTRY_PATH}/aaaaaaaaaaaaaaaaaaaaaaaaa/restore`,
				method: 'POST',
				status: 400,
				error: 'invalid-backup-id',
			},
			{
				path: `${BACKUP_V1_REGISTRY_PATH}/cccccccccccccccccccccccc/restore`,
				method: 'POST',
				status: 404,
				error: 'backup-not-found',
			},
			{
				path: `${BACKUP_V1_REGISTRY_PATH}/cccccccccccccccccccccccc`,
				method: 'DELETE',
				status: 404,
				error: 'backup-not-found',
			},
		]) {
			const response = await context.app.request(request.path, {
				method: request.method,
			});
			expect(response.status).toBe(request.status);
			expect((await response.json()) as unknown).toEqual({
				error: request.error,
			});
		}
		expect(context.restored).toEqual([]);
		expect(context.deleted).toEqual([]);
	});
});
