/**
 * Serve one repository over the repository's wire on this machine:
 *
 *   bun packages/repository/scripts/serve.ts <repo-dir> [--repository <name>] [--port 8787] [--host 127.0.0.1] [--origin http://127.0.0.1:5173 ...]
 *
 * The web shell reaches it by a join link,
 * `/<owner>/<name>?server=http://127.0.0.1:8787/`: the repository `<name>`
 * (by default the directory's name without `.git`), any owner (this server
 * does not check owners), and any name to sync as.
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
 */
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDiskRepository, serveRepository } from '../src/bun/serve.js';
import { authenticateBearer } from '../src/wire/wire.js';

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		repository: { type: 'string' },
		port: { type: 'string', default: '8787' },
		host: { type: 'string', default: '127.0.0.1' },
		origin: { type: 'string', multiple: true, default: [] },
	},
});
const [dir] = positionals;
if (dir === undefined) {
	console.error('Usage: bun packages/repository/scripts/serve.ts <repo-dir> [--repository <name>] [--port 8787] [--host 127.0.0.1] [--origin <url> ...]');
	process.exit(2);
}
const server = await openDiskRepository(resolve(dir));
// The name a replica binds to, which a join link names.
const repository = values.repository ?? basename(resolve(dir)).replace(/\.git$/, '');
const served = serveRepository({
	repository,
	// This machine's server; a replica binds to it.
	serverId: `local:${values.host}`,
	server,
	authenticate: authenticateBearer((token) => ({ user: token, role: 'owner' })),
	hostname: values.host,
	port: Number(values.port),
	origins: values.origin,
});
console.log(`Serving ${resolve(dir)} as the repository '${repository}' at ${served.url} (Authorization: Bearer <name>)`);
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
