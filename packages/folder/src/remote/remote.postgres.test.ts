/**
 * Repository Store Tests
 *
 * A contract's collections over a repository on the real server app
 * (`createDeviceClient` over `repositoryStore`), and the folder over it:
 * the authorization server on a disposable Postgres, a `Bun.serve`
 * listener, the disk Git and LFS stores, and an access token from a real
 * code grant. The account is a stand-in for `@epicenter/account`'s: it
 * carries the token, can be retired, and records every request. A miss
 * here is a write landing over a version its writer never read.
 *
 * Key behaviors:
 * - Another person's repository is reached under their handle, as far as their grant goes
 * - A write over a version the server no longer holds, or where nothing was
 *   expected and a file is, is `'stale'` and lands nothing, even for two at once
 * - The folder writes notes in house style; a note that does not read on
 *   main is listed with its text, and the editor's whole text repairs it
 * - A listing reads only its collection's folder, and only the notes that changed since the last
 * - Listeners hear this store's writes at once and other writers' within a poll of `main`
 * - A raced write is `'stale'`, never a merge on the server; the folder reads
 *   again and carries its change over the other writer's
 * - A retired account makes every call `Unavailable`, never a throw
 *
 * Requires initdb and pg_ctl on PATH; never connects to a configured database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account } from '@epicenter/account';
import {
	compileContract,
	defineContract,
} from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import { hostFromSiteUrl, repositoryName } from '@epicenter/definition/site';
import {
	type CloudEnv,
	createCloudContextMiddleware,
	createDb,
	createDiskGitHost,
	createDiskLfsStore,
	createServerApp,
	mountAuthRoutes,
	mountGitHost,
	registerFirstPartyClients,
} from '@epicenter/server/bun';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { compress } from 'hono/compress';
import { type Client, Pool } from 'pg';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { startDisposablePostgres } from '../../../server/src/test-helpers/disposable-postgres.js';
import { OAuthTestClient } from '../../../server/src/test-helpers/oauth-client.js';
import type { Unavailable, Version } from '../device/store.js';
import { createFolder } from '../folder.js';
import { noteCodec } from '../note-codec.js';
import { storeChecks } from '../device/store.conformance.js';
import { repositoryStore } from './store.js';

const recorder = defineContract({
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: { title: { type: 'string' } },
			required: ['title'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
	},
});

const secret = 'folder-remote-secret-0123456789abcdefghij';
const demo = {
	clientId: 'so.epicenter.recorder',
	redirectUri: 'https://recorder.example.test/auth/callback',
};

let scratch: string;
let origin = '';
let audiences = { api: '', git: '' };
let stopPostgres: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let sql: Client;
let pool: Pool;
let oauth: OAuthTestClient;

const signIn = signInPerson;

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), 'epicenter-remote-'));
	const cluster = await startDisposablePostgres();
	stopPostgres = cluster.stop;
	sql = cluster.clients[0];
	await migrate(createDb(sql), {
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
		idleTimeout: 60,
	});
	origin = `http://127.0.0.1:${server.port}`;
	audiences = { api: origin, git: `${origin}/git` };
	pool = new Pool({
		host: '127.0.0.1',
		port: cluster.port,
		user: 'postgres',
		database: 'postgres',
	});
	await registerFirstPartyClients(createDb(pool), {
		audiences,
		clients: [
			{
				clientId: demo.clientId,
				name: 'Recorder',
				redirectUris: [demo.redirectUri],
				grantTypes: ['authorization_code'],
				scopes: ['openid', 'profile', 'folders:read', 'folders:write'],
				resources: [audiences.api, audiences.git],
				skipConsent: true,
				applicationType: 'web',
			},
		],
	});
	const requestDb = createDb(pool);
	const context = {
		connect: async () => ({ db: requestDb, close: async () => {} }),
		afterResponse: () => {},
		resolveAuthSecrets: () => ({ BETTER_AUTH_SECRET: secret }),
	};
	mountAuthRoutes(app, {
		setup: createCloudContextMiddleware({ ...context, oauthServer: true }),
		serveAuthUiShell: (c) => c.html('<html>shell</html>'),
	});
	const host = createDiskGitHost({ root: join(scratch, 'git-store') });
	const lfs = createDiskLfsStore({ root: join(scratch, 'lfs-store') });
	// As the Bun entry (`apps/api/server.ts`) does.
	app.use('/git/*', compress());
	mountGitHost(app, {
		setup: createCloudContextMiddleware(context),
		resolveHost: () => host,
		resolveLfs: () => lfs,
	});
	oauth = new OAuthTestClient(origin, sql, secret, async (url, init) =>
		app.fetch(new Request(url, init)),
	);
}, 120_000);

afterAll(async () => {
	server?.stop(true);
	await pool?.end();
	await stopPostgres?.();
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

type Sent = { method: string; url: string; body: unknown };

type Location =
	| { site: string; repository?: `${string}/${string}` }
	| { site?: string; repository: `${string}/${string}` };

type At = { account: Account } & Location;

/** The store of the repository `account` reaches at `repository`, else the site's own. */
const storeAt = ({ account, site, repository }: At, pollMs?: number) =>
	repositoryStore(
		account,
		repository ?? `~/${repositoryName(hostFromSiteUrl(site ?? ''))}`,
		{ pollMs },
	);

/** A file as a test reads it below the folder: its version, and what a reader shows of it. */
type Seen = {
	path: string;
	version: Version;
	text: string | null;
	item: Record<string, unknown> | null;
};

/**
 * The recorder's collections over a repository's store, below the folder:
 * each file with its version, and a write over one, as another program on
 * the server's side would see them.
 */
function filesAt(at: At) {
	const store = storeAt(at);
	const { data: compiled, error } = compileContract(recorder);
	if (error !== null) throw new Error(error.message);
	const files = (name: 'recordings' | 'audio') => {
		const declared = compiled.collections.find(
			(collection) => collection.name === name,
		);
		if (declared === undefined) throw new Error(`no collection ${name}`);
		const codec = noteCodec(declared);
		const seen = (path: string, bytes: Uint8Array, version: Version): Seen => {
			const params = compiled.claim(path)?.params ?? {};
			if (declared.kind !== 'note')
				return { path, version, text: null, item: params };
			const text = codec.text(bytes);
			const decoded = text === null ? null : codec.decode(path, text);
			return {
				path,
				version,
				text,
				item:
					decoded === null || decoded.error !== null
						? null
						: { ...decoded.data.fields, ...params, body: decoded.data.body },
			};
		};
		return {
			async write(
				path: string,
				bytes: Uint8Array | null,
				over: Version | null,
			): Promise<Result<Seen | null | 'stale', Unavailable>> {
				const written = await store.write(path, bytes, over ?? 'absent');
				if (written.error !== null) return written;
				if (written.data === 'stale') return Ok('stale' as const);
				if (bytes === null || written.data === null) return Ok(null);
				return Ok(seen(path, bytes, written.data));
			},
			async read(
				path: string,
			): Promise<Result<(Seen & { bytes: Uint8Array }) | null, Unavailable>> {
				const read = await store.read([path]);
				if (read.error !== null) return read;
				const [file] = read.data;
				if (file === undefined || 'gone' in file) return Ok(null);
				return Ok({ ...seen(path, file.bytes, file.version), bytes: file.bytes });
			},
			async list(): Promise<Result<Seen[], Unavailable>> {
				const listed = await store.list(['recordings']);
				if (listed.error !== null) return listed;
				const mine = listed.data
					.filter(({ path }) => compiled.claim(path)?.collection.name === name)
					.sort((a, b) => (a.path < b.path ? -1 : 1));
				if (declared.kind !== 'note')
					return Ok(
						mine.map(({ path, version }) =>
							seen(path, new Uint8Array(), version),
						),
					);
				const read = await store.read(mine.map(({ path }) => path));
				if (read.error !== null) return read;
				return Ok(
					read.data.flatMap((file) =>
						'gone' in file ? [] : [seen(file.path, file.bytes, file.version)],
					),
				);
			},
		};
	};
	return { store, recordings: files('recordings'), audio: files('audio') };
}

/** The recorder's folder over a repository. */
const folderAt = (at: At, pollMs?: number) =>
	createFolder(recorder, async () => Ok(storeAt(at, pollMs)));

/** What a write that landed a file left. */
function landed(written: Seen | null | 'stale'): Seen {
	if (written === null || written === 'stale')
		throw new Error(`expected a file to land, got ${written}`);
	return written;
}

const encoder = new TextEncoder();
/** A note's bytes, in house style. */
const note = (fields: string, body = '') =>
	encoder.encode(`---\n${fields}---\n${body}`);

/**
 * A signed-in person's account, as `@epicenter/account` gives one: every
 * request to the server carries the token, and none leaves once retired.
 */
async function signInPerson(label: string) {
	const person = await oauth.person(label);
	const { access_token: token } = await oauth.codeGrant({
		...demo,
		cookie: person.cookie,
		resource: [audiences.git],
		scope: 'openid folders:read folders:write',
	});
	const lifetime = new AbortController();
	const sent: Sent[] = [];
	/** Run once, right before the account's next write reaches the server. */
	let beforeWrite: (() => Promise<void>) | undefined;
	const account: Account = {
		authorityId: 'test-authority',
		principalId: person.id as Account['principalId'],
		baseURL: origin,
		signal: lifetime.signal,
		async fetch(input, init) {
			lifetime.signal.throwIfAborted();
			const url = String(input instanceof Request ? input.url : input);
			if (new URL(url).origin !== origin)
				throw new TypeError('Account requests must target their own server.');
			const method = init?.method ?? 'GET';
			if (method === 'POST' && url.endsWith('/epicenter/writes')) {
				const before = beforeWrite;
				beforeWrite = undefined;
				await before?.();
			}
			const headers = new Headers(init?.headers);
			headers.set('authorization', `Bearer ${token}`);
			const response = await fetch(url, {
				...init,
				headers,
				signal: lifetime.signal,
			});
			const body = response.headers.get('content-type')?.includes('json')
				? await response.clone().json()
				: null;
			sent.push({ method, url, body });
			return response;
		},
		getProfile: async () => {
			throw new Error('not used');
		},
	};
	return {
		account,
		/** The person's handle: their personal namespace's id. */
		handle: person.personal,
		token,
		sent,
		/** The requests whose `METHOD url` matches `pattern`. */
		requests: (pattern: RegExp) =>
			sent.filter(({ method, url }) => pattern.test(`${method} ${url}`)),
		retire: () => lifetime.abort(new Error('signed out')),
		/** Make `task` run right before the account's next write reaches the server. */
		raceNextWrite(task: () => Promise<void>) {
			beforeWrite = task;
		},
		/** Write `files` as another writer to the person's own repository. */
		async writeRaw(files: unknown[]) {
			const response = await fetch(
				`${audiences.git}/~/recorder.git/epicenter/writes`,
				{
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ files }),
				},
			);
			expect(response.status).toBe(200);
		},
	};
}

/** The file at `path` in the person's own repository, as the server answers a read of it. */
async function readRaw(account: Account, path: string) {
	const response = await account.fetch(
		`${audiences.git}/~/recorder.git/epicenter/read`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ paths: [path] }),
		},
	);
	const { files } = (await response.json()) as {
		files: { text: string; blob: Version }[];
	};
	return files[0]!;
}

describe('a repository: the store conformance checks', () => {
	for (const [name, run] of Object.entries(storeChecks))
		test(name, async () => {
			const person = await signIn(`conformance-${name.replaceAll(' ', '-')}`);
			const store = repositoryStore(person.account, '~/recorder', {
				pollMs: 100,
			});
			// Another computer of the same person, writing over what it reads.
			const other = repositoryStore(person.account, '~/recorder');
			await run({
				store,
				async outside(path, bytes) {
					const [there] = expectOk(await other.read([path]));
					const over =
						there === undefined || 'gone' in there ? 'absent' : there.version;
					if (bytes === null && over === 'absent') return;
					expect(expectOk(await other.write(path, bytes, over))).not.toBe(
						'stale',
					);
				},
			});
		}, 30_000);
});

describe('a repository as a store', () => {
	const site = 'https://recorder.epicenter.so';

	test("another person's repository is reached under their handle, as far as their grant goes", async () => {
		const alice = await signIn('shared-owner');
		const bob = await signIn('shared-guest');
		const id = timeId();
		const path = `recordings/${id}.md`;
		landed(
			expectOk(
				await filesAt({ account: alice.account, site }).recordings.write(
					path,
					note('title: For Bob\n'),
					null,
				),
			),
		);
		const theirs = filesAt({
			account: bob.account,
			repository: `${alice.handle}/recorder`,
		});
		expect(expectErr(await theirs.recordings.list())).toMatchObject({
			name: 'Unavailable',
			cause: { name: 'Refused', status: 403 },
		});

		const granted = await fetch(
			`${origin}/api/repos/~/recorder/grants/${bob.handle}`,
			{
				method: 'PUT',
				headers: {
					authorization: `Bearer ${alice.token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ level: 'read' }),
			},
		);
		expect(granted.status).toBe(200);
		const read = expectOk(await theirs.recordings.read(path));
		if (read === null) throw new Error('expected the note');
		expect(read.item).toMatchObject({ id, title: 'For Bob' });
		expect(
			expectErr(
				await theirs.recordings.write(
					path,
					note('title: From Bob\n'),
					read.version,
				),
			),
		).toMatchObject({
			name: 'Unavailable',
			cause: { name: 'Refused', status: 403 },
		});
		// The default is still Bob's own repository.
		expect(
			expectOk(await filesAt({ account: bob.account, site }).recordings.list()),
		).toEqual([]);
		expect(() =>
			storeAt({ account: bob.account, repository: 'Alice/recorder' }),
		).toThrow('names no repository');
	}, 30_000);

	test("a write over a version the server no longer holds is 'stale', and nothing lands", async () => {
		const person = await signIn('stale');
		const { recordings } = filesAt({ account: person.account, site });
		const id = timeId();
		const path = `recordings/${id}.md`;
		const created = landed(
			expectOk(
				await recordings.write(path, note('title: First\n', 'one\n'), null),
			),
		);
		const updated = landed(
			expectOk(
				await recordings.write(
					path,
					note('title: Second\n', 'one\n'),
					created.version,
				),
			),
		);
		expect(updated.item).toEqual({ id, title: 'Second', body: 'one\n' });

		expect(
			expectOk(
				await recordings.write(path, note('title: Third\n'), created.version),
			),
		).toBe('stale');
		expect(expectOk(await recordings.write(path, null, created.version))).toBe(
			'stale',
		);
		const now = expectOk(await recordings.read(path));
		expect(now?.version).toBe(updated.version);
		expect(now?.item).toMatchObject({ title: 'Second' });

		expect(
			expectOk(await recordings.write(path, null, updated.version)),
		).toBeNull();
		expect(expectOk(await recordings.read(path))).toBeNull();
	}, 30_000);

	test("a file write over a stale version is 'stale', and its bytes stay off the server", async () => {
		const person = await signIn('stale-file');
		const { audio } = filesAt({ account: person.account, site });
		const id = timeId();
		const path = `recordings/${id}.webm`;
		const created = landed(
			expectOk(await audio.write(path, new Uint8Array([1, 2, 3]), null)),
		);
		const second = landed(
			expectOk(
				await audio.write(path, new Uint8Array([4, 5, 6]), created.version),
			),
		);
		expect(
			expectOk(
				await audio.write(path, new Uint8Array([7, 8, 9]), created.version),
			),
		).toBe('stale');
		expect(
			expectOk(await audio.list()).map(({ item, version }) => ({
				item,
				version,
			})),
		).toEqual([{ item: { id, ext: 'webm' }, version: second.version }]);
		expect(expectOk(await audio.read(path))?.bytes).toEqual(
			new Uint8Array([4, 5, 6]),
		);
	}, 30_000);

	test("a write expecting nothing is 'stale' where a file already is", async () => {
		const person = await signIn('occupied');
		const { recordings } = filesAt({ account: person.account, site });
		const path = `recordings/${timeId()}.md`;
		landed(expectOk(await recordings.write(path, note('title: Mine\n'), null)));
		expect(
			expectOk(await recordings.write(path, note('title: Again\n'), null)),
		).toBe('stale');
		expect(expectOk(await recordings.read(path))?.item).toMatchObject({
			title: 'Mine',
		});
	}, 30_000);

	test("the folder writes notes in house style, and a listing gives each note's blob as its version", async () => {
		const person = await signIn('house-style');
		const folder = folderAt({ account: person.account, site });
		const id = timeId();
		const path = `recordings/${id}.md`;
		await folder.recordings.set({ id }, {
			zeta: 1,
			title: 'Styled',
			body: 'text\n',
		} as never);
		const shown = folder.recordings.get({ id });
		expect(shown).toMatchObject({ id, title: 'Styled', body: 'text\n' });
		expect(expectOk(await folder.recordings.list())).toEqual({
			items: [shown!],
			invalid: [],
		});
		const file = await readRaw(person.account, path);
		expect(file.text).toBe('---\ntitle: Styled\nzeta: 1\n---\ntext\n');
		const listed = expectOk(
			await filesAt({ account: person.account, site }).recordings.list(),
		);
		expect(listed.map(({ path, version }) => ({ path, version }))).toEqual([
			{ path, version: file.blob },
		]);
		folder[Symbol.dispose]();
	}, 30_000);

	test("a note that does not read on main is listed with its text, and the editor's whole text repairs it", async () => {
		const person = await signIn('repair');
		const id = timeId();
		const path = `recordings/${id}.md`;
		const broken = '---\ntitle: [unclosed\n---\nKept.\n';
		const raw = await person.account.fetch(
			`${audiences.git}/~/recorder.git/epicenter/writes`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					files: [{ path, base: null, text: broken }],
				}),
			},
		);
		expect(raw.status).toBe(200);
		const folder = folderAt({ account: person.account, site });
		const { invalid } = expectOk(await folder.recordings.list());
		expect(invalid).toHaveLength(1);
		expect(invalid[0]).toMatchObject({ id, path, text: broken });
		const files = filesAt({ account: person.account, site });
		const [seen] = expectOk(await files.recordings.list());
		if (seen === undefined) throw new Error('expected the broken note');
		expect(seen).toMatchObject({ item: null, text: broken });

		const editor = folder.recordings.edit({ id });
		expect(editor.text).toBe(broken);
		const repaired = '---\nzeta: 1\ntitle: Fixed\n---\nKept.\n';
		editor.text = repaired;
		await editor.landed();
		expect(folder.recordings.get({ id })).toMatchObject({
			id,
			title: 'Fixed',
			body: 'Kept.\n',
		});
		expect(folder.recordings.invalid()).toEqual([]);
		// A whole text that reads is written in house style.
		expect((await readRaw(person.account, path)).text).toBe(
			'---\ntitle: Fixed\nzeta: 1\n---\nKept.\n',
		);
		// The broken note's version is no longer there to write over.
		expect(
			expectOk(
				await files.recordings.write(path, note('title: X\n'), seen.version),
			),
		).toBe('stale');
		folder[Symbol.dispose]();
	}, 30_000);

	test("a watch hears another writer's paths within a poll, and its polls stop with its stop", async () => {
		const person = await signIn('notify');
		const { store } = filesAt({ account: person.account, site });
		const other = filesAt({ account: person.account, site });
		const POLL = /^GET .*\/epicenter\/changes\?since=/;
		const heard: (readonly string[] | 'all')[] = [];
		const stop = expectOk(await store.watch((paths) => heard.push(paths)));
		const path = `recordings/${timeId()}.md`;
		landed(
			expectOk(await other.recordings.write(path, note('title: Theirs\n'), null)),
		);
		for (let turn = 0; turn < 100 && heard.length === 0; turn++)
			await Bun.sleep(50);
		// The paths the tree diff names, the repository's attributes with the first write.
		expect(heard.flat()).toContain(path);
		expect(person.requests(POLL).length).toBeGreaterThan(0);

		stop();
		await Bun.sleep(100);
		const polls = person.requests(POLL).length;
		await Bun.sleep(3500);
		expect(person.requests(POLL).length).toBe(polls);
	}, 30_000);

	test("two writes expecting nothing at one path at once: one lands, the other is 'stale'", async () => {
		const person = await signIn('create-race');
		const { recordings, audio } = filesAt({ account: person.account, site });
		const id = timeId();
		const outcome = (written: Seen | null | 'stale') =>
			written === 'stale' ? 'stale' : 'landed';
		const notes = await Promise.all(
			['A', 'B'].map((title) =>
				recordings.write(
					`recordings/${id}.md`,
					note(`title: ${title}\n`),
					null,
				),
			),
		);
		expect(notes.map((written) => outcome(expectOk(written))).sort()).toEqual([
			'landed',
			'stale',
		]);
		const sounds = await Promise.all(
			[1, 2].map((byte) =>
				audio.write(`recordings/${id}.webm`, new Uint8Array([byte]), null),
			),
		);
		expect(sounds.map((written) => outcome(expectOk(written))).sort()).toEqual([
			'landed',
			'stale',
		]);
	}, 30_000);

	test("a file listing names each file's version without downloading its bytes", async () => {
		const person = await signIn('list-no-lfs');
		const { audio } = filesAt({ account: person.account, site });
		const created: Seen[] = [];
		for (const id of [timeId(), timeId()])
			created.push(
				landed(
					expectOk(
						await audio.write(
							`recordings/${id}.webm`,
							encoder.encode(`audio ${id}`),
							null,
						),
					),
				),
			);
		person.sent.length = 0;
		const listed = expectOk(await audio.list());
		expect(listed.map(({ version }) => version).sort()).toEqual(
			created.map(({ version }) => version).sort(),
		);
		expect(person.requests(/lfs/)).toEqual([]);
		expect(person.sent).toHaveLength(1);
	}, 30_000);

	test("a folder's connection lists its folder once and reads every note in one request; another writer's change is read alone", async () => {
		const person = await signIn('connect');
		const other = filesAt({ account: person.account, site });
		const ids = [timeId(), timeId()];
		const created: Seen[] = [];
		for (const id of ids)
			created.push(
				landed(
					expectOk(
						await other.recordings.write(
							`recordings/${id}.md`,
							note(`title: ${id}\n`),
							null,
						),
					),
				),
			);
		const READ = /^POST .*\/epicenter\/read$/;
		const LIST = /^GET .*\/epicenter\/files\?root=$/;
		person.sent.length = 0;
		const folder = folderAt({ account: person.account, site }, 100);
		for (let turn = 0; turn < 200 && folder.state().status !== 'open'; turn++)
			await Bun.sleep(10);
		expect(folder.recordings.items()).toHaveLength(2);
		expect(person.requests(LIST)).toHaveLength(1);
		const reads = person.requests(READ);
		expect(reads).toHaveLength(1);

		const [first] = created;
		if (first === undefined) throw new Error('expected a note');
		person.sent.length = 0;
		landed(
			expectOk(
				await other.recordings.write(
					first.path,
					note('title: Changed\n'),
					first.version,
				),
			),
		);
		for (
			let turn = 0;
			turn < 100 && folder.recordings.get({ id: ids[0]! })?.title !== 'Changed';
			turn++
		)
			await Bun.sleep(50);
		expect(folder.recordings.get({ id: ids[0]! })?.title).toBe('Changed');
		expect(person.requests(LIST)).toHaveLength(0);
		const read = person.requests(READ);
		expect(read).toHaveLength(1);
		folder[Symbol.dispose]();
	}, 30_000);

	test("a note write raced by another is 'stale', never a merge on the server", async () => {
		const person = await signIn('raced');
		const { recordings } = filesAt({ account: person.account, site });
		const path = `recordings/${timeId()}.md`;
		const created = landed(
			expectOk(
				await recordings.write(path, note('title: One\n', 'a\nb\nc\n'), null),
			),
		);
		const theirs = '---\ntitle: One\n---\na\nb\nC\n';
		person.raceNextWrite(() =>
			person.writeRaw([{ path, base: created.version, text: theirs }]),
		);
		expect(
			expectOk(
				await recordings.write(
					path,
					note('title: Two\n', 'a\nb\nc\n'),
					created.version,
				),
			),
		).toBe('stale');
		const now = expectOk(await recordings.read(path));
		expect(now?.version).not.toBe(created.version);
		expect(now?.text).toBe(theirs);
	}, 30_000);

	test("a folder carries a raced write over the other writer's change: both land", async () => {
		const person = await signIn('carried');
		const folder = folderAt({ account: person.account, site });
		const id = timeId();
		const path = `recordings/${id}.md`;
		await folder.recordings.set({ id }, { title: 'One', body: 'a\nb\nc\n' });
		const created = expectOk(
			await filesAt({ account: person.account, site }).recordings.read(path),
		);
		if (created === null) throw new Error('expected the note');
		person.raceNextWrite(() =>
			person.writeRaw([
				{
					path,
					base: created.version,
					text: '---\ntitle: One\n---\na\nb\nC\n',
				},
			]),
		);
		await folder.recordings.set({ id }, { title: 'Two' });
		const both = { id, title: 'Two', body: 'a\nb\nC\n' };
		expect(folder.recordings.get({ id })).toEqual(both);
		expect(
			expectOk(
				await filesAt({ account: person.account, site }).recordings.read(path),
			)?.item,
		).toEqual(both);
		folder[Symbol.dispose]();
	}, 30_000);

	test('a retired account makes every call Unavailable, never a throw', async () => {
		const person = await signIn('retired-reads');
		const { recordings } = filesAt({ account: person.account, site });
		person.retire();
		const folder = folderAt({ account: person.account, site });
		person.retire();
		expect(expectErr(await recordings.list()).name).toBe('Unavailable');
		expect(
			expectErr(
				await recordings.write('recordings/a.md', note('title: A\n'), null),
			).name,
		).toBe('Unavailable');
		// The folder keeps trying to connect, saying why.
		for (let turn = 0; turn < 100 && folder.unavailable() === null; turn++)
			await Bun.sleep(10);
		expect(folder.state().status).toBe('opening');
		expect(folder.unavailable()?.name).toBe('Unavailable');
		folder[Symbol.dispose]();
	}, 30_000);
});

/**
 * First paint over the repository on a slow link (ADR-0778): the time from
 * the page starting to the folder's snapshot landing and the recordings'
 * first read, with about 5,000 recording notes, through an account whose
 * every request waits half a round trip each way and carries its bytes at
 * the link's rate. Run with `EPICENTER_MEASURE=1`; it prints what it took.
 *
 * A reply crosses the link as the server sent it: gzipped by the Bun host's
 * `compress()`, as a browser that accepts it would receive it, and decoded
 * after it is counted. The hosted Worker's replies are compressed by
 * Cloudflare's edge instead (Brotli or Zstandard), which this does not run.
 */
describe('a repository on a slow link', () => {
	const site = 'https://recorder.epicenter.so';
	test.skipIf(!process.env.EPICENTER_MEASURE)(
		'first paint with about 5,000 recording notes at 3 Mbps and 100 ms',
		async () => {
			const NOTES = 5000;
			const person = await signIn('first-paint');
			for (let start = 0; start < NOTES; start += 1000)
				await person.writeRaw(
					Array.from({ length: Math.min(1000, NOTES - start) }, (_, offset) => ({
						path: `recordings/2026-10-31T09-30-00-${String(start + offset).padStart(6, '0')}.md`,
						base: null,
						text: `---\ntitle: Recording ${start + offset}\n---\n${'A sentence of what was said, as a transcript keeps it. '.repeat(4)}\n`,
					})),
				);
			const link = { roundTripMs: 100, bitsPerSecond: 3_000_000 };
			const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
			const carried = (bytes: number) => (bytes * 8 * 1000) / link.bitsPerSecond;
			const sent = { requests: 0, up: 0, down: 0, decoded: 0 };
			const slow: Account = {
				...person.account,
				async fetch(input, init) {
					const body = init?.body;
					const up =
						typeof body === 'string'
							? new TextEncoder().encode(body).byteLength
							: body instanceof Uint8Array
								? body.byteLength
								: 0;
					await wait(link.roundTripMs / 2 + carried(up));
					const headers = new Headers(init?.headers);
					headers.set('authorization', `Bearer ${person.token}`);
					headers.set('accept-encoding', 'gzip, deflate, br, zstd');
					// The reply's bytes as they crossed the link, before decoding.
					const response = await fetch(String(input), {
						...init,
						headers,
						decompress: false,
					});
					const wire = new Uint8Array(await response.arrayBuffer());
					const encoding = response.headers.get('content-encoding');
					if (encoding !== null && encoding !== 'gzip')
						throw new Error(`unexpected content-encoding ${encoding}`);
					const bytes = encoding === 'gzip' ? Bun.gunzipSync(wire) : wire;
					sent.requests++;
					sent.up += up;
					sent.down += wire.byteLength;
					sent.decoded += bytes.byteLength;
					await wait(link.roundTripMs / 2 + carried(wire.byteLength));
					const decoded = new Headers(response.headers);
					decoded.delete('content-encoding');
					decoded.delete('content-length');
					return new Response(bytes, {
						status: response.status,
						statusText: response.statusText,
						headers: decoded,
					});
				},
			};
			const started = performance.now();
			const folder = folderAt({ account: slow, site });
			await new Promise<void>((resolve) => {
				const stop = folder.subscribe(() => {
					if (folder.state().status !== 'open') return;
					stop();
					resolve();
				});
			});
			const connected = performance.now();
			const shown = folder.recordings.items().length;
			const painted = performance.now();
			folder[Symbol.dispose]();
			expect(shown).toBe(NOTES);
			console.log(
				JSON.stringify({
					store: 'repository',
					link,
					notes: NOTES,
					connectMs: Math.round(connected - started),
					parseMs: Math.round(painted - connected),
					firstPaintMs: Math.round(painted - started),
					requests: sent.requests,
					uploadedBytes: sent.up,
					downloadedBytes: sent.down,
					decodedBytes: sent.decoded,
				}),
			);
		},
		300_000,
	);
});
