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
	BACKUP_V1_RESTORE_REQUEST_HEADER,
	BACKUP_V1_UPLOAD_PART_SHA256_HEADER,
	BACKUP_V1_UPLOADS_PATH,
	createBackupV1App,
	mountBackupV1App,
} from './backup-v1-route.js';

const PRINCIPAL = asPrincipalId('alice');
const BACKUP_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_BACKUP_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const RESTORE_REQUEST_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const UPLOAD_REQUEST_ID = 'uuuuuuuuuuuuuuuuuuuuuuuu';
const UPLOAD_BACKUP_ID = 'cccccccccccccccccccccccc';
const ENTRY_PATH = `${BACKUP_V1_REGISTRY_PATH}/${BACKUP_ID}`;
const RESTORE_PATH = `${ENTRY_PATH}/restore`;
const DOWNLOAD_PATH = `${ENTRY_PATH}/download`;
const UPLOAD_PATH = `${BACKUP_V1_UPLOADS_PATH}/${UPLOAD_REQUEST_ID}`;
const UPLOAD_PART_PATH = `${UPLOAD_PATH}/parts/1`;
const UPLOAD_COMPLETE_PATH = `${UPLOAD_PATH}/complete`;

function setup({
	mounted = false,
	restoreInProgress = false,
	idempotencyConflict = false,
	crudOnly = false,
	portable = false,
	partResult = { kind: 'stored' as const },
	completionResult = {
		kind: 'completed' as const,
		backup: { backupId: UPLOAD_BACKUP_ID, recordCount: 5 },
	},
}: {
	mounted?: boolean;
	restoreInProgress?: boolean;
	idempotencyConflict?: boolean;
	crudOnly?: boolean;
	portable?: boolean;
	partResult?:
		| { kind: 'stored' }
		| { kind: 'upload-not-found' }
		| { kind: 'upload-conflict' }
		| { kind: 'invalid-upload-part' };
	completionResult?:
		| {
				kind: 'completed';
				backup: { backupId: string; recordCount: number };
		  }
		| { kind: 'upload-not-found' }
		| { kind: 'upload-conflict' }
		| { kind: 'invalid-upload-completion' }
		| { kind: 'invalid-portable-backup' };
} = {}) {
	const principals: PrincipalId[] = [];
	const restored: Array<{
		principalId: PrincipalId;
		backupId: string;
		restoreRequestId: string;
	}> = [];
	const deleted: string[] = [];
	const uploadedParts: Array<{
		requestId: string;
		partNumber: number;
		bytes: string;
	}> = [];
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
				async download(backupId: string) {
					return backups.some((backup) => backup.backupId === backupId)
						? new Response('portable', {
								headers: { 'content-type': 'application/x-tar' },
							})
						: undefined;
				},
				async createUpload(requestId: string) {
					return {
						requestId,
						backupId: UPLOAD_BACKUP_ID,
						state: 'uploading',
					};
				},
				async putUploadPart(
					requestId: string,
					partNumber: number,
					_byteLength: number,
					_sha256: string,
					bytes: ReadableStream<Uint8Array>,
				) {
					uploadedParts.push({
						requestId,
						partNumber,
						bytes: await new Response(bytes).text(),
					});
					return partResult;
				},
				async completeUpload(requestId: string, parts: unknown) {
					expect(requestId).toBe(UPLOAD_REQUEST_ID);
					expect(parts).toEqual([1]);
					return completionResult;
				},
				async deleteUpload(requestId: string) {
					return requestId === UPLOAD_REQUEST_ID;
				},
			};
		},
		async restoreBackup(
			principalId: PrincipalId,
			backupId: string,
			restoreRequestId: string,
		) {
			if (restoreInProgress) return { kind: 'restore-in-progress' as const };
			if (idempotencyConflict) {
				return { kind: 'idempotency-conflict' as const };
			}
			if (!backups.some((backup) => backup.backupId === backupId)) {
				return { kind: 'backup-not-found' as const };
			}
			restored.push({ principalId, backupId, restoreRequestId });
			return {
				kind: 'restored' as const,
				authorityLifetime: '12345678-1234-4123-8123-123456789abc',
				recordCount: 3,
			};
		},
	};
	const routeOptions = crudOnly
		? { locateRegistry: options.locateRegistry }
		: { ...options, portable };
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
	return { app, backups, deleted, principals, restored, uploadedParts };
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

	test('portable routes stream downloads and publish resumable uploads', async () => {
		const context = setup({ portable: true });
		const downloaded = await context.app.request(DOWNLOAD_PATH);
		expect(downloaded.status).toBe(200);
		expect(downloaded.headers.get('content-type')).toBe('application/x-tar');
		expect(downloaded.headers.get('content-disposition')).toBe(
			`attachment; filename="${BACKUP_ID}.epicenter.tar"`,
		);
		expect(await downloaded.text()).toBe('portable');

		const created = await context.app.request(BACKUP_V1_UPLOADS_PATH, {
			method: 'POST',
			headers: { [BACKUP_V1_RESTORE_REQUEST_HEADER]: UPLOAD_REQUEST_ID },
		});
		expect(created.status).toBe(201);
		expect((await created.json()) as unknown).toEqual({
			upload: {
				requestId: UPLOAD_REQUEST_ID,
				backupId: UPLOAD_BACKUP_ID,
				state: 'uploading',
			},
		});

		const part = await context.app.request(UPLOAD_PART_PATH, {
			method: 'PUT',
			headers: {
				'content-length': '4',
				[BACKUP_V1_UPLOAD_PART_SHA256_HEADER]: 'f'.repeat(64),
			},
			body: 'part',
		});
		expect(part.status).toBe(200);
		expect(context.uploadedParts).toEqual([
			{ requestId: UPLOAD_REQUEST_ID, partNumber: 1, bytes: 'part' },
		]);

		const completed = await context.app.request(UPLOAD_COMPLETE_PATH, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ parts: [1] }),
		});
		expect(completed.status).toBe(201);
		expect((await completed.json()) as unknown).toEqual({
			backup: { backupId: UPLOAD_BACKUP_ID, recordCount: 5 },
		});

		const deleted = await context.app.request(UPLOAD_PATH, {
			method: 'DELETE',
		});
		expect(deleted.status).toBe(200);
		expect((await deleted.json()) as unknown).toEqual({
			deleted: { requestId: UPLOAD_REQUEST_ID },
		});
	});

	test('portable routes validate every public upload coordinate', async () => {
		const context = setup({ portable: true });
		for (const request of [
			{ path: BACKUP_V1_UPLOADS_PATH, method: 'POST' },
			{
				path: `${BACKUP_V1_UPLOADS_PATH}/short/parts/1`,
				method: 'PUT',
			},
			{
				path: `${UPLOAD_PATH}/parts/0`,
				method: 'PUT',
			},
			{
				path: UPLOAD_PART_PATH,
				method: 'PUT',
				headers: {
					'content-length': '67108865',
					[BACKUP_V1_UPLOAD_PART_SHA256_HEADER]: 'f'.repeat(64),
				},
				body: 'x',
			},
			{
				path: UPLOAD_COMPLETE_PATH,
				method: 'POST',
				body: '{}',
			},
		]) {
			const response = await context.app.request(request.path, {
				method: request.method,
				...('headers' in request ? { headers: request.headers } : {}),
				...('body' in request ? { body: request.body } : {}),
			});
			expect(response.status).toBe(400);
		}
		expect(context.uploadedParts).toEqual([]);
	});

	test('portable routes expose stable resumable upload outcomes', async () => {
		for (const [partResult, status, error] of [
			[{ kind: 'upload-not-found' as const }, 404, 'upload-not-found'],
			[{ kind: 'upload-conflict' as const }, 409, 'upload-conflict'],
			[{ kind: 'invalid-upload-part' as const }, 400, 'invalid-upload-part'],
		] as const) {
			const context = setup({ portable: true, partResult });
			const response = await context.app.request(UPLOAD_PART_PATH, {
				method: 'PUT',
				headers: {
					'content-length': '4',
					[BACKUP_V1_UPLOAD_PART_SHA256_HEADER]: 'f'.repeat(64),
				},
				body: 'part',
			});
			expect(response.status).toBe(status);
			expect((await response.json()) as unknown).toEqual({ error });
		}

		for (const [completionResult, status, error] of [
			[{ kind: 'upload-not-found' as const }, 404, 'upload-not-found'],
			[{ kind: 'upload-conflict' as const }, 409, 'upload-conflict'],
			[
				{ kind: 'invalid-upload-completion' as const },
				400,
				'invalid-upload-completion',
			],
			[
				{ kind: 'invalid-portable-backup' as const },
				400,
				'invalid-portable-backup',
			],
		] as const) {
			const context = setup({ portable: true, completionResult });
			const response = await context.app.request(UPLOAD_COMPLETE_PATH, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ parts: [1] }),
			});
			expect(response.status).toBe(status);
			expect((await response.json()) as unknown).toEqual({ error });
		}
	});

	test('restore activates the selected principal Backup and returns its new lifetime', async () => {
		const context = setup();
		const response = await context.app.request(RESTORE_PATH, {
			method: 'POST',
			headers: { [BACKUP_V1_RESTORE_REQUEST_HEADER]: RESTORE_REQUEST_ID },
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
			{
				principalId: PRINCIPAL,
				backupId: BACKUP_ID,
				restoreRequestId: RESTORE_REQUEST_ID,
			},
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
			headers: { [BACKUP_V1_RESTORE_REQUEST_HEADER]: RESTORE_REQUEST_ID },
		});
		expect(response.status).toBe(409);
		expect((await response.json()) as unknown).toEqual({
			error: 'restore-in-progress',
		});
	});

	test('reused Restore request ID reports a stable conflict', async () => {
		const context = setup({ idempotencyConflict: true });
		const response = await context.app.request(RESTORE_PATH, {
			method: 'POST',
			headers: { [BACKUP_V1_RESTORE_REQUEST_HEADER]: RESTORE_REQUEST_ID },
		});
		expect(response.status).toBe(409);
		expect((await response.json()) as unknown).toEqual({
			error: 'idempotency-conflict',
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
				headers: {
					[BACKUP_V1_RESTORE_REQUEST_HEADER]: RESTORE_REQUEST_ID,
				},
			},
			{
				path: RESTORE_PATH,
				method: 'POST',
				status: 400,
				error: 'invalid-restore-request-id',
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
				...('headers' in request ? { headers: request.headers } : {}),
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
