import { join, resolve } from 'node:path';

/** Server and local operator commands resolve the same persistent root. */
export function selfHostDataPaths(setting = process.env.SELF_HOST_DATA_ROOT) {
	const root = resolve(import.meta.dir, setting ?? './data');
	return {
		root,
		auth: join(root, 'auth.sqlite'),
		blobs: join(root, 'blobs.sqlite'),
		sync: join(root, 'sync'),
	};
}
