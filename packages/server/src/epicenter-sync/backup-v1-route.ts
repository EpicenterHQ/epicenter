import type { PrincipalId } from '@epicenter/identity';
import { Hono, type MiddlewareHandler } from 'hono';

import type { Env } from '../types.js';

export const BACKUP_V1_REGISTRY_PATH = '/api/sync/v1/backups';
export const BACKUP_V1_ENTRY_PATH = '/api/sync/v1/backups/:backupId';
export const BACKUP_V1_RESTORE_PATH = '/api/sync/v1/backups/:backupId/restore';
export const BACKUP_V1_DOWNLOAD_PATH =
	'/api/sync/v1/backups/:backupId/download';
export const BACKUP_V1_UPLOADS_PATH = '/api/sync/v1/backups/uploads';
export const BACKUP_V1_UPLOAD_PATH = '/api/sync/v1/backups/uploads/:requestId';
export const BACKUP_V1_UPLOAD_PART_PATH =
	'/api/sync/v1/backups/uploads/:requestId/parts/:partNumber';
export const BACKUP_V1_UPLOAD_COMPLETE_PATH =
	'/api/sync/v1/backups/uploads/:requestId/complete';
export const BACKUP_V1_RESTORE_REQUEST_HEADER = 'idempotency-key';
export const BACKUP_V1_UPLOAD_PART_SHA256_HEADER = 'x-content-sha256';

const BACKUP_ID_CHARACTERS = /^[a-z0-9]+$/u;

export type BackupV1Metadata = {
	backupId: string;
	recordCount: number;
};

type BackupRegistry = {
	create(): Promise<BackupV1Metadata>;
	list(): Promise<BackupV1Metadata[]>;
	delete(backupId: string): Promise<boolean>;
	download?(backupId: string): Promise<Response | undefined>;
	createUpload?(requestId: string): Promise<{
		requestId: string;
		backupId: string;
		state: string;
	}>;
	putUploadPart?(
		requestId: string,
		partNumber: number,
		byteLength: number,
		sha256: string,
		bytes: ReadableStream<Uint8Array>,
	): Promise<
		| { kind: 'stored' }
		| { kind: 'upload-not-found' }
		| { kind: 'upload-conflict' }
		| { kind: 'invalid-upload-part' }
	>;
	completeUpload?(
		requestId: string,
		parts: unknown,
	): Promise<
		| { kind: 'completed'; backup: BackupV1Metadata }
		| { kind: 'upload-not-found' }
		| { kind: 'upload-conflict' }
		| { kind: 'invalid-upload-completion' }
		| { kind: 'invalid-portable-backup' }
	>;
	deleteUpload?(requestId: string): Promise<boolean>;
};

export type BackupV1RegistryLocator<E extends Env = Env> = (
	principalId: PrincipalId,
	env: E['Bindings'],
) => BackupRegistry | Promise<BackupRegistry>;

export type BackupV1Restore<E extends Env = Env> = (
	principalId: PrincipalId,
	backupId: string,
	restoreRequestId: string,
	env: E['Bindings'],
) => Promise<
	| { kind: 'restored'; authorityLifetime: string; recordCount: number }
	| { kind: 'backup-not-found' }
	| { kind: 'restore-in-progress' }
	| { kind: 'idempotency-conflict' }
>;

function metadataOf(backup: BackupV1Metadata): BackupV1Metadata {
	return {
		backupId: backup.backupId,
		recordCount: backup.recordCount,
	};
}

function backupIdFrom(value: string): string | undefined {
	return value.length === 24 && BACKUP_ID_CHARACTERS.test(value)
		? value
		: undefined;
}

function uploadPartNumberFrom(value: string): number | undefined {
	if (!/^[1-9][0-9]{0,2}$/u.test(value)) return undefined;
	const partNumber = Number(value);
	return partNumber <= 512 ? partNumber : undefined;
}

function uploadByteLengthFrom(value: string | undefined): number | undefined {
	if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return undefined;
	const byteLength = Number(value);
	return Number.isSafeInteger(byteLength) && byteLength <= 64 * 1024 * 1024
		? byteLength
		: undefined;
}

function uploadSha256From(value: string | undefined): string | undefined {
	return value !== undefined && /^[a-f0-9]{64}$/u.test(value)
		? value
		: undefined;
}

function portableRegistry(registry: BackupRegistry) {
	if (
		registry.download === undefined ||
		registry.createUpload === undefined ||
		registry.putUploadPart === undefined ||
		registry.completeUpload === undefined ||
		registry.deleteUpload === undefined
	) {
		throw new Error('portable Backup operations are not installed');
	}
	return {
		download: registry.download.bind(registry),
		createUpload: registry.createUpload.bind(registry),
		putUploadPart: registry.putUploadPart.bind(registry),
		completeUpload: registry.completeUpload.bind(registry),
		deleteUpload: registry.deleteUpload.bind(registry),
	};
}

/** Create the Backup registry and Restore routes without auth. */
export function createBackupV1App<E extends Env = Env>({
	locateRegistry,
	restoreBackup,
	portable = false,
}: {
	locateRegistry: BackupV1RegistryLocator<E>;
	restoreBackup?: BackupV1Restore<E>;
	portable?: boolean;
}): Hono<E> {
	const app = new Hono<E>();

	app.post(BACKUP_V1_REGISTRY_PATH, async (c) => {
		const registry = await locateRegistry(c.var.principal.id, c.env);
		const backup = await registry.create();
		return c.json({ backup: metadataOf(backup) }, 201);
	});

	app.get(BACKUP_V1_REGISTRY_PATH, async (c) => {
		const registry = await locateRegistry(c.var.principal.id, c.env);
		const backups = await registry.list();
		return c.json({ backups: backups.map(metadataOf) });
	});

	if (portable) {
		app.get(BACKUP_V1_DOWNLOAD_PATH, async (c) => {
			const backupId = backupIdFrom(c.req.param('backupId'));
			if (backupId === undefined) {
				return c.json({ error: 'invalid-backup-id' } as const, 400);
			}
			const registry = portableRegistry(
				await locateRegistry(c.var.principal.id, c.env),
			);
			const downloaded = await registry.download(backupId);
			if (downloaded === undefined) {
				return c.json({ error: 'backup-not-found' } as const, 404);
			}
			const headers = new Headers(downloaded.headers);
			headers.set(
				'content-disposition',
				`attachment; filename="${backupId}.epicenter.tar"`,
			);
			return new Response(downloaded.body, {
				status: downloaded.status,
				headers,
			});
		});

		app.post(BACKUP_V1_UPLOADS_PATH, async (c) => {
			const requestId = backupIdFrom(
				c.req.header(BACKUP_V1_RESTORE_REQUEST_HEADER) ?? '',
			);
			if (requestId === undefined) {
				return c.json({ error: 'invalid-upload-request-id' } as const, 400);
			}
			const registry = portableRegistry(
				await locateRegistry(c.var.principal.id, c.env),
			);
			return c.json({ upload: await registry.createUpload(requestId) }, 201);
		});

		app.put(BACKUP_V1_UPLOAD_PART_PATH, async (c) => {
			const requestId = backupIdFrom(c.req.param('requestId'));
			const partNumber = uploadPartNumberFrom(c.req.param('partNumber'));
			const byteLength = uploadByteLengthFrom(c.req.header('content-length'));
			const sha256 = uploadSha256From(
				c.req.header(BACKUP_V1_UPLOAD_PART_SHA256_HEADER),
			);
			if (
				requestId === undefined ||
				partNumber === undefined ||
				byteLength === undefined ||
				sha256 === undefined ||
				c.req.raw.body === null
			) {
				return c.json({ error: 'invalid-upload-part' } as const, 400);
			}
			const registry = portableRegistry(
				await locateRegistry(c.var.principal.id, c.env),
			);
			const stored = await registry.putUploadPart(
				requestId,
				partNumber,
				byteLength,
				sha256,
				c.req.raw.body,
			);
			if (stored.kind === 'upload-not-found') {
				return c.json({ error: 'upload-not-found' } as const, 404);
			}
			if (stored.kind === 'invalid-upload-part') {
				return c.json({ error: 'invalid-upload-part' } as const, 400);
			}
			if (stored.kind === 'upload-conflict') {
				return c.json({ error: 'upload-conflict' } as const, 409);
			}
			return c.json({ stored: { requestId, partNumber } });
		});

		app.post(BACKUP_V1_UPLOAD_COMPLETE_PATH, async (c) => {
			const requestId = backupIdFrom(c.req.param('requestId'));
			if (requestId === undefined) {
				return c.json({ error: 'invalid-upload-request-id' } as const, 400);
			}
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: 'invalid-upload-completion' } as const, 400);
			}
			if (
				body === null ||
				typeof body !== 'object' ||
				Object.keys(body).join(',') !== 'parts'
			) {
				return c.json({ error: 'invalid-upload-completion' } as const, 400);
			}
			const registry = portableRegistry(
				await locateRegistry(c.var.principal.id, c.env),
			);
			const completed = await registry.completeUpload(
				requestId,
				(body as { parts?: unknown }).parts,
			);
			if (completed.kind === 'upload-not-found') {
				return c.json({ error: 'upload-not-found' } as const, 404);
			}
			if (completed.kind === 'upload-conflict') {
				return c.json({ error: 'upload-conflict' } as const, 409);
			}
			if (completed.kind === 'invalid-upload-completion') {
				return c.json({ error: 'invalid-upload-completion' } as const, 400);
			}
			if (completed.kind === 'invalid-portable-backup') {
				return c.json({ error: 'invalid-portable-backup' } as const, 400);
			}
			return c.json({ backup: metadataOf(completed.backup) }, 201);
		});

		app.delete(BACKUP_V1_UPLOAD_PATH, async (c) => {
			const requestId = backupIdFrom(c.req.param('requestId'));
			if (requestId === undefined) {
				return c.json({ error: 'invalid-upload-request-id' } as const, 400);
			}
			const registry = portableRegistry(
				await locateRegistry(c.var.principal.id, c.env),
			);
			if (!(await registry.deleteUpload(requestId))) {
				return c.json({ error: 'upload-not-found' } as const, 404);
			}
			return c.json({ deleted: { requestId } });
		});
	}

	if (restoreBackup !== undefined) {
		app.post(BACKUP_V1_RESTORE_PATH, async (c) => {
			const backupId = backupIdFrom(c.req.param('backupId'));
			if (backupId === undefined) {
				return c.json({ error: 'invalid-backup-id' } as const, 400);
			}
			const restoreRequestId = backupIdFrom(
				c.req.header(BACKUP_V1_RESTORE_REQUEST_HEADER) ?? '',
			);
			if (restoreRequestId === undefined) {
				return c.json({ error: 'invalid-restore-request-id' } as const, 400);
			}
			const restored = await restoreBackup(
				c.var.principal.id,
				backupId,
				restoreRequestId,
				c.env,
			);
			if (restored.kind === 'backup-not-found') {
				return c.json({ error: 'backup-not-found' } as const, 404);
			}
			if (restored.kind === 'restore-in-progress') {
				return c.json({ error: 'restore-in-progress' } as const, 409);
			}
			if (restored.kind === 'idempotency-conflict') {
				return c.json({ error: 'idempotency-conflict' } as const, 409);
			}
			return c.json({
				restored: {
					backupId,
					authorityLifetime: restored.authorityLifetime,
					recordCount: restored.recordCount,
				},
			});
		});
	}

	app.delete(BACKUP_V1_ENTRY_PATH, async (c) => {
		const backupId = backupIdFrom(c.req.param('backupId'));
		if (backupId === undefined) {
			return c.json({ error: 'invalid-backup-id' } as const, 400);
		}
		const registry = await locateRegistry(c.var.principal.id, c.env);
		if (!(await registry.delete(backupId))) {
			return c.json({ error: 'backup-not-found' } as const, 404);
		}
		return c.json({ deleted: { backupId } });
	});

	return app;
}

/** Mount Backup and Restore operations behind the deployment bearer gate. */
export function mountBackupV1App<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		...options
	}: {
		auth: MiddlewareHandler<E>;
		locateRegistry: BackupV1RegistryLocator<E>;
		restoreBackup?: BackupV1Restore<E>;
		portable?: boolean;
	},
): void {
	app.use(BACKUP_V1_REGISTRY_PATH, auth);
	app.use(BACKUP_V1_ENTRY_PATH, auth);
	if (options.restoreBackup !== undefined) {
		app.use(BACKUP_V1_RESTORE_PATH, auth);
	}
	if (options.portable === true) {
		app.use(BACKUP_V1_DOWNLOAD_PATH, auth);
		app.use(BACKUP_V1_UPLOADS_PATH, auth);
		app.use(BACKUP_V1_UPLOAD_PATH, auth);
		app.use(BACKUP_V1_UPLOAD_PART_PATH, auth);
		app.use(BACKUP_V1_UPLOAD_COMPLETE_PATH, auth);
	}
	app.route('/', createBackupV1App(options));
}
