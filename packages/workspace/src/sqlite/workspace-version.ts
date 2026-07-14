import { assertSafeSegment } from '../shared/safe-segment.js';
import { isDocumentGuidLockTokenFor } from './document-guid.js';

export const WORKSPACE_VERSION_LOCK_FORMAT =
	'epicenter.workspace-version-lock/1' as const;
const SHA256_TOKEN = /^sha256:[0-9a-f]{64}$/;

export type WorkspaceVersionLockEntry = {
	readonly version: number;
	readonly workspaceId: string;
	readonly tablesSchemaHash: string;
	readonly planes: Readonly<Record<string, string>>;
};

export type WorkspaceVersionLock = {
	readonly format: typeof WORKSPACE_VERSION_LOCK_FORMAT;
	readonly appId: string;
	readonly versions: readonly WorkspaceVersionLockEntry[];
};

/**
 * Derive the app/version namespace inside one principal's server partition.
 * Applications author only `appId` and `version`; this ID is framework-owned.
 */
export function deriveWorkspaceId(appId: string, version: number): string {
	assertSafeSegment(appId, 'application id');
	assertVersion(version);
	return `${appId}-v${version}`;
}

/** Parse the exact append-only workspace version lock representation. */
export function parseWorkspaceVersionLock(
	value: unknown,
): WorkspaceVersionLock {
	if (
		!isPlainRecord(value) ||
		!hasExactKeys(value, ['appId', 'format', 'versions']) ||
		value.format !== WORKSPACE_VERSION_LOCK_FORMAT ||
		typeof value.appId !== 'string' ||
		!Array.isArray(value.versions) ||
		value.versions.length === 0
	) {
		throw new Error('Invalid workspace version lock');
	}
	assertSafeSegment(value.appId, 'application id');
	const appId = value.appId;

	let previousVersion = 0;
	const versions = value.versions.map((entry) => {
		if (
			!isPlainRecord(entry) ||
			!hasExactKeys(entry, [
				'planes',
				'tablesSchemaHash',
				'version',
				'workspaceId',
			]) ||
			typeof entry.version !== 'number' ||
			typeof entry.workspaceId !== 'string' ||
			typeof entry.tablesSchemaHash !== 'string' ||
			!isPlainRecord(entry.planes)
		) {
			throw new Error('Invalid workspace version lock entry');
		}
		assertVersion(entry.version);
		if (entry.version <= previousVersion) {
			throw new Error(
				'Workspace version lock entries must be strictly increasing',
			);
		}
		previousVersion = entry.version;
		if (entry.workspaceId !== deriveWorkspaceId(appId, entry.version)) {
			throw new Error(
				`Workspace version ${entry.version} has an invalid workspace id`,
			);
		}
		if (!SHA256_TOKEN.test(entry.tablesSchemaHash)) {
			throw new Error('Invalid workspace version tables schema hash');
		}

		const planeNames = Object.keys(entry.planes);
		if (!isStrictlySorted(planeNames)) {
			throw new Error('Workspace version planes must be canonically sorted');
		}
		const planes: Record<string, string> = {};
		for (const planeName of planeNames) {
			const planeValue = entry.planes[planeName];
			if (
				planeName.trim() === '' ||
				typeof planeValue !== 'string' ||
				planeValue.trim() === ''
			) {
				throw new Error('Invalid workspace version plane');
			}
			planes[planeName] = planeValue;
		}
		assertPlaneMap(entry.workspaceId, planes);

		return Object.freeze({
			version: entry.version,
			workspaceId: entry.workspaceId,
			tablesSchemaHash: entry.tablesSchemaHash,
			planes: Object.freeze(planes),
		});
	});

	return Object.freeze({
		format: WORKSPACE_VERSION_LOCK_FORMAT,
		appId,
		versions: Object.freeze(versions),
	});
}

function assertPlaneMap(
	workspaceId: string,
	planes: Readonly<Record<string, string>>,
): void {
	if (planes.kv !== `${workspaceId}.kv`) {
		throw new Error('Workspace version has an invalid KV identity');
	}
	for (const [planeName, token] of Object.entries(planes)) {
		if (planeName === 'kv') continue;
		if (planeName.startsWith('kv.')) {
			if (planeName.length === 'kv.'.length || !SHA256_TOKEN.test(token)) {
				throw new Error('Workspace version has an invalid KV plane');
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
					'Workspace version has an invalid child-document plane',
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
					'Workspace version has an invalid child-document plane',
				);
			}
			continue;
		}
		throw new Error(`Unknown workspace version plane '${planeName}'`);
	}
}

function assertVersion(version: number): void {
	if (!Number.isSafeInteger(version) || version <= 0) {
		throw new Error('Workspace version must be a positive integer');
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
