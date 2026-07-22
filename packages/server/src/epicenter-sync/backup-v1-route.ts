import type { PrincipalId } from '@epicenter/identity';
import { Hono, type MiddlewareHandler } from 'hono';

import type { Env } from '../types.js';

export const BACKUP_V1_REGISTRY_PATH = '/api/sync/v1/backups';
export const BACKUP_V1_ENTRY_PATH = '/api/sync/v1/backups/:backupId';
export const BACKUP_V1_RESTORE_PATH = '/api/sync/v1/backups/:backupId/restore';

const BACKUP_ID_CHARACTERS = /^[a-z0-9]+$/u;

export type BackupV1Metadata = {
	backupId: string;
	recordCount: number;
};

type BackupRegistry = {
	create(): Promise<BackupV1Metadata>;
	list(): Promise<BackupV1Metadata[]>;
	delete(backupId: string): Promise<boolean>;
};

export type BackupV1RegistryLocator<E extends Env = Env> = (
	principalId: PrincipalId,
	env: E['Bindings'],
) => BackupRegistry | Promise<BackupRegistry>;

export type BackupV1Restore<E extends Env = Env> = (
	principalId: PrincipalId,
	backupId: string,
	env: E['Bindings'],
) => Promise<
	| { kind: 'restored'; authorityLifetime: string; recordCount: number }
	| { kind: 'backup-not-found' }
	| { kind: 'restore-in-progress' }
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

/** Create the Backup registry and Restore routes without auth. */
export function createBackupV1App<E extends Env = Env>({
	locateRegistry,
	restoreBackup,
}: {
	locateRegistry: BackupV1RegistryLocator<E>;
	restoreBackup?: BackupV1Restore<E>;
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

	if (restoreBackup !== undefined) {
		app.post(BACKUP_V1_RESTORE_PATH, async (c) => {
			const backupId = backupIdFrom(c.req.param('backupId'));
			if (backupId === undefined) {
				return c.json({ error: 'invalid-backup-id' } as const, 400);
			}
			const restored = await restoreBackup(c.var.principal.id, backupId, c.env);
			if (restored.kind === 'backup-not-found') {
				return c.json({ error: 'backup-not-found' } as const, 404);
			}
			if (restored.kind === 'restore-in-progress') {
				return c.json({ error: 'restore-in-progress' } as const, 409);
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
	},
): void {
	app.use(BACKUP_V1_REGISTRY_PATH, auth);
	app.use(BACKUP_V1_ENTRY_PATH, auth);
	if (options.restoreBackup !== undefined) {
		app.use(BACKUP_V1_RESTORE_PATH, auth);
	}
	app.route('/', createBackupV1App(options));
}
