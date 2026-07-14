import type { KvDefinitions } from '../document/kv.js';
import { APPLICATION_DATA_VERSION_LOCK_FORMAT } from './data-version.js';
import {
	type BlobPlaneContracts,
	defineWorkspace,
	lockWorkspace,
	type TableDefinitions,
	type WorkspaceDefinition,
} from './definition.js';

/** Build one locked version for tests outside the lock-validation suite. */
export function defineTestWorkspace<
	const TTables extends TableDefinitions,
	const TKv extends KvDefinitions = Record<never, never>,
	const TBlobs extends BlobPlaneContracts = Record<never, never>,
>(config: {
	appId: string;
	dataVersion?: number;
	name?: string;
	tables: TTables;
	kv?: TKv;
	blobs?: TBlobs;
}): WorkspaceDefinition<TTables, TKv, TBlobs> {
	const candidate = defineWorkspace({
		...config,
		dataVersion: config.dataVersion ?? 1,
	});
	return lockWorkspace(candidate, {
		format: APPLICATION_DATA_VERSION_LOCK_FORMAT,
		appId: candidate.appId,
		versions: [candidate.proposedLockEntry],
	});
}
