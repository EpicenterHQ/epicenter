/**
 * Hosted Git (ADR-0546, ADR-0547) end to end on Bun: the real routes behind
 * the real authorization server on a disposable Postgres cluster, a real
 * `Bun.serve` listener, the disk store, and the system `git` as the client.
 * Requires initdb, pg_ctl, and git on PATH; never connects to a configured
 * database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RepositoryListing } from '@epicenter/constants/repositories';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { type Client, Pool } from 'pg';
import { registerFirstPartyClients } from '../auth/oauth-registrations.js';
import { createCloudContextMiddleware } from '../create-cloud-context-middleware.js';
import { createDb, type Db } from '../db/create-db.js';
import { createDiskGitHost } from '../git-disk-store.js';
import { moveRepository, renameRepository } from '../repositories.js';
import { createServerApp } from '../server-app.js';
import { startDisposablePostgres } from '../test-helpers/disposable-postgres.js';
import { OAuthTestClient, type Person } from '../test-helpers/oauth-client.js';
import type { CloudEnv } from '../types.js';
import { mountAuthRoutes } from './auth.js';
import { mountGitHost } from './git.js';

const secret = 'git-postgres-secret-0123456789abcdefghij';
const todos = {
	clientId: 'so.epicenter.todos',
	redirectUri: 'https://todos.example.test/auth/callback',
};

let origin = '';
let audiences = { api: '', git: '' };
let scratch: string;
let storeRoot: string;
let stopPostgres: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let sql: Client;
let db: Db;
let pool: Pool;
let client: OAuthTestClient;

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), 'epicenter-git-test-'));
	storeRoot = join(scratch, 'store');
	const cluster = await startDisposablePostgres();
	stopPostgres = cluster.stop;
	sql = cluster.clients[0];
	db = createDb(sql);
	await migrate(db, {
		migrationsFolder: fileURLToPath(
			new URL('../../../../apps/api/drizzle/', import.meta.url),
		),
	});
	const app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => [origin],
		resolveAudiences: () => audiences,
	});
	server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch: (request) => app.fetch(request),
		// A push can pause between its two requests; do not drop it.
		idleTimeout: 30,
	});
	origin = `http://127.0.0.1:${server.port}`;
	audiences = { api: origin, git: `${origin}/git` };
	await registerFirstPartyClients(db, {
		audiences,
		clients: [
			{
				clientId: todos.clientId,
				name: 'Todos',
				redirectUris: [todos.redirectUri],
				grantTypes: ['authorization_code'],
				scopes: ['openid', 'profile', 'folders:read', 'folders:write'],
				resources: [audiences.api, audiences.git],
				skipConsent: true,
				applicationType: 'web',
			},
		],
	});
	// Requests run at once, as concurrent pushes do, so each takes its own
	// connection, as a deployment's pool gives it.
	pool = new Pool({
		host: '127.0.0.1',
		port: cluster.port,
		user: 'postgres',
		database: 'postgres',
	});
	const requestDb = createDb(pool);
	const context = {
		connect: async () => ({ db: requestDb, close: async () => {} }),
		afterResponse: () => {},
		resolveAuthSecrets: () => ({ BETTER_AUTH_SECRET: secret }),
	};
	mountAuthRoutes(app, {
		setup: createCloudContextMiddleware({
			...context,
			oauthServer: true,
		}),
		serveAuthUiShell: (c) => c.html('<html>shell</html>'),
	});
	const host = createDiskGitHost({ root: storeRoot });
	mountGitHost(app, {
		setup: createCloudContextMiddleware(context),
		resolveHost: () => host,
	});
	client = new OAuthTestClient(origin, sql, secret, async (url, init) =>
		app.fetch(new Request(url, init)),
	);
}, 60_000);

afterAll(async () => {
	server?.stop(true);
	await pool?.end();
	await stopPostgres?.();
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** A person and a Git-audience token for them. */
async function signedIn(
	label: string,
	scope = 'openid folders:read folders:write',
	resource = audiences.git,
) {
	const person: Person = await client.person(label);
	const tokens = await client.codeGrant({
		...todos,
		cookie: person.cookie,
		resource: [resource],
		scope,
	});
	return { person, token: tokens.access_token };
}

type Run = { code: number; stdout: string; stderr: string };

/** The system `git`, in a clean environment, sending `token` as a Bearer header. */
async function git(
	cwd: string,
	token: string | null,
	...args: string[]
): Promise<Run> {
	const child = Bun.spawn(
		[
			'git',
			'-c',
			'core.hooksPath=/dev/null',
			'-c',
			'protocol.version=2',
			...(token === null
				? []
				: ['-c', `http.extraHeader=Authorization: Bearer ${token}`]),
			...args,
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: scratch,
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_TERMINAL_PROMPT: '0',
				GIT_AUTHOR_NAME: 'Test',
				GIT_AUTHOR_EMAIL: 'test@example.test',
				GIT_COMMITTER_NAME: 'Test',
				GIT_COMMITTER_EMAIL: 'test@example.test',
			},
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

/** A working copy with one commit holding `files`. */
async function workingCopy(name: string, files: Record<string, string>) {
	const dir = join(scratch, `${name}-${crypto.randomUUID().slice(0, 8)}`);
	await mkdir(dir, { recursive: true });
	await git(dir, null, 'init', '--quiet', '--initial-branch=main');
	await commit(dir, files, 'first');
	return dir;
}

async function commit(
	dir: string,
	files: Record<string, string>,
	message: string,
) {
	for (const [path, text] of Object.entries(files))
		await writeFile(join(dir, path), text);
	await git(dir, null, 'add', '--all');
	const done = await git(dir, null, 'commit', '--quiet', '-m', message);
	expect(done.code).toBe(0);
}

const remote = (namespace: string, name: string) =>
	`${audiences.git}/${namespace}/${name}.git`;

/** The repository ids the disk store holds. */
const stored = async () =>
	(await readdir(storeRoot))
		.filter((entry) => entry.endsWith('.git'))
		.map((entry) => entry.slice(0, -'.git'.length))
		.sort();

const repositoryRows = async (namespace: string) =>
	(
		await sql.query<{ id: string; name: string }>(
			'select id, name from repository where namespace_id = $1 order by name',
			[namespace],
		)
	).rows;

describe('hosted Git over the disk store', () => {
	test('the first push creates the repository, then clone, fetch, and push work', async () => {
		const { person, token } = await signedIn('owner');
		const url = remote(person.personal, 'notes');
		const first = await workingCopy('notes', { 'a.md': 'one\n' });

		// Nothing exists yet: one who may push reads an empty repository, and
		// reading creates nothing, under protocol v2 or v0.
		for (const version of ['2', '0']) {
			const missing = await git(
				first,
				token,
				'-c',
				`protocol.version=${version}`,
				'ls-remote',
				url,
			);
			expect(missing.code).toBe(0);
			expect(missing.stdout).toBe('');
		}
		const probe = await fetch(`${url}/info/refs?service=git-receive-pack`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(probe.status).toBe(200);
		expect(probe.headers.get('content-type')).toBe(
			'application/x-git-receive-pack-advertisement',
		);
		await probe.body?.cancel();
		const upload = await fetch(`${url}/git-upload-pack`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/x-git-upload-pack-request',
			},
			body: '0000',
		});
		expect(upload.status).toBe(404);
		expect(await repositoryRows(person.personal)).toEqual([]);
		expect(await readdir(storeRoot).catch(() => [])).not.toContainEqual(
			expect.stringMatching(/\.git$/),
		);
		// A clone of the empty name is empty, and a sync that fetches first
		// finds nothing to take.
		const empty = join(scratch, `empty-${crypto.randomUUID().slice(0, 8)}`);
		const emptyClone = await git(scratch, token, 'clone', url, empty);
		expect(emptyClone.code).toBe(0);
		expect(emptyClone.stderr).toContain('empty repository');
		const nothing = await git(first, token, 'fetch', url, 'main');
		expect(nothing.stderr).toContain("couldn't find remote ref main");
		expect(await repositoryRows(person.personal)).toEqual([]);

		const pushed = await git(first, token, 'push', url, 'HEAD:main');
		expect(pushed.stderr).not.toContain('rejected');
		expect(pushed.code).toBe(0);
		const [row] = await repositoryRows(person.personal);
		expect(row?.name).toBe('notes');
		// Storage is named by the immutable id, never by the URL.
		expect((await readdir(storeRoot)).includes(`${row?.id}.git`)).toBe(true);

		const second = join(scratch, `clone-${crypto.randomUUID().slice(0, 8)}`);
		const cloned = await git(scratch, token, 'clone', url, second);
		expect(cloned.code).toBe(0);
		expect(await Bun.file(join(second, 'a.md')).text()).toBe('one\n');

		await commit(first, { 'b.md': 'two\n' }, 'second');
		expect((await git(first, token, 'push', url, 'HEAD:main')).code).toBe(0);
		expect(
			(await git(second, token, 'pull', '--ff-only', 'origin', 'main')).code,
		).toBe(0);
		expect(await Bun.file(join(second, 'b.md')).text()).toBe('two\n');

		// A push from the clone is an ordinary fast-forward.
		await commit(second, { 'c.md': 'three\n' }, 'third');
		expect((await git(second, token, 'push', 'origin', 'HEAD:main')).code).toBe(
			0,
		);
		const fetched = await git(first, token, 'fetch', url, 'main');
		expect(fetched.code).toBe(0);
		expect((await repositoryRows(person.personal)).length).toBe(1);
	}, 120_000);

	test('concurrent first pushes to one name make one repository', async () => {
		const { person, token } = await signedIn('racer');
		const url = remote(person.personal, 'raced');
		const before = await stored();
		const copies = await Promise.all(
			['a', 'b', 'c', 'd'].map((label) =>
				workingCopy(`race-${label}`, { [`${label}.md`]: `${label}\n` }),
			),
		);
		const pushes = await Promise.all(
			copies.map((dir) => git(dir, token, 'push', url, 'HEAD:main')),
		);
		// Unrelated histories: exactly one lands, and every other is refused.
		expect(pushes.filter((run) => run.code === 0)).toHaveLength(1);
		const rows = await repositoryRows(person.personal);
		expect(rows.map((row) => row.name)).toEqual(['raced']);
		// Each losing push removed the storage it made: only the winner's remains.
		expect((await stored()).filter((id) => !before.includes(id))).toEqual([
			rows[0]?.id as string,
		]);
		const check = join(scratch, `raced-${crypto.randomUUID().slice(0, 8)}`);
		expect((await git(scratch, token, 'clone', url, check)).code).toBe(0);
		const winner = pushes.findIndex((run) => run.code === 0);
		const label = ['a', 'b', 'c', 'd'][winner] as string;
		expect(await Bun.file(join(check, `${label}.md`)).text()).toBe(
			`${label}\n`,
		);
	}, 120_000);

	test('a row that could not be inserted leaves the storage its push made', async () => {
		const { person, token } = await signedIn('unlucky');
		// The insert fails after the storage exists, as one that committed and
		// lost its reply would look to the route.
		await sql.query(`
			create function refuse_repository() returns trigger language plpgsql
			as $$ begin raise exception 'refused for the test'; end $$
		`);
		await sql.query(`
			create trigger refuse_repository before insert on repository
			for each row when (new.name = 'refused')
			execute function refuse_repository()
		`);
		try {
			const before = await stored();
			const dir = await workingCopy('refused', { 'a.md': 'a\n' });
			const pushed = await git(
				dir,
				token,
				'push',
				remote(person.personal, 'refused'),
				'HEAD:main',
			);
			expect(pushed.code).not.toBe(0);
			expect(await repositoryRows(person.personal)).toEqual([]);
			expect(
				(await stored()).filter((id) => !before.includes(id)),
			).toHaveLength(1);
		} finally {
			await sql.query('drop trigger refuse_repository on repository');
			await sql.query('drop function refuse_repository()');
		}
	}, 60_000);

	test('unrelated history to an existing name is refused, even forced', async () => {
		const { person, token } = await signedIn('unrelated');
		const url = remote(person.personal, 'shared-name');
		const first = await workingCopy('one', { 'a.md': 'one\n' });
		expect((await git(first, token, 'push', url, 'HEAD:main')).code).toBe(0);
		const other = await workingCopy('other', { 'z.md': 'other\n' });
		const plain = await git(other, token, 'push', url, 'HEAD:main');
		expect(plain.code).not.toBe(0);
		const forced = await git(other, token, 'push', '--force', url, 'HEAD:main');
		expect(forced.code).not.toBe(0);
		// The repository still holds the first history.
		const check = join(scratch, `check-${crypto.randomUUID().slice(0, 8)}`);
		expect((await git(scratch, token, 'clone', url, check)).code).toBe(0);
		expect(await Bun.file(join(check, 'a.md')).text()).toBe('one\n');
		expect(await Bun.file(join(check, 'z.md')).exists()).toBe(false);
	}, 120_000);

	test('a non-member gets 403 and creates nothing', async () => {
		const owner = await signedIn('member-owner');
		const stranger = await signedIn('stranger');
		const url = remote(owner.person.personal, 'private');
		const dir = await workingCopy('private', { 'a.md': 'secret\n' });
		expect((await git(dir, owner.token, 'push', url, 'HEAD:main')).code).toBe(
			0,
		);

		const read = await fetch(`${url}/info/refs?service=git-upload-pack`, {
			headers: { authorization: `Bearer ${stranger.token}` },
		});
		expect(read.status).toBe(403);
		const write = await fetch(`${url}/info/refs?service=git-receive-pack`, {
			headers: { authorization: `Bearer ${stranger.token}` },
		});
		expect(write.status).toBe(403);
		const tried = await git(dir, stranger.token, 'push', url, 'HEAD:main');
		expect(tried.code).not.toBe(0);
		// Nor can a stranger create in another's namespace.
		const created = await fetch(
			`${remote(owner.person.personal, 'planted')}/info/refs?service=git-receive-pack`,
			{ headers: { authorization: `Bearer ${stranger.token}` } },
		);
		expect(created.status).toBe(403);
		expect(
			(await repositoryRows(owner.person.personal)).map((row) => row.name),
		).toEqual(['private']);
	}, 120_000);

	test('a missing or unusable token gets 401 naming resource_metadata, and a read-only token cannot push', async () => {
		const owner = await signedIn('challenged');
		const advertise = `${remote(owner.person.personal, 'x')}/info/refs?service=git-upload-pack`;
		const none = await fetch(advertise);
		expect(none.status).toBe(401);
		expect(none.headers.get('www-authenticate')).toContain(
			`resource_metadata="${origin}/.well-known/oauth-protected-resource/git"`,
		);
		// Terminal Git needs a Basic challenge to ask its credential helper.
		expect(none.headers.getSetCookie()).toEqual([]);
		expect(none.headers.get('www-authenticate')).toContain('Basic');
		const garbage = await fetch(advertise, {
			headers: { authorization: 'Bearer not-a-token' },
		});
		expect(garbage.status).toBe(401);
		// The API audience's token is another resource's.
		const api = await signedIn('api-only', 'openid profile', audiences.api);
		const wrong = await fetch(advertise, {
			headers: { authorization: `Bearer ${api.token}` },
		});
		expect(wrong.status).toBe(401);

		const readOnly = await signedIn('read-only', 'openid folders:read');
		const dir = await workingCopy('ro', { 'a.md': 'x\n' });
		const pushed = await git(
			dir,
			readOnly.token,
			'push',
			remote(readOnly.person.personal, 'ro'),
			'HEAD:main',
		);
		expect(pushed.code).not.toBe(0);
		const refused = await fetch(
			`${remote(readOnly.person.personal, 'ro')}/info/refs?service=git-receive-pack`,
			{ headers: { authorization: `Bearer ${readOnly.token}` } },
		);
		expect(refused.status).toBe(403);
		expect((await refused.json()) as { error: string }).toMatchObject({
			error: 'insufficient_scope',
		});
		expect(await repositoryRows(readOnly.person.personal)).toEqual([]);
	}, 120_000);

	test('the Basic password is the token, for terminal Git', async () => {
		const { person, token } = await signedIn('basic');
		const response = await fetch(
			`${remote(person.personal, 'basic')}/info/refs?service=git-receive-pack`,
			{ headers: { authorization: `Basic ${btoa(`epicenter:${token}`)}` } },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(
			'application/x-git-receive-pack-advertisement',
		);
	}, 60_000);

	test('a rename or a move leaves an alias that still resolves', async () => {
		const { person, token } = await signedIn('mover');
		const url = remote(person.personal, 'before');
		const dir = await workingCopy('mover', { 'a.md': 'one\n' });
		expect((await git(dir, token, 'push', url, 'HEAD:main')).code).toBe(0);
		const [row] = await repositoryRows(person.personal);
		const id = row?.id as string;

		const renamed = await renameRepository(db, {
			accountId: person.id,
			namespaceId: person.personal,
			name: 'before',
			newName: 'after',
		});
		expect(renamed.error).toBeNull();
		expect(
			(await repositoryRows(person.personal)).map(({ id, name }) => [id, name]),
		).toEqual([[id, 'after']]);
		// The old remote and the new one are the same repository.
		const viaAlias = join(scratch, `alias-${crypto.randomUUID().slice(0, 8)}`);
		expect((await git(scratch, token, 'clone', url, viaAlias)).code).toBe(0);
		expect(await Bun.file(join(viaAlias, 'a.md')).text()).toBe('one\n');
		await commit(viaAlias, { 'b.md': 'two\n' }, 'second');
		expect(
			(await git(viaAlias, token, 'push', 'origin', 'HEAD:main')).code,
		).toBe(0);
		const viaName = join(scratch, `name-${crypto.randomUUID().slice(0, 8)}`);
		expect(
			(
				await git(
					scratch,
					token,
					'clone',
					remote(person.personal, 'after'),
					viaName,
				)
			).code,
		).toBe(0);
		expect(await Bun.file(join(viaName, 'b.md')).text()).toBe('two\n');

		// A move to a group the person owns keeps both old URLs.
		const group = await client.group(person, 'Family', 'owner');
		const moved = await moveRepository(db, {
			accountId: person.id,
			namespaceId: person.personal,
			name: 'after',
			toNamespaceId: group,
		});
		expect(moved.error).toBeNull();
		expect((await repositoryRows(group)).map((r) => r.id)).toEqual([id]);
		for (const old of [url, remote(person.personal, 'after')]) {
			const again = join(scratch, `moved-${crypto.randomUUID().slice(0, 8)}`);
			expect((await git(scratch, token, 'clone', old, again)).code).toBe(0);
			expect(await Bun.file(join(again, 'b.md')).text()).toBe('two\n');
		}
		// An alias keeps resolving to its repository: a push to the old name is
		// an ordinary push there, so unrelated history is refused, not created.
		const fresh = await workingCopy('fresh', { 'f.md': 'fresh\n' });
		expect((await git(fresh, token, 'push', url, 'HEAD:main')).code).not.toBe(
			0,
		);
		expect(await repositoryRows(person.personal)).toEqual([]);
	}, 180_000);

	test('rename and move need the manage role, and a name taken is refused', async () => {
		const owner = await signedIn('manager');
		const member = await signedIn('plain-member');
		const group = await client.group(owner.person, 'Studio', 'owner');
		await sql.query(
			'insert into namespace_member (namespace_id, account_id, role) values ($1, $2, $3)',
			[group, member.person.id, 'member'],
		);
		const url = remote(group, 'shared');
		const dir = await workingCopy('shared', { 'a.md': 'x\n' });
		// A member may push, which creates.
		expect((await git(dir, member.token, 'push', url, 'HEAD:main')).code).toBe(
			0,
		);
		const denied = await renameRepository(db, {
			accountId: member.person.id,
			namespaceId: group,
			name: 'shared',
			newName: 'mine',
		});
		expect(denied.error?.name).toBe('Forbidden');
		const bad = await renameRepository(db, {
			accountId: owner.person.id,
			namespaceId: group,
			name: 'shared',
			newName: 'Not Valid',
		});
		expect(bad.error?.name).toBe('InvalidName');
		const other = await workingCopy('other-name', { 'o.md': 'o\n' });
		expect(
			(
				await git(
					other,
					owner.token,
					'push',
					remote(group, 'taken'),
					'HEAD:main',
				)
			).code,
		).toBe(0);
		const clash = await renameRepository(db, {
			accountId: owner.person.id,
			namespaceId: group,
			name: 'shared',
			newName: 'taken',
		});
		expect(clash.error?.name).toBe('NameTaken');
		const missing = await renameRepository(db, {
			accountId: owner.person.id,
			namespaceId: group,
			name: 'nothing',
			newName: 'x',
		});
		expect(missing.error?.name).toBe('NotFound');
	}, 120_000);

	test("GET /api/repos lists a caller's repositories by namespace", async () => {
		const { person, token } = await signedIn('lister');
		const group = await client.group(person, 'Band', 'owner');
		for (const [namespace, name] of [
			[person.personal, 'zeta'],
			[person.personal, 'alpha'],
			[group, 'songs'],
		] as const) {
			const dir = await workingCopy(name, { 'a.md': name });
			expect(
				(await git(dir, token, 'push', remote(namespace, name), 'HEAD:main'))
					.code,
			).toBe(0);
		}
		const unauthenticated = await fetch(`${origin}/api/repos`);
		expect(unauthenticated.status).toBe(401);
		// The listing takes the Git audience's token; an API token, even with
		// `folders:read`, is another resource's.
		const api = await signedIn(
			'lister-api',
			'openid folders:read',
			audiences.api,
		);
		const wrongAudience = await fetch(`${origin}/api/repos`, {
			headers: { authorization: `Bearer ${api.token}` },
		});
		expect(wrongAudience.status).toBe(401);
		const response = await fetch(`${origin}/api/repos`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(200);
		const listing = (await response.json()) as RepositoryListing;
		expect(listing.namespaces.map((n) => [n.id, n.personal])).toEqual([
			[person.personal, true],
			[group, false],
		]);
		expect(listing.namespaces[0]?.repositories.map((r) => r.name)).toEqual([
			'alpha',
			'zeta',
		]);
		expect(listing.namespaces[0]?.repositories[0]?.url).toBe(
			remote(person.personal, 'alpha'),
		);
		// An account with no repository lists none.
		const other = await signedIn('lister-two');
		const mine = (await (
			await fetch(`${origin}/api/repos`, {
				headers: { authorization: `Bearer ${other.token}` },
			})
		).json()) as RepositoryListing;
		expect(mine.namespaces.flatMap((n) => n.repositories)).toEqual([]);
	}, 120_000);
});
