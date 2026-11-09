/**
 * Portable drizzle database handle.
 *
 * `createDb(client)` wraps a connected `pg` client or pool in drizzle with
 * the library's own schema, so the schema stays internal to
 * `@epicenter/server` and a deployment hands in only a connected client.
 * Both apps/api entries funnel through this: the Worker (a per-request
 * `pg.Client` over Hyperdrive, `worker/index.ts`) and the Bun entry (a
 * module-scope `pg.Pool`, `server.ts`). `pg` + drizzle are the open
 * Postgres-wire standard both runtimes already speak (ADR-0066 Road 1); only
 * connection acquisition differs, which is what the runtime's `db.connect` injects.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Client, Pool } from 'pg';
import * as schema from './schema/index.js';

/** The library's drizzle database handle, bound to its own schema. */
export type Db = NodePgDatabase<typeof schema>;

/**
 * Wrap a connected `pg` client (Cloudflare per-request) or pool (Node host)
 * in drizzle with the library schema. The caller owns connect and close;
 * this only binds the schema so it never leaks across the package boundary.
 */
export function createDb(client: Client | Pool): Db {
	return drizzle(client, { schema });
}
