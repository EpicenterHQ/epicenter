import type { KvDefinitions } from '../document/kv.js';
import {
	defineWorkspace,
	lockWorkspace,
	type TableDefinitions,
	type WorkspaceDefinition,
} from './definition.js';
import { WORKSPACE_VERSION_LOCK_FORMAT } from './workspace-version.js';

/** Build one locked version for tests outside the lock-validation suite. */
export function defineTestWorkspace<
	const TTables extends TableDefinitions,
	const TKv extends KvDefinitions = Record<never, never>,
>(config: {
	appId: string;
	version?: number;
	name?: string;
	tables: TTables;
	kv?: TKv;
}): WorkspaceDefinition<TTables, TKv> {
	const candidate = defineWorkspace({
		...config,
		version: config.version ?? 1,
	});
	return lockWorkspace(candidate, {
		format: WORKSPACE_VERSION_LOCK_FORMAT,
		appId: candidate.appId,
		versions: [candidate.proposedLockEntry],
	});
}
