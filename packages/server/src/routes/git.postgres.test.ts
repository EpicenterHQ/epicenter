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
 * - A share is an invitation to an email, invisible and granting nothing
 *   until the person who signs in with it, verified, accepts it
 * - Members are equal; a folder survives while any member remains
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

/** `POST <git>/folders`: make a folder (`{ create: true, app? }`), or join an app's (`{ join }`). */
async function join_(token: string, body: unknown = { create: true }) {
	const response = await call(token, 'git', 'folders', { body });
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
	role: FolderRole = 'member',
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

	test("a reader's forced push is refused; any member's lands and keeps the old main", async () => {
		const maker = await signedIn('rewrite-maker');
		const member = await signedIn('rewrite-member');
		const reader = await signedIn('rewrite-reader');
		const folder = await made(maker.token);
		await share(maker.token, folder, member.person.email);
		await share(maker.token, folder, reader.person.email, 'reader');
		expect((await accept(member.token, folder)).status).toBe(200);
		expect((await accept(reader.token, folder)).status).toBe(200);
		const url = remote(folder);
		const first = await workingCopy('one', { 'a.md': 'one\n' });
		expect(
			(await git(first, maker.token, 'push', url, 'HEAD:main')).code,
		).toBe(0);
		const old = (await git(first, null, 'rev-parse', 'HEAD')).stdout.trim();
		const other = await workingCopy('other', { 'z.md': 'other\n' });
		expect(
			(await git(other, reader.token, 'push', '--force', url, 'HEAD:main'))
				.code,
		).not.toBe(0);
		// No member owns the folder: the one who did not make it rewrites it too.
		const forced = await git(
			other,
			member.token,
			'push',
			'--force',
			url,
			'HEAD:main',
		);
		expect(forced.code).toBe(0);
		const refs = (await git(other, member.token, 'ls-remote', url)).stdout;
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

describe('sharing a folder is an invitation to an email', () => {
	test('invite, then accept: the folder appears and is reached only once accepted', async () => {
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
			role: 'member',
			pending: true,
		});
		// A member sees the invitation by its email alone; Bob sees it waiting, and no folder.
		const owned = (await listing(alice.token)).folders.find(
			({ id }) => id === folder,
		);
		expect(owned?.invited).toEqual([
			{ email: bob.person.email, role: 'member' },
		]);
		expect(await listing(bob.token)).toEqual({
			folders: [],
			pending: [
				{
					folder,
					title: 'Reading list',
					role: 'member',
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
			role: 'member',
			members: [
				{ email: alice.person.email, role: 'member', you: false },
				{ email: bob.person.email, role: 'member', you: true },
			],
			invited: [],
		});
		expect((await listing(bob.token)).pending).toEqual([]);
		expect(
			(await listing(bob.token)).folders.map(({ id, title }) => [id, title]),
		).toEqual([[folder, 'Reading list']]);
		// A member writes; an invitation cannot be accepted twice.
		expect(
			(await write(bob.token, folder, { 'books/dune.md': 'Read it.\n' }))
				.status,
		).toBe(200);
		expect((await accept(bob.token, folder)).status).toBe(404);
	}, 60_000);

	test('an invitation that is not accepted stays invisible and grants nothing; declining removes it', async () => {
		const alice = await signedIn('waiting-alice');
		const carol = await signedIn('waiting-carol');
		const folder = await made(alice.token);
		await share(alice.token, folder, carol.person.email);
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
		// Declining is leaving before accepting: the invitation is gone.
		expect(
			(await unshare(carol.token, folder, carol.person.email)).status,
		).toBe(200);
		expect((await listing(carol.token)).pending).toEqual([]);
		expect((await accept(carol.token, folder)).status).toBe(404);
	}, 60_000);

	test('sharing and unsharing answer the same whether or not anyone signs in with the email', async () => {
		const alice = await signedIn('same-alice');
		const known = (await client.person('same-known')).email;
		const unknown = `same-nobody-${crypto.randomUUID()}@example.test`;
		const folder = await made(alice.token);
		/** A response's status and body, the email it names replaced. */
		const answer = async (response: Response, email: string) => ({
			status: response.status,
			body: JSON.parse((await response.text()).replaceAll(email, '<email>')),
		});

		const toKnown = await answer(
			await share(alice.token, folder, known),
			known,
		);
		const toUnknown = await answer(
			await share(alice.token, folder, unknown),
			unknown,
		);
		expect(toKnown).toEqual({
			status: 200,
			body: { person: '<email>', role: 'member', pending: true },
		});
		expect(toUnknown).toEqual(toKnown);
		// The listing names each by its email alone, so neither says more.
		const [held] = (await listing(alice.token)).folders;
		expect(held?.invited).toEqual([
			{ email: known, role: 'member' },
			{ email: unknown, role: 'member' },
		]);

		// Cancelling each answers the same, and so does cancelling again.
		for (const expected of [
			{ status: 200, body: { person: '<email>', removed: true, folderGone: false } },
			{ status: 404 },
		]) {
			const cancelKnown = await answer(
				await unshare(alice.token, folder, known),
				known,
			);
			const cancelUnknown = await answer(
				await unshare(alice.token, folder, unknown),
				unknown,
			);
			expect(cancelKnown).toMatchObject(expected);
			expect(cancelUnknown).toEqual(cancelKnown);
		}
		expect((await listing(alice.token)).folders[0]?.invited).toEqual([]);
	}, 60_000);

	test('an invitation to an email with no account is accepted after sign-up with that email verified', async () => {
		const alice = await signedIn('later-alice');
		const folder = await made(alice.token);
		await write(alice.token, folder, {
			'epicenter.json': JSON.stringify({ title: 'Recipes' }),
		});
		const email = `later-${crypto.randomUUID()}@example.test`;
		// Shared before anyone signs in with it, in another case than they sign up with.
		expect(
			(await share(alice.token, folder, email.toUpperCase(), 'reader')).status,
		).toBe(200);

		// They sign up with that email, verified by their provider.
		const later = await client.person('later', { email });
		const token = await tokenFor(later);
		expect((await listing(token)).pending).toMatchObject([
			{ folder, title: 'Recipes', role: 'reader' },
		]);
		const accepted = await accept(token, folder);
		expect(accepted.status).toBe(200);
		expect((await accepted.json()) as ListedFolder).toMatchObject({
			id: folder,
			role: 'reader',
			members: [
				{ email: alice.person.email, role: 'member' },
				{ email, role: 'reader', you: true },
			],
			invited: [],
		});
		expect(
			(await call(token, 'git', `folders/${folder}/changes`)).status,
		).toBe(200);
		expect((await write(token, folder, { 'a.md': 'mine\n' })).status).toBe(
			403,
		);
	}, 60_000);

	test('an unverified email neither sees, accepts, nor declines its invitation until it is verified', async () => {
		const alice = await signedIn('unverified-alice');
		const folder = await made(alice.token);
		const email = `unverified-${crypto.randomUUID()}@example.test`;
		await share(alice.token, folder, email);
		const claimant = await client.person('unverified', {
			email,
			emailVerified: false,
		});
		const token = await tokenFor(claimant);
		expect((await listing(token)).pending).toEqual([]);
		expect((await accept(token, folder)).status).toBe(404);
		expect((await unshare(token, folder, email)).status).toBe(404);
		expect(
			(await call(token, 'git', `folders/${folder}/changes`)).status,
		).toBe(403);
		// Verified, the same account finds it waiting.
		await sql.query('update "user" set email_verified = true where id = $1', [
			claimant.id,
		]);
		expect((await listing(token)).pending.map((s) => s.folder)).toEqual([
			folder,
		]);
		expect((await accept(token, folder)).status).toBe(200);
	}, 60_000);

	test('a reader reads and manages nothing; every member shares, changes roles, and unshares anyone, the maker included', async () => {
		const alice = await signedIn('roles-alice');
		const reader = await signedIn('roles-reader');
		const member = await signedIn('roles-member');
		const folder = await made(alice.token);
		await write(alice.token, folder, { 'a.md': 'a\n' });
		await share(alice.token, folder, reader.person.email, 'reader');
		await share(alice.token, folder, member.person.email);
		await accept(reader.token, folder);
		await accept(member.token, folder);
		expect(
			(await call(reader.token, 'git', `folders/${folder}/changes`)).status,
		).toBe(200);
		expect((await write(reader.token, folder, { 'a.md': 'b\n' })).status).toBe(
			403,
		);
		expect(
			(await share(reader.token, folder, 'someone@example.test')).status,
		).toBe(403);
		expect(
			(await unshare(reader.token, folder, member.person.email)).status,
		).toBe(403);
		// A reader sees who holds the folder, not who is invited.
		await share(alice.token, folder, 'invited@example.test');
		expect(
			(
				(await (
					await call(reader.token, 'api', `folders/${folder}`)
				).json()) as ListedFolder
			).invited,
		).toEqual([]);
		// A member who did not make the folder changes roles and takes its maker out.
		const promoted = await share(member.token, folder, reader.person.email);
		expect((await promoted.json()) as unknown).toEqual({
			person: reader.person.email,
			role: 'member',
			pending: false,
		});
		expect((await write(reader.token, folder, { 'a.md': 'b\n' })).status).toBe(
			200,
		);
		expect(
			(await unshare(member.token, folder, alice.person.email)).status,
		).toBe(200);
		expect(
			(await call(alice.token, 'git', `folders/${folder}/changes`)).status,
		).toBe(403);
	}, 60_000);

	test('a folder survives its maker leaving, and goes with its last member', async () => {
		const alice = await signedIn('survive-alice');
		const bob = await signedIn('survive-bob');
		const folder = await made(alice.token);
		await write(alice.token, folder, { 'a.md': 'kept\n' });
		await share(alice.token, folder, bob.person.email);
		await accept(bob.token, folder);

		// Alice's account is deleted: Bob holds the folder as he did.
		await sql.query('delete from "user" where id = $1', [alice.person.id]);
		const [kept] = (await listing(bob.token)).folders;
		expect(kept).toMatchObject({
			id: folder,
			role: 'member',
			members: [{ email: bob.person.email, role: 'member', you: true }],
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

describe('a create never joins, and a join names its app', () => {
	test('a create makes a new folder every time, from any token; a join of an app the person holds none of is none', async () => {
		const person = await client.person('create-never-joins');
		const platform = await tokenFor(person);
		const todosToken = await tokenFor(person, todos);
		// An app's token makes its own folder, attached to it.
		const first = await join_(todosToken);
		expect(first.status).toBe(201);
		const folder = first.body.folder as string;
		// A second create from the same app's token makes another: it never
		// joins the folder attached to the app (the old `--new` from an app
		// token merged into it).
		const second = await join_(todosToken);
		expect(second.status).toBe(201);
		const another = second.body.folder as string;
		expect(another).not.toBe(folder);
		// From the platform, a create names the app to attach it to.
		const forVocab = await join_(platform, { create: true, app: vocab.clientId });
		expect(forVocab.status).toBe(201);
		expect(
			(await listing(platform)).folders
				.map(({ id, apps }) => [id, apps])
				.sort(),
		).toEqual(
			[
				[folder, [todos.clientId]],
				[another, [todos.clientId]],
				[forVocab.body.folder as string, [vocab.clientId]],
			].sort(),
		);
		// An app's token makes nothing for another app.
		expect(
			(await join_(todosToken, { create: true, app: vocab.clientId })).status,
		).toBe(403);
		// A join names its app: Todos holds two, so it asks which.
		const choose = await join_(todosToken, { join: todos.clientId });
		expect(choose.status).toBe(409);
		expect(choose.body.folders?.sort()).toEqual(
			[folder, another].sort(),
		);
		// An app joins only its own app's folder.
		expect((await join_(todosToken, { join: vocab.clientId })).status).toBe(
			403,
		);
		const stranger = await client.person('create-never-joins-other');
		expect(
			await join_(await tokenFor(stranger, todos), { join: todos.clientId }),
		).toMatchObject({ status: 404, body: { error: 'none' } });
		// Neither shape is no request at all.
		for (const body of [{}, { folder }, { create: false }, { join: 'x' }])
			expect((await join_(platform, body)).status).toBe(400);
	}, 60_000);
});

describe('an app reaches the folders attached to it', () => {
	test("an app's first open makes its folder and joins it after; another app reaches nothing until the person attaches it", async () => {
		const person = await client.person('attach');
		const platform = await tokenFor(person);
		const todosToken = await tokenFor(person, todos);
		const vocabToken = await tokenFor(person, vocab);

		const first = await join_(todosToken);
		expect(first.status).toBe(201);
		const folder = first.body.folder as string;
		expect(await join_(todosToken, { join: todos.clientId })).toEqual({
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
		const choose = await join_(vocabToken, { join: vocab.clientId });
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

	test('an invitation of a folder attached to an app shows in that app, and it joins once accepted', async () => {
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
		expect((await join_(bobTodos, { join: todos.clientId })).body).toEqual({
			folder,
			made: false,
		});
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
