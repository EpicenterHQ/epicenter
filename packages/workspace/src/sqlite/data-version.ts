import { assertSafeSegment } from '../shared/safe-segment.js';
import { isDocumentGuidLockTokenFor } from './document-guid.js';

export const APPLICATION_DATA_VERSION_LOCK_FORMAT =
	'epicenter.application-data-version-lock/1' as const;
const SHA256_TOKEN = /^sha256:[0-9a-f]{64}$/;

export type ApplicationDataVersionLockEntry = {
	readonly dataVersion: number;
	readonly workspaceId: string;
	readonly recordsSchemaHash: string;
	readonly planes: Readonly<Record<string, string>>;
};

export type ApplicationDataVersionLock = {
	readonly format: typeof APPLICATION_DATA_VERSION_LOCK_FORMAT;
	readonly appId: string;
	readonly versions: readonly ApplicationDataVersionLockEntry[];
};

/** Derive the one storage and synchronization namespace for an app version. */
export function applicationWorkspaceId(
	appId: string,
	dataVersion: number,
): string {
	assertSafeSegment(appId, 'application id');
	assertDataVersion(dataVersion);
	return `${appId}-v${dataVersion}`;
}

/** Parse the exact append-only application data version lock representation. */
export function parseApplicationDataVersionLock(
	value: unknown,
): ApplicationDataVersionLock {
	if (
		!isPlainRecord(value) ||
		!hasExactKeys(value, ['appId', 'format', 'versions']) ||
		value.format !== APPLICATION_DATA_VERSION_LOCK_FORMAT ||
		typeof value.appId !== 'string' ||
		!Array.isArray(value.versions) ||
		value.versions.length === 0
	) {
		throw new Error('Invalid application data version lock');
	}
	assertSafeSegment(value.appId, 'application id');
	const appId = value.appId;

	let previousVersion = 0;
	const versions = value.versions.map((entry) => {
		if (
			!isPlainRecord(entry) ||
			!hasExactKeys(entry, [
				'dataVersion',
				'planes',
				'recordsSchemaHash',
				'workspaceId',
			]) ||
			typeof entry.dataVersion !== 'number' ||
			typeof entry.workspaceId !== 'string' ||
			typeof entry.recordsSchemaHash !== 'string' ||
			!isPlainRecord(entry.planes)
		) {
			throw new Error('Invalid application data version lock entry');
		}
		assertDataVersion(entry.dataVersion);
		if (entry.dataVersion <= previousVersion) {
			throw new Error(
				'Application data version lock entries must be strictly increasing',
			);
		}
		previousVersion = entry.dataVersion;
		if (
			entry.workspaceId !== applicationWorkspaceId(appId, entry.dataVersion)
		) {
			throw new Error(
				`Application data version ${entry.dataVersion} has an invalid workspace id`,
			);
		}
		if (!SHA256_TOKEN.test(entry.recordsSchemaHash)) {
			throw new Error('Invalid application data version records schema hash');
		}

		const planeNames = Object.keys(entry.planes);
		if (!isStrictlySorted(planeNames)) {
			throw new Error(
				'Application data version planes must be canonically sorted',
			);
		}
		const planes: Record<string, string> = {};
		for (const planeName of planeNames) {
			const planeValue = entry.planes[planeName];
			if (
				planeName.trim() === '' ||
				typeof planeValue !== 'string' ||
				planeValue.trim() === ''
			) {
				throw new Error('Invalid application data version plane');
			}
			planes[planeName] = planeValue;
		}
		assertPlaneMap(entry.workspaceId, planes);

		return Object.freeze({
			dataVersion: entry.dataVersion,
			workspaceId: entry.workspaceId,
			recordsSchemaHash: entry.recordsSchemaHash,
			planes: Object.freeze(planes),
		});
	});

	return Object.freeze({
		format: APPLICATION_DATA_VERSION_LOCK_FORMAT,
		appId,
		versions: Object.freeze(versions),
	});
}

function assertPlaneMap(
	workspaceId: string,
	planes: Readonly<Record<string, string>>,
): void {
	if (planes.kv !== `${workspaceId}.kv`) {
		throw new Error('Application data version has an invalid KV identity');
	}
	for (const [planeName, token] of Object.entries(planes)) {
		if (planeName === 'kv') continue;
		if (planeName.startsWith('kv.')) {
			if (planeName.length === 'kv.'.length || !SHA256_TOKEN.test(token)) {
				throw new Error('Application data version has an invalid KV plane');
			}
			continue;
		}
		const documentMatch =
			/^document\.([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(
				planeName,
			);
		if (documentMatch) {
			const tableName = documentMatch[1];
			const documentName = documentMatch[2];
			if (tableName === undefined || documentName === undefined) {
				throw new Error(
					'Application data version has an invalid child-document plane',
				);
			}
			if (
				!isDocumentGuidLockTokenFor(token, {
					workspaceId,
					table: tableName,
					document: documentName,
				})
			) {
				throw new Error(
					'Application data version has an invalid child-document plane',
				);
			}
			continue;
		}
		const blobMatch = /^blob\.([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(planeName);
		if (blobMatch) {
			const blobName = blobMatch[1];
			const prefix = `${workspaceId}.blob.${blobName}@`;
			if (
				!token.startsWith(prefix) ||
				!SHA256_TOKEN.test(token.slice(prefix.length))
			) {
				throw new Error('Application data version has an invalid blob plane');
			}
			continue;
		}
		throw new Error(`Unknown application data version plane '${planeName}'`);
	}
}

function assertDataVersion(dataVersion: number): void {
	if (!Number.isSafeInteger(dataVersion) || dataVersion <= 0) {
		throw new Error('Application data version must be a positive integer');
	}
}

function isStrictlySorted(values: readonly string[]): boolean {
	let previous: string | undefined;
	for (const value of values) {
		if (previous !== undefined && previous >= value) return false;
		previous = value;
	}
	return true;
}

function hasExactKeys(
	record: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const keys = Object.keys(record).sort();
	return (
		keys.length === expected.length &&
		keys.every((key, index) => key === expected[index])
	);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
