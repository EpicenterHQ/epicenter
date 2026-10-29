/**
 * Serve one repository over WebSocket on this machine:
 *
 *   bun packages/repository/scripts/serve-legacy.ts <repo-dir> [--port 8787] [--host 127.0.0.1]
 *
 * `<repo-dir>` is a bare Git repository, created when missing; clone it with
 * `git clone <repo-dir>` to read what devices wrote once it is committed.
 * Devices connect to `ws://<host>:<port>/?user=<name>`.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serveRepository } from '../src/legacy-ws/server.js';

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		port: { type: 'string', default: '8787' },
		host: { type: 'string', default: '127.0.0.1' },
		'commit-after': { type: 'string', default: '60000' },
	},
});
const [dir] = positionals;
if (dir === undefined) {
	console.error('Usage: bun packages/repository/scripts/serve-legacy.ts <repo-dir> [--port 8787] [--host 127.0.0.1] [--commit-after ms]');
	process.exit(2);
}
const served = await serveRepository({
	dir: resolve(dir),
	hostname: values.host,
	port: Number(values.port),
	commitAfterMs: Number(values['commit-after']),
});
console.log(`Serving ${resolve(dir)} at ${served.url}?user=<name>`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
	process.on(signal, () => {
		void served.repository.commit().then(async () => {
			await served.stop();
			process.exit(0);
		});
	});
