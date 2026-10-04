import { homedir } from 'node:os';
import { join } from 'node:path';

/** OS-appropriate home for the archive database and content-addressed blobs. */
export function defaultDataDir(): string {
	if (process.platform === 'darwin') {
		return join(homedir(), 'Library', 'Application Support', 'local-photos');
	}
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg && xdg.length > 0) return join(xdg, 'local-photos');
	return join(homedir(), '.local', 'share', 'local-photos');
}

/** `--data-dir` beats `LOCAL_PHOTOS_DIR`, which beats the OS default. */
export function resolveDataDir(override?: string): string {
	if (override && override.length > 0) return override;
	const configured = process.env.LOCAL_PHOTOS_DIR;
	if (configured && configured.length > 0) return configured;
	return defaultDataDir();
}

export function photosDbPath(dataDir: string): string {
	return join(dataDir, 'photos.db');
}

export function blobsDir(dataDir: string): string {
	return join(dataDir, 'blobs');
}
