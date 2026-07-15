import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { attachYjsLog } from './attach-yjs-log.js';
import type { LocalPersistence } from './workspace.js';

export type BunLocalPersistenceOptions = {
	/** Directory that owns this host's local Yjs update logs. */
	readonly dir: string;
};

function storageFileName(guid: string): string {
	return `${encodeURIComponent(guid)}.db`;
}

function storageDir(dir: string): string {
	return join(dir, 'yjs');
}

export function bunLocalPersistence({
	dir,
}: BunLocalPersistenceOptions): LocalPersistence {
	return {
		attach(ydoc) {
			const yjsLog = attachYjsLog(ydoc, {
				filePath: join(storageDir(dir), storageFileName(ydoc.guid)),
			});
			return {
				whenLoaded: Promise.resolve(),
				whenDisposed: yjsLog.whenDisposed,
			};
		},
		async wipe(workspaceId) {
			const dirPath = storageDir(dir);
			if (!existsSync(dirPath)) return;
			const rootName = storageFileName(workspaceId);
			const childPrefix = `${encodeURIComponent(`${workspaceId}.`)}`;
			for (const name of readdirSync(dirPath)) {
				if (name === rootName || name.startsWith(childPrefix)) {
					rmSync(join(dirPath, name), { force: true });
					rmSync(join(dirPath, `${name}-wal`), { force: true });
					rmSync(join(dirPath, `${name}-shm`), { force: true });
				}
			}
		},
	};
}
