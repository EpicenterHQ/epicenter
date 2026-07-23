/**
 * The client's host-discovery surface (ADR-0115 clause 3): `GET /attach/hosts`
 * returns this principal's attachable Super Chat hosts, each as the closed
 * `{ hostId, label, status }` entry and nothing else. It is the step before
 * attach: a signed-in phone learns which desktops it may dial and whether one is
 * live, then points the existing AttachRelay client at the chosen `hostId`.
 *
 * ## Read-only, and closed
 *
 * This is a plain HTTP read at the account-and-device layer, above the relay. It
 * carries no route name, capability, action, tool, or topic: the response items
 * are {@link AttachHostDirectoryEntry}s, whose schema rejects every such field, so
 * the directory cannot grow into a capability registry (the PR #2277 guard). There
 * is no write route here: a host publishes itself by the act of connecting as a
 * host (the mount records its membership), and liveness is the live host socket,
 * never a heartbeat the client PUTs. The one surface is this GET.
 *
 * ## Same shape, two sources
 *
 * The deployment binds the backend through `resolveHostDirectory`, exactly the
 * `resolveRelay` seam: a Bun self-host returns its process
 * directory (`createAttachRelayBunServer().hostDirectory`), and a Cloud
 * per-principal index is a later refinement behind the same seam. The mount stays
 * backend-blind; the principal is stamped from the resolved bearer, never the
 * query, so a client only ever reads its own principal's hosts.
 */

import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { requireBearerPrincipal } from '../middleware/require-auth.js';
import type { ServerBindings } from '../server-bindings.js';
import type { Env, ResolveBearerPrincipal } from '../types.js';
import type { HostDirectoryReader } from './host-directory.js';

/**
 * Mount the host-discovery surface on a deployment's server app.
 *
 * Bundles the bearer gate and the one `GET /attach/hosts` read, the same shape
 * `mountAttachGrantsApp` uses. The bearer is the deployment's attach credential
 * (a per-device grant on self-host, a signed-in session on Cloud): the same
 * credential a client attaches with, so discovery and attach share one gate.
 * `resolveHostDirectory` binds this runtime's directory backend from the
 * per-request env, backend-blind here.
 */
export function mountHostDirectoryApp<E extends Env = Env>(
	app: Hono<E>,
	opts: {
		resolveBearerPrincipal: ResolveBearerPrincipal<E>;
		resolveHostDirectory: (env: ServerBindings) => HostDirectoryReader;
	},
): void {
	app.use('/attach/hosts', requireBearerPrincipal(opts.resolveBearerPrincipal));
	app.route('/', createHostDirectoryApp(opts.resolveHostDirectory));
}

/**
 * The one `GET /attach/hosts` route, on the concrete portable {@link Env} so it
 * reads the resolved `c.var.principal` and hands `c.env` to `resolveHostDirectory`
 * (a {@link ServerBindings} consumer). The bearer gate is applied upstream by
 * {@link mountHostDirectoryApp}; by the time this runs, `principal` is set. This
 * mirrors how `mount.ts` splits its generic mount from its concrete route.
 */
function createHostDirectoryApp(
	resolveHostDirectory: (env: ServerBindings) => HostDirectoryReader,
): Hono<Env> {
	return new Hono<Env>().get(
		'/attach/hosts',
		describeRoute({
			description: "List this principal's attachable Super Chat hosts",
			tags: ['attach-relay'],
		}),
		async (c) => {
			// The principal is the resolved bearer's, stamped by the gate upstream,
			// never the query's: a client reads only its own principal's hosts.
			const hosts = await resolveHostDirectory(c.env).list(c.var.principal.id);
			return c.json({ hosts });
		},
	);
}
