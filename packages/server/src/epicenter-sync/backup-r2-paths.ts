import { r2DataOwnerPrefix } from './blob-files-r2.js';

const BACKUP_ID_CHARACTERS = /^[a-z0-9]+$/u;
const NAME_PREFIX = 'backup-v1';

function validateBackupId(backupId: string): void {
	if (backupId.length !== 24 || !BACKUP_ID_CHARACTERS.test(backupId)) {
		throw new TypeError(
			'backup ID must be 24 lowercase alphanumeric characters',
		);
	}
}

/** Deterministic named-DO identity for one principal-owned Backup. */
export function dataBackupV1Name(
	ownerStorageKey: string,
	backupId: string,
): string {
	if (ownerStorageKey.length === 0) {
		throw new TypeError('Backup owner storage key must not be empty');
	}
	validateBackupId(backupId);
	return `${NAME_PREFIX}:${encodeURIComponent(ownerStorageKey)}:${backupId}`;
}

/** Exact R2 ownership prefix for one principal Backup. */
export function r2DataBackupPrefix(
	ownerStorageKey: string,
	backupId: string,
): string {
	dataBackupV1Name(ownerStorageKey, backupId);
	return `${r2DataOwnerPrefix(ownerStorageKey)}backups/${backupId}/`;
}

export function parseDataBackupName(name: string | undefined): {
	ownerStorageKey: string;
	backupId: string;
} {
	if (name === undefined)
		throw new Error('DataBackup must use a named identity');
	const [prefix, encodedOwner, backupId, extra] = name.split(':');
	if (
		prefix !== NAME_PREFIX ||
		encodedOwner === undefined ||
		backupId === undefined ||
		extra !== undefined
	) {
		throw new Error('DataBackup identity is not recognized');
	}
	let ownerStorageKey: string;
	try {
		ownerStorageKey = decodeURIComponent(encodedOwner);
	} catch {
		throw new Error('DataBackup identity is not recognized');
	}
	if (dataBackupV1Name(ownerStorageKey, backupId) !== name) {
		throw new Error('DataBackup identity is not canonical');
	}
	return { ownerStorageKey, backupId };
}
