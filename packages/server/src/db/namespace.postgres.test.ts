/**
 * Every account has exactly one personal namespace, made in the transaction
 * that inserts the account (ADR-0547), on a disposable Postgres cluster with
 * every migration applied.
 * Requires initdb and pg_ctl on PATH; never connects to a configured database.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import { createAuth } from '../auth/create-auth.js';
import {
	type DisposablePostgres,
	startDisposablePostgres,
} from '../test-helpers/disposable-postgres.js';
import { createDb } from './create-db.js';

let cluster: DisposablePostgres;
let sql: Client;

beforeAll(async () => {
	cluster = await startDisposablePostgres();
	sql = cluster.clients[0];
	await migrate(createDb(sql), {
		migrationsFolder: fileURLToPath(
			new URL('../../../../apps/api/drizzle/', import.meta.url),
		),
	});
}, 60_000);
afterAll(() => cluster?.stop());

async function namespacesOf(accountId: string, client: Client = sql) {
	const { rows } = await client.query<{
		id: string;
		title: string;
		role: string;
		member: string;
	}>(
		`select n.id, n.title, m.role, m.account_id as member
		 from namespace n join namespace_member m on m.namespace_id = n.id
		 where n.personal_account_id = $1`,
		[accountId],
	);
	return rows;
}

test('an account Better Auth creates gets one personal namespace it owns', async () => {
	const auth = createAuth({
		db: createDb(sql),
		env: { BETTER_AUTH_SECRET: 'namespace-postgres-secret-0123456789' },
		baseURL: 'https://api.example.test',
		trustedOrigins: [],
	});
	const context = await auth.$context;
	const account = await context.internalAdapter.createUser(
		{ name: 'Alice', email: 'alice@example.test', emailVerified: true },
		{ method: 'admin' },
	);
	const rows = await namespacesOf(account.id);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		title: 'Personal',
		role: 'owner',
		member: account.id,
	});
	expect(rows[0]?.id).toMatch(/^[a-z0-9]{12}$/);
});

test('the namespace is part of the transaction that inserts the account', async () => {
	await sql.query('begin');
	try {
		await sql.query(
			`insert into "user" (id, name, email, email_verified, created_at, updated_at)
			 values ('rolled-back', 'Rolled back', 'rolled-back@example.test', true, now(), now())`,
		);
		// The other connection sees nothing until commit; this one sees both.
		expect(await namespacesOf('rolled-back')).toHaveLength(1);
		expect(await namespacesOf('rolled-back', cluster.clients[1])).toHaveLength(
			0,
		);
	} finally {
		await sql.query('rollback');
	}
	expect(await namespacesOf('rolled-back')).toHaveLength(0);
	const { rowCount } = await sql.query(
		'select 1 from namespace_member where account_id = $1',
		['rolled-back'],
	);
	expect(rowCount).toBe(0);
});

test('an account the trigger cannot give a namespace is not created', async () => {
	// A namespace id that breaks the format check stands in for any failure
	// inside the trigger: the account insert fails with it.
	await sql.query('begin');
	try {
		await sql.query(
			`create or replace function new_namespace_id() returns text language sql as $$ select 'NOT-VALID' $$`,
		);
		await expect(
			sql.query(
				`insert into "user" (id, name, email, email_verified, created_at, updated_at)
				 values ('orphan', 'Orphan', 'orphan@example.test', true, now(), now())`,
			),
		).rejects.toThrow(/namespace_id_format/);
	} finally {
		await sql.query('rollback');
	}
	const { rowCount } = await sql.query('select 1 from "user" where id = $1', [
		'orphan',
	]);
	expect(rowCount).toBe(0);
});

test('an account that predates namespaces gets one from the backfill, and only one', async () => {
	await sql.query('alter table "user" disable trigger user_personal_namespace');
	try {
		await sql.query(
			`insert into "user" (id, name, email, email_verified, created_at, updated_at)
			 values ('older', 'Older', 'older@example.test', true, now(), now())`,
		);
	} finally {
		await sql.query(
			'alter table "user" enable trigger user_personal_namespace',
		);
	}
	expect(await namespacesOf('older')).toHaveLength(0);
	await sql.query("select create_personal_namespace('older')");
	await sql.query("select create_personal_namespace('older')");
	expect(await namespacesOf('older')).toHaveLength(1);
});

test('deleting an account deletes its personal namespace and memberships', async () => {
	await sql.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ('leaving', 'Leaving', 'leaving@example.test', true, now(), now())`,
	);
	const [personal] = await namespacesOf('leaving');
	await sql.query(`delete from "user" where id = 'leaving'`);
	const { rowCount } = await sql.query(
		'select 1 from namespace where id = $1 union all select 1 from namespace_member where account_id = $2',
		[personal?.id, 'leaving'],
	);
	expect(rowCount).toBe(0);
});
