/**
 * Folders end to end on Bun (ADR-0811): the real routes behind the real
 * authorization server on a disposable Postgres cluster, a real `Bun.serve`
 * listener, and a blob store in memory. Requires initdb and pg_ctl on PATH;
 * never connects to a configured database.
 *
 * Key behaviors:
 * - A folder exists from the request that makes it, and its log answers
 *   over HTTP: changes, files, history, marks, bytes, commits, and imports
 * - A share is an invitation to an email, invisible and granting nothing
 *   until the person who signs in with it, verified, accepts it
 * - Members are equal; a folder survives while any member remains
 * - An app reaches only the folders attached to it; Epicenter attaches one
 * - A listing reads each folder's title from its `epicenter.json`
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
import { createMemoryBlobStore } from '../log/memory-blob-store.js';
import { createServerApp } from '../server-app.js';
import { startDisposablePostgres } from '../test-helpers/disposable-postgres.js';
import { OAuthTestClient, type Person } from '../test-helpers/oauth-client.js';
import type { CloudEnv } from '../types.js';
import { mountAuthRoutes } from './auth.js';
import { mountFolders } from './folders.js';

const secret = 'folders-postgres-secret-0123456789abcdefghij';
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
const blobs = createMemoryBlobStore();
let stopPostgres: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let sql: Client;
let db: Db;
let pool: Pool;
let client: OAuthTestClient;

beforeAll(async () => {
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
	// Requests run at once, as concurrent writers' do, so each takes its own
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
	mountFolders(app, {
		setup: createCloudContextMiddleware(context),
		resolveBlobs: () => blobs,
	});
	client = new OAuthTestClient(origin, sql, secret, async (url, init) =>
		app.fetch(new Request(url, init)),
	);
}, 60_000);

afterAll(async () => {
	server?.stop(true);
	await pool?.end();
	await stopPostgres?.();
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

/** The version `folder` holds at each of `paths`. */
async function versions(token: string, folder: string, paths: string[]) {
	const listed = (await (
		await call(token, 'git', `folders/${folder}/files`, { body: { paths } })
	).json()) as { files?: { path: string; version: string }[] };
	return new Map(
		(listed.files ?? []).map(({ path, version }) => [path, version]),
	);
}

/** Land `files` (path to text) in `folder` in one change, over what each path holds. */
async function write(
	token: string,
	folder: string,
	files: Record<string, string>,
) {
	const held = await versions(token, folder, Object.keys(files));
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

const encoder = new TextEncoder();

/** The SHA-256 of `bytes`, as hex: a version. */
async function sha256(bytes: Uint8Array) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as Uint8Array<ArrayBuffer>,
	);
	return Buffer.from(digest).toString('hex');
}

/** Put `bytes` at `blobs/<sha256>` of `folder`. */
const upload = (token: string, folder: string, bytes: Uint8Array) =>
	sha256(bytes).then((version) =>
		fetch(`${audiences.git}/folders/${folder}/blobs/${version}`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${token}` },
			body: bytes as Uint8Array<ArrayBuffer>,
		}),
	);

describe("a folder's log over HTTP", () => {
	test('one who does not hold a folder gets 403, the same as for a folder that does not exist', async () => {
		const owner = await signedIn('holder');
		const stranger = await signedIn('stranger');
		const folder = await made(owner.token);
		for (const id of [folder, 'zzzzzzzzzzzzzzzz'])
			for (const path of ['changes', 'log'])
				expect(
					(await call(stranger.token, 'git', `folders/${id}/${path}`)).status,
				).toBe(403);
		expect(
			(
				await call(stranger.token, 'git', `folders/${folder}/commits`, {
					body: { files: [{ path: 'a.md', expect: null, text: 'x' }] },
				})
			).status,
		).toBe(403);
	}, 60_000);

	test('a missing or unusable token gets 401 naming resource_metadata, and a read-only token cannot commit', async () => {
		const { token } = await signedIn('challenged');
		const folder = await made(token);
		const changes = `${audiences.git}/folders/${folder}/changes`;
		const none = await fetch(changes);
		expect(none.status).toBe(401);
		expect(none.headers.get('www-authenticate')).toContain(
			`resource_metadata="${origin}/.well-known/oauth-protected-resource/git"`,
		);
		expect(
			(await fetch(changes, { headers: { authorization: 'Bearer nope' } }))
				.status,
		).toBe(401);
		const api = await tokenFor(
			await client.person('api-only'),
			epicenter,
			'openid profile',
			audiences.api,
		);
		expect(
			(await fetch(changes, { headers: { authorization: `Bearer ${api}` } }))
				.status,
		).toBe(401);
		const readOnly = await tokenFor(
			await client.person('read-only'),
			epicenter,
			'openid folders:read folders:all',
		);
		const refused = await call(readOnly, 'git', `folders/${folder}/commits`, {
			body: { files: [{ path: 'a.md', expect: null, text: 'x' }] },
		});
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ error: 'insufficient_scope' });
	}, 60_000);

	test('a capture (a note and its audio) is one change; the audio uploads once, and a resend has moved', async () => {
		const { token } = await signedIn('capture');
		const folder = await made(token);
		const audio = new Uint8Array(40_000).map((_, index) => index % 251);
		const version = await sha256(audio);
		const missing = await call(
			token,
			'git',
			`folders/${folder}/blobs/missing`,
			{
				body: { versions: [version] },
			},
		);
		expect((await missing.json()) as unknown).toEqual({ missing: [version] });
		expect((await upload(token, folder, audio)).status).toBe(201);
		// Bytes it holds are taken again without being kept twice.
		expect((await upload(token, folder, audio)).status).toBe(200);
		const files = [
			{ path: 'captures/a.md', expect: null, text: '# Heard\n' },
			{ path: 'captures/a.webm', expect: null, version },
		];
		const landed = await call(token, 'git', `folders/${folder}/commits`, {
			body: { files },
		});
		expect(landed.status).toBe(200);
		const receipt = (await landed.json()) as {
			cursor: string;
			versions: Record<string, string>;
		};
		expect(receipt.cursor).toMatch(/\.1$/);
		expect(receipt.versions).toEqual({
			'captures/a.md': await sha256(encoder.encode('# Heard\n')),
			'captures/a.webm': version,
		});
		const resent = await call(token, 'git', `folders/${folder}/commits`, {
			body: { files },
		});
		expect(resent.status).toBe(409);
		expect(await resent.json()).toMatchObject({
			error: 'moved',
			moved: [
				{ path: 'captures/a.md', now: receipt.versions['captures/a.md'] },
				{ path: 'captures/a.webm', now: version },
			],
		});
		const read = await fetch(
			`${audiences.git}/folders/${folder}/blobs/${version}`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		expect(read.headers.get('cache-control')).toContain('immutable');
		expect(new Uint8Array(await read.arrayBuffer())).toEqual(audio);
		const blobs = (await (
			await call(token, 'git', `folders/${folder}/blobs`, {
				body: { versions: [receipt.versions['captures/a.md'], version] },
			})
		).json()) as { blobs: unknown[] };
		expect(blobs.blobs).toEqual([
			{ base64: Buffer.from('# Heard\n').toString('base64') },
			{ size: audio.byteLength },
		]);
	}, 60_000);

	test('racing changes over one version: one lands, the rest have moved, and nothing merges', async () => {
		const { token } = await signedIn('racing');
		const folder = await made(token);
		await write(token, folder, { 'a.md': 'base\n' });
		const [held] = (await versions(token, folder, ['a.md'])).values();
		const answers = await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				call(token, 'git', `folders/${folder}/commits`, {
					body: {
						files: [{ path: 'a.md', expect: held, text: `writer ${index}\n` }],
					},
				}),
			),
		);
		const statuses = answers.map(({ status }) => status).sort();
		expect(statuses).toEqual([200, 409, 409, 409, 409, 409]);
		const log = (await (
			await call(token, 'git', `folders/${folder}/log`)
		).json()) as { changes: { seq: number }[] };
		expect(log.changes.map(({ seq }) => seq)).toEqual([2, 1]);
	}, 60_000);

	test('a body past the cap is refused before it is read whole, and bytes over 16 KiB come by upload', async () => {
		const { token } = await signedIn('capped');
		const folder = await made(token);
		const huge = 'x'.repeat(17 * 1024 * 1024);
		const capped = await fetch(`${audiences.git}/folders/${folder}/commits`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				files: [{ path: 'a.md', expect: null, text: huge }],
			}),
		});
		expect(capped.status).toBe(413);
		const inline = await write(token, folder, { 'a.md': 'y'.repeat(20_000) });
		expect(inline.status).toBe(400);
		const head = (await (
			await call(token, 'git', `folders/${folder}/changes`)
		).json()) as { cursor: string };
		expect(head.cursor).toMatch(/\.0$/);
	}, 60_000);

	test('a name differing only in case is refused, naming what the folder holds', async () => {
		const { token } = await signedIn('cased');
		const folder = await made(token);
		await write(token, folder, { 'Notes/Todo.md': 'x' });
		const refused = await write(token, folder, { 'notes/todo.md': 'y' });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({
			error: 'refused',
			path: 'notes/todo.md',
			held: 'Notes/Todo.md',
			reason: 'case',
		});
	}, 60_000);

	test('changes since a cursor answer versions; files, log, and history answer at a seq, a mark, or a time', async () => {
		const { token } = await signedIn('history');
		const folder = await made(token);
		const first = (await (
			await write(token, folder, { 'a.md': 'one', 'b.md': 'x' })
		).json()) as { cursor: string };
		const mark = await call(token, 'git', `folders/${folder}/marks/v1`, {
			method: 'PUT',
			body: {},
		});
		expect(mark.status).toBe(200);
		await write(token, folder, { 'a.md': 'two' });
		const since = (await (
			await call(
				token,
				'git',
				`folders/${folder}/changes?since=${encodeURIComponent(first.cursor)}`,
			)
		).json()) as { changes: unknown };
		expect(since.changes).toEqual([
			{ path: 'a.md', version: await sha256(encoder.encode('two')) },
		]);
		const atMark = (await (
			await call(token, 'git', `folders/${folder}/files`, {
				body: { at: 'v1', bytes: true },
			})
		).json()) as { seq: number; files: { path: string; base64: string }[] };
		expect(atMark.seq).toBe(1);
		expect(
			atMark.files.map(({ path, base64 }) => [
				path,
				Buffer.from(base64, 'base64').toString(),
			]),
		).toEqual([
			['a.md', 'one'],
			['b.md', 'x'],
		]);
		const history = (await (
			await call(token, 'git', `folders/${folder}/log?path=a.md`)
		).json()) as {
			changes: { seq: number; author: string; via: string; marks: string[] }[];
		};
		expect(history.changes.map(({ seq, marks }) => [seq, marks])).toEqual([
			[2, []],
			[1, ['v1']],
		]);
		expect(history.changes[0]?.author).toMatch(
			/^history <history-[0-9a-f-]+@example\.test>$/,
		);
		expect(history.changes[0]?.via).toBe(epicenter.clientId);
		const atTime = (await (
			await call(token, 'git', `folders/${folder}/files`, {
				body: { at: '2000-01-01T00:00:00Z' },
			})
		).json()) as { seq: number; files: unknown[] };
		expect(atTime).toMatchObject({ seq: 0, files: [] });
		const taken = await call(token, 'git', `folders/${folder}/marks/v1`, {
			method: 'PUT',
			body: {},
		});
		expect(taken.status).toBe(409);
		const marks = (await (
			await call(token, 'git', `folders/${folder}/marks`)
		).json()) as { marks: { name: string; seq: number }[] };
		expect(marks.marks).toMatchObject([{ name: 'v1', seq: 1 }]);
	}, 60_000);

	test('a folder made to import takes changes with their own authors and times until the import is done', async () => {
		const { token } = await signedIn('importer');
		const ordinary = await made(token);
		const imported = {
			changes: [
				{
					author: 'Grace <grace@example.test>',
					at: '2019-05-06T07:08:09Z',
					message: 'First',
					files: [{ path: 'a.md', expect: null, text: 'one' }],
				},
			],
		};
		expect(
			(
				await call(token, 'git', `folders/${ordinary}/import`, {
					body: imported,
				})
			).status,
		).toBe(409);
		const made_ = await join_(token, { create: true, import: true });
		expect(made_.status).toBe(201);
		const folder = made_.body.folder as string;
		const landed = await call(token, 'git', `folders/${folder}/import`, {
			body: imported,
		});
		expect(landed.status).toBe(200);
		expect(
			(
				await call(token, 'git', `folders/${folder}/import`, {
					body: { done: true },
				})
			).status,
		).toBe(200);
		const log = (await (
			await call(token, 'git', `folders/${folder}/log`)
		).json()) as {
			changes: { at: string; author: string; message: string }[];
		};
		expect(log.changes).toMatchObject([
			{
				at: '2019-05-06T07:08:09.000Z',
				author: 'Grace <grace@example.test>',
				message: 'First',
			},
		]);
		expect(
			(await call(token, 'git', `folders/${folder}/import`, { body: imported }))
				.status,
		).toBe(409);
		// A finished import is a folder in use: it is never abandoned.
		expect(
			(
				await call(token, 'git', `folders/${folder}/import`, {
					body: { abandon: true },
				})
			).status,
		).toBe(409);
	}, 60_000);

	test('a half-filled import is abandoned: the folder and its log are gone', async () => {
		const { token } = await signedIn('abandoner');
		const made_ = await join_(token, { create: true, import: true });
		const folder = made_.body.folder as string;
		const landed = await call(token, 'git', `folders/${folder}/import`, {
			body: {
				changes: [
					{
						author: 'Ada <ada@example.test>',
						at: '2019-05-06T07:08:09Z',
						message: 'Half',
						files: [{ path: 'a.md', expect: null, text: 'one' }],
					},
				],
			},
		});
		expect(landed.status).toBe(200);
		const abandoned = await call(token, 'git', `folders/${folder}/import`, {
			body: { abandon: true },
		});
		expect(abandoned.status).toBe(200);
		expect((await abandoned.json()) as unknown).toEqual({ abandoned: true });
		expect((await listing(token)).folders.map(({ id }) => id)).not.toContain(
			folder,
		);
		// Its log answers as any folder the person does not hold.
		expect((await call(token, 'git', `folders/${folder}/log`)).status).toBe(
			403,
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
			{
				status: 200,
				body: { person: '<email>', removed: true, folderGone: false },
			},
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
		expect((await call(token, 'git', `folders/${folder}/changes`)).status).toBe(
			200,
		);
		expect((await write(token, folder, { 'a.md': 'mine\n' })).status).toBe(403);
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
		expect((await call(token, 'git', `folders/${folder}/changes`)).status).toBe(
			403,
		);
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
		expect(blobs.keys().filter((key) => key.includes(folder))).toEqual([]);
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
		const forVocab = await join_(platform, {
			create: true,
			app: vocab.clientId,
		});
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
		expect(choose.body.folders?.sort()).toEqual([folder, another].sort());
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

test('one request answers the head of every folder the token reaches', async () => {
	const { token } = await signedIn('heads');
	const a = await made(token);
	const b = await made(token);
	const landed = (await (await write(token, a, { 'a.md': 'a\n' })).json()) as {
		cursor: string;
	};
	const answer = (await (await call(token, 'git', 'folders')).json()) as {
		heads: Record<string, string>;
	};
	expect(answer.heads[a]).toBe(landed.cursor);
	expect(answer.heads[b]).toMatch(/^[a-z0-9]+\.0$/);
	expect(Object.keys(answer.heads).sort()).toEqual([a, b].sort());
}, 60_000);
