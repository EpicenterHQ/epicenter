/**
 * Cloudflare backend for the db concern: a per-request `pg.Client` over the
 * Hyperdrive connection string.
 *
 * A deployment passes the
 * `HYPERDRIVE` binding from its `c.env` and gets back the runtime-neutral
 * `{ db, close }` handle that `createServerApp`'s `db.connect` leg
 * expects. Only apps/api's Worker calls this; its Bun entry injects its own
 * `db.connect` over a module-scope `pg.Pool` instead.
 *
 * Uses `Client` (not `Pool`) because Hyperdrive IS the connection pool.
 */

import pg from 'pg';
import { createDb, type Db } from '../create-db.js';

/**
 * Open a per-request database handle over a Hyperdrive binding. The caller
 * (`createCloudContextMiddleware`'s `connect`) closes it after the
 * after-response queue drains. It reads only the binding's connection string,
 * so a Bun program typechecks the main barrel without Workers types.
 */
export async function connectHyperdriveDb(hyperdrive: {
	connectionString: string;
}): Promise<{ db: Db; close: () => Promise<void> }> {
	const client = new pg.Client({
		connectionString: hyperdrive.connectionString,
	});
	await client.connect();
	return { db: createDb(client), close: () => client.end() };
}
