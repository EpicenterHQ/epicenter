/** Subprocess contender: own auth instance and connection, released by stdin EOF. */
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { createAuth } from '../auth/create-auth.js';
import * as schema from '../db/schema/index.js';

const argument = process.argv[2];
assert(argument);
const input = JSON.parse(argument) as {
	port: number;
	options: Pick<
		Parameters<typeof createAuth>[0],
		'env' | 'baseURL' | 'trustedOrigins' | 'sessionCallbacks'
	>;
};
const client = new Client({
	host: '127.0.0.1',
	port: input.port,
	user: 'postgres',
	database: 'postgres',
	password: 'disposable-test-only',
	ssl: false,
	connectionTimeoutMillis: 5_000,
	query_timeout: 10_000,
});
try {
	await client.connect();
	const auth = createAuth({
		...input.options,
		db: drizzle(client, { schema }),
	});
	await auth.$context;
	const { rows } = await client.query<{ pid: number }>(
		'select pg_backend_pid() as pid',
	);
	assert(rows[0]);
	process.stdout.write(
		`${JSON.stringify({ pid: process.pid, backendPid: rows[0].pid })}\n`,
	);
	const body = await Bun.stdin.text();
	const response = await auth.handler(
		new Request(`${input.options.baseURL}/auth/session/redeem`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		}),
	);
	process.stdout.write(
		JSON.stringify({
			status: response.status,
			cookie: response.headers.get('set-cookie'),
			body: await response.json(),
		}),
	);
} finally {
	await client.end();
}
