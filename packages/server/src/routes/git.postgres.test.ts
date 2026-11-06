/**
 * Folders end to end on Bun (ADR-0811): the real routes behind the real
 * authorization server on a disposable Postgres cluster, a real `Bun.serve`
 * listener, the disk store, and the system `git` as a plain Git client.
 * Requires initdb, pg_ctl, and git on PATH; never connects to a configured
 * database.
 *
 * Key behaviors:
 * - A folder exists from its first sync, which joins before it creates, and
 *   plain Git reaches its history at `<git>/folders/<id>.git`
 * - A share is invisible and grants nothing until its person accepts it
 * - Any member may own; a folder survives while any member remains
 * - An app reaches only the folders attached to it; Epicenter attaches one
 * - A listing reads each folder's title from its `epicenter.json`
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	FolderListing,
	FolderRole,
	ListedFolder,
} from '@epicenter/definition/site';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { type Client, Pool } from 'pg';
import { registerFirstPartyClients } from '../auth/oauth-registrations.js';
import { createCloudContextMiddleware } from '../create-cloud-context-middleware.js';
import { createDb, type Db } from '../db/create-db.js';
import { createDiskGitHost } from '../git-disk-store.js';
import { createServerApp } from '../server-app.js';
import { startDisposablePostgres } from '../test-helpers/disposable-postgres.js';
import { OAuthTestClient, type Person } from '../test-helpers/oauth-client.js';
import type { CloudEnv } from '../types.js';
import { mountAuthRoutes } from './auth.js';
import { mountGitHost } from './git.js';

const secret = 'git-postgres-secret-0123456789abcdefghij';
/** The Epicenter app: a platform client, reaching every folder its person holds. */
const epicenter = {
	clientId: 'so.epicenter',
	redirectUri: 'https://epicenter.example.test/auth/callback',
};
/** Two apps, each reaching the folders attached to it. */
const todos = {
	clientId: 'so.epicenter.todos',
	redirectUri: 'https://todos.example.test/auth/callback',
};
const vocab = {
	clientId: 'so.epicenter.vocab',
	redirectUri: 'https://vocab.example.test/auth/callback',
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
		clients: [epicenter, todos, vocab].map(({ clientId, redirectUri }) => ({
			clientId,
			name: clientId,
			redirectUris: [redirectUri],
			grantTypes: ['authorization_code'],
			scopes: [
				'openid',
				'profile',
				'folders:read',
				'folders:write',
				...(clientId === epicenter.clientId ? (['folders:all'] as const) : []),
			],
			resources: [audiences.api, audiences.git],
			skipConsent: true,
			applicationType: 'web',
		})),
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

type App = { clientId: string; redirectUri: string };

/** A token for `person` from `app` on the Git audience. */
async function tokenFor(
	person: Person,
	app: App = epicenter,
	scope = app === epicenter
		? 'openid folders:read folders:write folders:all'
		: 'openid folders:read folders:write',
	resource = audiences.git,
) {
	const tokens = await client.codeGrant({
		...app,
		cookie: person.cookie,
		resource: [resource],
		scope,
	});
	return tokens.access_token;
}

/** A person, and their Epicenter app's token. */
async function signedIn(label: string) {
	const person = await client.person(label);
	return { person, token: await tokenFor(person) };
}

/** A JSON request with `token`, to the Git audience (`git`) or the API (`api`). */
async function call(
	token: string,
	where: 'git' | 'api',
	path: string,
	init: { method?: string; body?: unknown } = {},
) {
	return fetch(`${where === 'git' ? audiences.git : `${origin}/api`}/${path}`, {
		method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

/** A first sync: join `folder` when named and held, or make a folder. */
async function join_(token: string, folder?: string) {
	const response = await call(token, 'git', 'folders', {
		body: folder === undefined ? {} : { folder },
	});
	return {
		status: response.status,
		body: (await response.json()) as {
			folder?: string;
			made?: boolean;
			error?: string;
			folders?: string[];
		},
	};
}

/** A new folder held by `token`'s person. */
async function made(token: string) {
	const joined = await join_(token);
	expect(joined.status).toBe(201);
	return joined.body.folder as string;
}

/** Land `files` (path to text) in `folder` in one commit. */
async function write(
	token: string,
	folder: string,
	files: Record<string, string>,
) {
	const asked = await call(token, 'git', `folders/${folder}/changes`);
	if (asked.status !== 200) return asked;
	const changes = (await asked.json()) as { commit: string | null };
	const tree =
		changes.commit === null
			? { entries: [] as { path: string; blob: string }[] }
			: ((await (
					await call(token, 'git', `folders/${folder}/tree`, {
						body: { commit: changes.commit, paths: Object.keys(files) },
					})
				).json()) as { entries: { path: string; blob: string }[] });
	const held = new Map(tree.entries.map(({ path, blob }) => [path, blob]));
	return call(token, 'git', `folders/${folder}/commits`, {
		body: {
			files: Object.entries(files).map(([path, text]) => ({
				path,
				expect: held.get(path) ?? null,
				text,
			})),
		},
	});
}

const listing = async (token: string) =>
	(await (await call(token, 'api', 'folders')).json()) as FolderListing;

const share = (
	token: string,
	folder: string,
	email: string,
	role: FolderRole = 'writer',
) =>
	call(token, 'api', `folders/${folder}/members/${encodeURIComponent(email)}`, {
		method: 'PUT',
		body: { role },
	});

const unshare = (token: string, folder: string, email: string) =>
	call(token, 'api', `folders/${folder}/members/${encodeURIComponent(email)}`, {
		method: 'DELETE',
	});

const accept = (token: string, folder: string) =>
	call(token, 'api', `folders/${folder}/accept`, { method: 'POST' });

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

const remote = (folder: string) => `${audiences.git}/folders/${folder}.git`;

/** The repository ids the disk store holds. */
const stored = async () =>
	(await readdir(storeRoot).catch(() => []))
		.filter((entry) => entry.endsWith('.git'))
		.map((entry) => entry.slice(0, -'.git'.length))
		.sort();

describe("a folder's Git remote", () => {
	test('a folder made at its first sync is cloned, fetched, and pushed by its id', async () => {
		const { token } = await signedIn('owner');
		const folder = await made(token);
		// Storage is named by the folder's id.
		expect(await stored()).toContain(folder);
		const url = remote(folder);
		const first = await workingCopy('notes', { 'a.md': 'one\n' });
		const empty = await git(first, token, 'ls-remote', url);
		expect(empty.code).toBe(0);
		expect(empty.stdout).toBe('');

		const pushed = await git(first, token, 'push', url, 'HEAD:main');
		expect(pushed.stderr).not.toContain('rejected');
		expect(pushed.code).toBe(0);
		const second = join(scratch, `clone-${crypto.randomUUID().slice(0, 8)}`);
		expect((await git(scratch, token, 'clone', url, second)).code).toBe(0);
		expect(await Bun.file(join(second, 'a.md')).text()).toBe('one\n');

		await commit(first, { 'b.md': 'two\n' }, 'second');
		expect((await git(first, token, 'push', url, 'HEAD:main')).code).toBe(0);
		expect(
			(await git(second, token, 'pull', '--ff-only', 'origin', 'main')).code,
		).toBe(0);
		expect(await Bun.file(join(second, 'b.md')).text()).toBe('two\n');
		// What plain Git pushed, sync reads.
		expect(
			(
				(await (
					await call(token, 'git', `folders/${folder}/changes`)
				).json()) as { commit: string }
			).commit,
		).toBe((await git(first, null, 'rev-parse', 'HEAD')).stdout.trim());
	}, 120_000);

	test("unrelated history is refused for a writer, even forced; an owner's forced push lands and keeps the old main", async () => {
		const owner = await signedIn('rewrite-owner');
		const writer = await signedIn('rewrite-writer');
		const folder = await made(owner.token);
		expect((await share(owner.token, folder, writer.person.email)).status).toBe(
			200,
		);
		expect((await accept(writer.token, folder)).status).toBe(200);
		const url = remote(folder);
		const first = await workingCopy('one', { 'a.md': 'one\n' });
		expect(
			(await git(first, writer.token, 'push', url, 'HEAD:main')).code,
		).toBe(0);
		const old = (await git(first, null, 'rev-parse', 'HEAD')).stdout.trim();
		const other = await workingCopy('other', { 'z.md': 'other\n' });
		const forced = await git(
			other,
			writer.token,
			'push',
			'--force',
			url,
			'HEAD:main',
		);
		expect(forced.code).not.toBe(0);
		expect(forced.stderr).toContain(
			'only the repository owner may rewrite main',
		);
		const owned = await git(
			other,
			owner.token,
			'push',
			'--force',
			url,
			'HEAD:main',
		);
		expect(owned.code).toBe(0);
		const refs = (await git(other, owner.token, 'ls-remote', url)).stdout;
		expect(refs).toMatch(
			new RegExp(`^${old}\\trefs/epicenter/replaced/\\d{8}-\\d{9}Z$`, 'm'),
		);
	}, 120_000);

	test('one who does not hold a folder gets 403, the same as for a folder that does not exist, and nothing is made', async () => {
		const owner = await signedIn('holder');
		const stranger = await signedIn('stranger');
		const folder = await made(owner.token);
		const before = await stored();
		for (const id of [folder, 'zzzzzzzzzzzzzzzz']) {
			for (const service of ['git-upload-pack', 'git-receive-pack']) {
				const response = await fetch(
					`${remote(id)}/info/refs?service=${service}`,
					{ headers: { authorization: `Bearer ${stranger.token}` } },
				);
				expect(response.status).toBe(403);
			}
			expect(
				(await call(stranger.token, 'git', `folders/${id}/changes`)).status,
			).toBe(403);
		}
		const dir = await workingCopy('planted', { 'a.md': 'x\n' });
		expect(
			(
				await git(
					dir,
					stranger.token,
					'push',
					remote('zzzzzzzzzzzzzzzz'),
					'HEAD:main',
				)
			).code,
		).not.toBe(0);
		expect(await stored()).toEqual(before);
	}, 120_000);

	test('a missing or unusable token gets 401 naming resource_metadata, and a read-only token cannot push', async () => {
		const { token } = await signedIn('challenged');
		const folder = await made(token);
		const advertise = `${remote(folder)}/info/refs?service=git-upload-pack`;
		const none = await fetch(advertise);
		expect(none.status).toBe(401);
		expect(none.headers.get('www-authenticate')).toContain(
			`resource_metadata="${origin}/.well-known/oauth-protected-resource/git"`,
		);
		// Terminal Git needs a Basic challenge to ask its credential helper.
		expect(none.headers.get('www-authenticate')).toContain('Basic');
		const garbage = await fetch(advertise, {
			headers: { authorization: 'Bearer not-a-token' },
		});
		expect(garbage.status).toBe(401);
		const person = await client.person('api-only');
		const api = await tokenFor(
			person,
			epicenter,
			'openid profile',
			audiences.api,
		);
		expect(
			(await fetch(advertise, { headers: { authorization: `Bearer ${api}` } }))
				.status,
		).toBe(401);
		const readOnly = await tokenFor(
			(await client.person('read-only')) as Person,
			epicenter,
			'openid folders:read folders:all',
		);
		const refused = await fetch(
			`${remote(folder)}/info/refs?service=git-receive-pack`,
			{ headers: { authorization: `Bearer ${readOnly}` } },
		);
		expect(refused.status).toBe(403);
		expect((await refused.json()) as { error: string }).toMatchObject({
			error: 'insufficient_scope',
		});
	}, 120_000);

	test('the Basic password is the token, for terminal Git', async () => {
		const { token } = await signedIn('basic');
		const folder = await made(token);
		const response = await fetch(
			`${remote(folder)}/info/refs?service=git-receive-pack`,
			{ headers: { authorization: `Basic ${btoa(`epicenter:${token}`)}` } },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(
			'application/x-git-receive-pack-advertisement',
		);
	}, 60_000);
});

describe('sharing a folder with a person', () => {
	test('share, then accept: the folder appears and is reached only once accepted', async () => {
		const alice = await signedIn('share-alice');
		const bob = await signedIn('share-bob');
		const folder = await made(alice.token);
		expect(
			(
				await write(alice.token, folder, {
					'epicenter.json': JSON.stringify({ title: 'Reading list' }),
					'books/dune.md': '---\ntitle: "Dune"\n---\n',
				})
			).status,
		).toBe(200);

		const shared = await share(alice.token, folder, bob.person.email);
		expect((await shared.json()) as unknown).toEqual({
			person: bob.person.email,
			role: 'writer',
			pending: true,
		});
		// The owner sees the invitation; Bob sees a share waiting, and no folder.
		const owned = (await listing(alice.token)).folders.find(
			({ id }) => id === folder,
		);
		expect(owned?.invited).toEqual([
			{ email: bob.person.email, name: 'share-bob', role: 'writer' },
		]);
		expect(await listing(bob.token)).toEqual({
			folders: [],
			pending: [
				{
					folder,
					title: 'Reading list',
					role: 'writer',
					from: { email: alice.person.email, name: 'share-alice' },
				},
			],
		});
		expect(
			(await call(bob.token, 'git', `folders/${folder}/changes`)).status,
		).toBe(403);

		const accepted = await accept(bob.token, folder);
		expect(accepted.status).toBe(200);
		const listed = (await accepted.json()) as ListedFolder;
		expect(listed).toMatchObject({
			id: folder,
			title: 'Reading list',
			role: 'writer',
			members: [
				{ email: alice.person.email, role: 'owner', you: false },
				{ email: bob.person.email, role: 'writer', you: true },
			],
			invited: [],
		});
		expect((await listing(bob.token)).pending).toEqual([]);
		expect(
			(await listing(bob.token)).folders.map(({ id, title }) => [id, title]),
		).toEqual([[folder, 'Reading list']]);
		// A writer writes; a share cannot be accepted twice.
		expect(
			(await write(bob.token, folder, { 'books/dune.md': 'Read it.\n' }))
				.status,
		).toBe(200);
		expect((await accept(bob.token, folder)).status).toBe(404);
	}, 60_000);

	test('a share that is not accepted stays invisible and grants nothing; declining removes it', async () => {
		const alice = await signedIn('waiting-alice');
		const carol = await signedIn('waiting-carol');
		const folder = await made(alice.token);
		await share(alice.token, folder, carol.person.email, 'owner');
		// Not a member yet: no folder, no reads, no writes, no sharing on.
		expect((await listing(carol.token)).folders).toEqual([]);
		expect((await call(carol.token, 'api', `folders/${folder}`)).status).toBe(
			403,
		);
		expect(
			(await write(carol.token, folder, { 'a.md': 'mine\n' })).status,
		).toBe(403);
		expect((await share(carol.token, folder, alice.person.email)).status).toBe(
			403,
		);
		const heads = (await (
			await call(carol.token, 'git', 'folders')
		).json()) as {
			heads: Record<string, string | null>;
		};
		expect(heads.heads).toEqual({});
		// Declining is leaving before accepting: the share is gone.
		expect(
			(await unshare(carol.token, folder, carol.person.email)).status,
		).toBe(200);
		expect((await listing(carol.token)).pending).toEqual([]);
		expect((await accept(carol.token, folder)).status).toBe(404);
		// Sharing names a person who signs in; no one else.
		expect(
			(await share(alice.token, folder, 'nobody@example.test')).status,
		).toBe(404);
	}, 60_000);

	test('a reader reads and cannot write; only owners share; an owner unshares, and the next request is refused', async () => {
		const alice = await signedIn('roles-alice');
		const reader = await signedIn('roles-reader');
		const writer = await signedIn('roles-writer');
		const folder = await made(alice.token);
		await write(alice.token, folder, { 'a.md': 'a\n' });
		await share(alice.token, folder, reader.person.email, 'reader');
		await share(alice.token, folder, writer.person.email, 'writer');
		await accept(reader.token, folder);
		await accept(writer.token, folder);
		expect(
			(await call(reader.token, 'git', `folders/${folder}/changes`)).status,
		).toBe(200);
		expect((await write(reader.token, folder, { 'a.md': 'b\n' })).status).toBe(
			403,
		);
		expect(
			(await share(writer.token, folder, reader.person.email, 'owner')).status,
		).toBe(403);
		expect(
			(await unshare(writer.token, folder, reader.person.email)).status,
		).toBe(403);
		expect(
			(await unshare(alice.token, folder, reader.person.email)).status,
		).toBe(200);
		expect(
			(await call(reader.token, 'git', `folders/${folder}/changes`)).status,
		).toBe(403);
		// The last owner may not step down while others hold the folder.
		expect(
			(await share(alice.token, folder, alice.person.email, 'writer')).status,
		).toBe(409);
	}, 60_000);

	test('a folder survives its first owner leaving, and goes with its last member', async () => {
		const alice = await signedIn('survive-alice');
		const bob = await signedIn('survive-bob');
		const folder = await made(alice.token);
		await write(alice.token, folder, { 'a.md': 'kept\n' });
		await share(alice.token, folder, bob.person.email, 'writer');
		await accept(bob.token, folder);

		// Alice's account is deleted: Bob holds the folder, now as its owner.
		await sql.query('delete from "user" where id = $1', [alice.person.id]);
		const [kept] = (await listing(bob.token)).folders;
		expect(kept).toMatchObject({
			id: folder,
			role: 'owner',
			members: [{ email: bob.person.email, role: 'owner', you: true }],
		});
		expect(
			(await write(bob.token, folder, { 'a.md': 'still here\n' })).status,
		).toBe(200);

		// Bob leaves, the last member: the folder and its storage go.
		const left = await unshare(bob.token, folder, bob.person.email);
		expect(await left.json()).toMatchObject({ folderGone: true });
		expect((await listing(bob.token)).folders).toEqual([]);
		expect(
			(await sql.query('select 1 from folder where id = $1', [folder]))
				.rowCount,
		).toBe(0);
		expect(await stored()).not.toContain(folder);
	}, 60_000);
});

describe('a first sync joins before it creates', () => {
	test('naming a folder the person holds joins it; one they do not hold makes a new folder', async () => {
		const alice = await signedIn('join-alice');
		const bob = await signedIn('join-bob');
		const folder = await made(alice.token);
		// Another of Alice's computers names the id its manifest holds.
		expect(await join_(alice.token, folder)).toEqual({
			status: 200,
			body: { folder, made: false },
		});
		// Bob holds no such folder, so his first sync makes his own.
		const his = await join_(bob.token, folder);
		expect(his.status).toBe(201);
		expect(his.body.folder).not.toBe(folder);
		// Once he accepts a share of it, the same request joins it.
		await share(alice.token, folder, bob.person.email);
		expect((await join_(bob.token, folder)).body.made).toBe(true);
		await accept(bob.token, folder);
		expect(await join_(bob.token, folder)).toEqual({
			status: 200,
			body: { folder, made: false },
		});
	}, 60_000);
});

describe('an app reaches the folders attached to it', () => {
	test("an app's first sync makes its folder and joins it after; another app reaches nothing until the person attaches it", async () => {
		const person = await client.person('attach');
		const platform = await tokenFor(person);
		const todosToken = await tokenFor(person, todos);
		const vocabToken = await tokenFor(person, vocab);

		const first = await join_(todosToken);
		expect(first.status).toBe(201);
		const folder = first.body.folder as string;
		expect(await join_(todosToken)).toEqual({
			status: 200,
			body: { folder, made: false },
		});
		// The platform sees every folder; each app only its own.
		const own = await made(platform);
		expect(
			(await listing(platform)).folders.map(({ id, apps }) => [id, apps]),
		).toEqual([
			[folder, [todos.clientId]],
			[own, []],
		]);
		expect((await listing(todosToken)).folders.map(({ id }) => id)).toEqual([
			folder,
		]);
		expect((await listing(vocabToken)).folders).toEqual([]);
		expect(
			(await call(vocabToken, 'git', `folders/${folder}/changes`)).status,
		).toBe(403);
		// An app cannot attach a folder to itself; the person does, through Epicenter.
		const path = `folders/${folder}/apps/${vocab.clientId}`;
		expect(
			(await call(vocabToken, 'api', path, { method: 'PUT' })).status,
		).toBe(403);
		expect((await call(platform, 'api', path, { method: 'PUT' })).status).toBe(
			200,
		);
		expect(
			(await call(vocabToken, 'git', `folders/${folder}/changes`)).status,
		).toBe(200);
		// With two of its folders, an app's first sync asks which.
		expect(
			(
				await call(platform, 'api', `folders/${own}/apps/${vocab.clientId}`, {
					method: 'PUT',
				})
			).status,
		).toBe(200);
		const choose = await join_(vocabToken);
		expect(choose.status).toBe(409);
		expect(choose.body).toMatchObject({ error: 'choose' });
		expect(choose.body.folders?.sort()).toEqual([folder, own].sort());
		// Detached, it is out of reach again.
		expect(
			(await call(platform, 'api', path, { method: 'DELETE' })).status,
		).toBe(200);
		expect(
			(await call(vocabToken, 'git', `folders/${folder}/changes`)).status,
		).toBe(403);
		// Nor can that app take its person out of the folder it no longer reaches.
		expect((await unshare(vocabToken, folder, person.email)).status).toBe(403);
	}, 60_000);

	test('a share of a folder attached to an app shows in that app once accepted', async () => {
		const alice = await client.person('app-share-alice');
		const bob = await client.person('app-share-bob');
		const aliceTodos = await tokenFor(alice, todos);
		const bobTodos = await tokenFor(bob, todos);
		const folder = (await join_(aliceTodos)).body.folder as string;
		await share(await tokenFor(alice), folder, bob.email);
		expect((await listing(bobTodos)).pending.map((s) => s.folder)).toEqual([
			folder,
		]);
		expect((await accept(bobTodos, folder)).status).toBe(200);
		expect((await join_(bobTodos)).body).toEqual({ folder, made: false });
	}, 60_000);
});

test('one request answers where main is in every folder the token reaches', async () => {
	const { token } = await signedIn('heads');
	const a = await made(token);
	const b = await made(token);
	const landed = (await (await write(token, a, { 'a.md': 'a\n' })).json()) as {
		commit: string;
	};
	const answer = (await (await call(token, 'git', 'folders')).json()) as {
		heads: Record<string, string | null>;
	};
	expect(answer.heads).toEqual({ [a]: landed.commit, [b]: null });
}, 60_000);
