/**
 * Migration `0009` carries the namespace model's repositories into folders
 * (ADR-0811), on a disposable Postgres cluster: the migrations before it are
 * applied, a namespace's repositories, members, and grants are written as
 * that model wrote them, and `0009` then runs over them.
 * Requires initdb and pg_ctl on PATH; never connects to a configured database.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import {
	type DisposablePostgres,
	startDisposablePostgres,
} from '../test-helpers/disposable-postgres.js';
import { createDb } from './create-db.js';

const migrations = fileURLToPath(
	new URL('../../../../apps/api/drizzle/', import.meta.url),
);

let cluster: DisposablePostgres;
let sql: Client;
let before: string;

beforeAll(async () => {
	cluster = await startDisposablePostgres();
	sql = cluster.clients[0];
	// The migrations as they stood before folders.
	before = await mkdtemp(join(tmpdir(), 'epicenter-migrations-'));
	await cp(migrations, before, { recursive: true });
	const journal = JSON.parse(
		await readFile(join(before, 'meta/_journal.json'), 'utf8'),
	) as { entries: { tag: string }[] };
	journal.entries = journal.entries.filter(({ tag }) => tag !== '0009_folders');
	await writeFile(join(before, 'meta/_journal.json'), JSON.stringify(journal));
	await migrate(createDb(sql), { migrationsFolder: before });
}, 60_000);

afterAll(async () => {
	await cluster?.stop();
	if (before) await rm(before, { recursive: true, force: true });
});

async function account(id: string) {
	await sql.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ($1, $1, $1 || '@example.test', true, now(), now())`,
		[id],
	);
	const { rows } = await sql.query<{ id: string }>(
		'select id from namespace where personal_account_id = $1',
		[id],
	);
	return rows[0]?.id as string;
}

test("each repository becomes the folder of its id, held by its namespace's members and its grantees, and a web app's is attached to it", async () => {
	const alice = await account('alice');
	await account('bob');
	await account('carol');
	await sql.query(
		`insert into oauth_client (id, client_id, redirect_uris) values
		 ('so.epicenter.todos', 'so.epicenter.todos', '{}'),
		 ('com.bradenwong.zhongwen', 'com.bradenwong.zhongwen', '{}')`,
	);
	await sql.query(
		`insert into namespace (id, title) values ('family000000', 'Family')`,
	);
	await sql.query(
		`insert into namespace_member (namespace_id, account_id, role) values
		 ('family000000', 'alice', 'owner'), ('family000000', 'bob', 'member')`,
	);
	await sql.query(
		`insert into repository (id, namespace_id, name) values
		 ('todos00000000000', $1, 'todos'),
		 ('zhongwen00000000', $1, 'zhongwen.bradenwong.com'),
		 ('notes00000000000', $1, 'notes'),
		 ('shared0000000000', 'family000000', 'todos')`,
		[alice],
	);
	await sql.query(
		`insert into repository_grant (repository_id, account_id, level) values
		 ('notes00000000000', 'carol', 'read'), ('shared0000000000', 'carol', 'write')`,
	);
	await sql.query(
		`insert into blob_upload (repository_id, oid) values ('notes00000000000', $1)`,
		['a'.repeat(64)],
	);

	await migrate(createDb(sql), { migrationsFolder: migrations });

	const members = await sql.query<{
		folder_id: string;
		account_id: string;
		role: string;
		accepted: boolean;
	}>(
		`select folder_id, account_id, role, accepted_at is not null as accepted
		 from folder_member order by folder_id, account_id`,
	);
	expect(members.rows).toEqual([
		{
			folder_id: 'notes00000000000',
			account_id: 'alice',
			role: 'owner',
			accepted: true,
		},
		{
			folder_id: 'notes00000000000',
			account_id: 'carol',
			role: 'reader',
			accepted: true,
		},
		{
			folder_id: 'shared0000000000',
			account_id: 'alice',
			role: 'owner',
			accepted: true,
		},
		{
			folder_id: 'shared0000000000',
			account_id: 'bob',
			role: 'writer',
			accepted: true,
		},
		{
			folder_id: 'shared0000000000',
			account_id: 'carol',
			role: 'writer',
			accepted: true,
		},
		{
			folder_id: 'todos00000000000',
			account_id: 'alice',
			role: 'owner',
			accepted: true,
		},
		{
			folder_id: 'zhongwen00000000',
			account_id: 'alice',
			role: 'owner',
			accepted: true,
		},
	]);
	const apps = await sql.query(
		'select folder_id, app from folder_app order by folder_id',
	);
	expect(apps.rows).toEqual([
		{ folder_id: 'todos00000000000', app: 'so.epicenter.todos' },
		{ folder_id: 'zhongwen00000000', app: 'com.bradenwong.zhongwen' },
	]);
	expect((await sql.query('select folder_id from blob_upload')).rows).toEqual([
		{ folder_id: 'notes00000000000' },
	]);
	for (const table of [
		'namespace',
		'namespace_member',
		'repository',
		'repository_grant',
	])
		expect(
			(await sql.query('select to_regclass($1) as found', [table])).rows[0],
		).toEqual({ found: null });
	// A new account gets no namespace, and nothing else.
	await sql.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ('dave', 'dave', 'dave@example.test', true, now(), now())`,
	);
	expect(
		(await sql.query("select 1 from folder_member where account_id = 'dave'"))
			.rowCount,
	).toBe(0);
}, 60_000);

test('a folder goes with its last member, and its last owner leaving makes the earliest member an owner', async () => {
	await sql.query("insert into folder (id) values ('left000000000000')");
	await sql.query(
		`insert into folder_member (folder_id, account_id, role, accepted_at) values
		 ('left000000000000', 'alice', 'owner', now() - interval '2 days'),
		 ('left000000000000', 'bob', 'writer', now() - interval '1 day'),
		 ('left000000000000', 'carol', 'reader', now())`,
	);
	await sql.query(
		"insert into folder_member (folder_id, account_id, role) values ('left000000000000', 'dave', 'owner')",
	);
	await sql.query(
		"delete from folder_member where folder_id = 'left000000000000' and account_id = 'alice'",
	);
	const roles = async () =>
		(
			await sql.query(
				"select account_id, role from folder_member where folder_id = 'left000000000000' order by account_id",
			)
		).rows;
	expect(await roles()).toEqual([
		{ account_id: 'bob', role: 'owner' },
		{ account_id: 'carol', role: 'reader' },
		{ account_id: 'dave', role: 'owner' },
	]);
	await sql.query('delete from "user" where id = $1', ['bob']);
	expect(await roles()).toEqual([
		{ account_id: 'carol', role: 'owner' },
		{ account_id: 'dave', role: 'owner' },
	]);
	// Dave never accepted: the folder lives while Carol remains, and goes with her.
	await sql.query(
		"delete from folder_member where folder_id = 'left000000000000' and account_id = 'carol'",
	);
	expect(
		(await sql.query("select 1 from folder where id = 'left000000000000'"))
			.rowCount,
	).toBe(0);
	expect(await roles()).toEqual([]);
}, 60_000);
