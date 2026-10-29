/**
 * Serve one repository over design B's wire on this machine:
 *
 *   bun packages/repository/scripts/serve.ts <repo-dir> [--port 8787] [--host 127.0.0.1] [--origin http://127.0.0.1:5173 ...]
 *
 * `<repo-dir>` is a bare Git repository, created when missing; live history
 * is kept in `<repo-dir>/epicenter/live.sqlite` and flushed into Git after a
 * minute of quiet (at once on Ctrl-C), so `git clone <repo-dir>` reads what
 * was written. Authentication is for development only: `Authorization:
 * Bearer <name>` makes anyone the owner named `<name>`. Each `--origin` lets
 * pages from that origin call the server; their sockets connect with a
 * ticket from `POST /tickets`.
 *
 *   curl -H 'Authorization: Bearer me' http://127.0.0.1:8787/catch-up?from=
 *   curl -X PUT -H 'Authorization: Bearer me' -H 'If-None-Match: *' --data-binary $'---\ntitle: Hi\n---\n' http://127.0.0.1:8787/files/notes/hi.md
 *
 * Today's apps still sync through `scripts/serve-legacy.ts`.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDiskRepository, serveRepository } from '../src/bun/serve.js';
import { authenticateBearer } from '../src/wire/wire.js';

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		port: { type: 'string', default: '8787' },
		host: { type: 'string', default: '127.0.0.1' },
		origin: { type: 'string', multiple: true, default: [] },
	},
});
const [dir] = positionals;
if (dir === undefined) {
	console.error('Usage: bun packages/repository/scripts/serve.ts <repo-dir> [--port 8787] [--host 127.0.0.1] [--origin <url> ...]');
	process.exit(2);
}
const server = await openDiskRepository(resolve(dir));
const served = serveRepository({
	// A repository on disk is identified by its directory.
	repository: resolve(dir),
	server,
	authenticate: authenticateBearer((token) => ({ user: token, role: 'owner' })),
	hostname: values.host,
	port: Number(values.port),
	origins: values.origin,
});
console.log(`Serving ${resolve(dir)} at ${served.url} (Authorization: Bearer <name>)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
	process.on(signal, () => {
		void server
			.flush()
			.then(() => server.idle())
			.finally(async () => {
				await served.stop();
				process.exit(0);
			});
	});
