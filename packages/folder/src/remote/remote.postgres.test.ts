/**
 * Remote Client Tests
 *
 * `openRemote` against the real server app: the authorization server on a
 * disposable Postgres, a `Bun.serve` listener, the disk Git and LFS stores,
 * and an access token from a real code grant. The account is a stand-in for
 * `@epicenter/auth`'s: it carries the token, can be retired, and records
 * every request. A miss here is a write landing over a version its writer
 * never read.
 *
 * Key behaviors:
 * - Another person's repository is reached under their handle, as far as their grant goes
 * - The remote client refuses a stale version (`Conflict`) and an occupied path (`Occupied`)
 * - A note that does not read on main is listed with its text, and `replace` repairs it
 * - Listeners hear this client's writes at once and other writers' within a poll of `main`
 * - A retired account makes every call `Unavailable`, never a throw
 *
 * Requires initdb and pg_ctl on PATH; never connects to a configured database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account } from '@epicenter/auth';
import { defineContract, type Version } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
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
import { type Client, Pool } from 'pg';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { startDisposablePostgres } from '../../../server/src/test-helpers/disposable-postgres.js';
import { OAuthTestClient } from '../../../server/src/test-helpers/oauth-client.js';
import { openRemote } from '../remote.js';

const recorder = defineContract({
	name: 'recorder',
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
	clientId: 'so.epicenter.recorder-demo',
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

/**
 * A signed-in person's account, as `@epicenter/auth` gives one: every
 * request to the server carries the token, and none leaves once retired.
 */
async function signIn(label: string) {
	const person = await oauth.person(label);
	const { access_token: token } = await oauth.codeGrant({
		...demo,
		cookie: person.cookie,
		resource: [audiences.git],
		scope: 'openid folders:read folders:write',
	});
	const lifetime = new AbortController();
	const sent: Sent[] = [];
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
	};
}

describe('the remote client', () => {
	test("another person's repository is reached under their handle, as far as their grant goes", async () => {
		const alice = await signIn('shared-owner');
		const bob = await signIn('shared-guest');
		const id = timeId();
		expectOk(
			await openRemote(recorder, { account: alice.account }).recordings.create({
				id,
				title: 'For Bob',
			}),
		);
		const theirs = openRemote(recorder, {
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
		const note = expectOk(await theirs.recordings.get({ id }));
		expect(note.title).toBe('For Bob');
		expect(
			expectErr(
				await theirs.recordings.update(
					{ id },
					{ title: 'From Bob' },
					{ over: note.version },
				),
			),
		).toMatchObject({
			name: 'Unavailable',
			cause: { name: 'Refused', status: 403 },
		});
		// The default is still Bob's own repository.
		expect(
			expectOk(
				await openRemote(recorder, { account: bob.account }).recordings.list(),
			).items,
		).toEqual([]);
		expect(() =>
			openRemote(recorder, {
				account: bob.account,
				repository: 'Alice/recorder',
			}),
		).toThrow('names no repository');
	}, 30_000);

	test('a write over a version the server no longer holds is a Conflict, and nothing lands', async () => {
		const person = await signIn('stale');
		const remote = openRemote(recorder, { account: person.account });
		const id = timeId();
		const created = expectOk(
			await remote.recordings.create({ id, title: 'First', body: 'one\n' }),
		);
		const updated = expectOk(
			await remote.recordings.update(
				{ id },
				{ title: 'Second' },
				{ over: created.version },
			),
		);
		expect(updated).toMatchObject({ title: 'Second', body: 'one\n' });

		const stale = expectErr(
			await remote.recordings.update(
				{ id },
				{ title: 'Third' },
				{ over: created.version },
			),
		);
		expect(stale).toMatchObject({
			name: 'Conflict',
			path: `recordings/${id}.md`,
			current: updated.version,
		});
		expect(
			expectErr(
				await remote.recordings.delete({ id }, { over: created.version }),
			),
		).toMatchObject({ name: 'Conflict', current: updated.version });
		expect(expectOk(await remote.recordings.get({ id })).title).toBe('Second');

		expectOk(await remote.recordings.delete({ id }, { over: updated.version }));
		expect(expectErr(await remote.recordings.get({ id })).name).toBe(
			'NotFound',
		);
	}, 30_000);

	test('a file update over a stale version is a Conflict, and its bytes stay off the server', async () => {
		const person = await signIn('stale-file');
		const remote = openRemote(recorder, { account: person.account });
		const id = timeId();
		const first = new Uint8Array([1, 2, 3]);
		const created = expectOk(
			await remote.audio.create({ id, ext: 'webm', bytes: first }),
		);
		const second = expectOk(
			await remote.audio.update(
				{ id, ext: 'webm' },
				{ bytes: new Uint8Array([4, 5, 6]) },
				{ over: created.version },
			),
		);
		expect(
			expectErr(
				await remote.audio.update(
					{ id, ext: 'webm' },
					{ bytes: new Uint8Array([7, 8, 9]) },
					{ over: created.version },
				),
			),
		).toMatchObject({ name: 'Conflict', current: second.version });
		expect(expectOk(await remote.audio.list()).items).toEqual([
			{ id, ext: 'webm', version: second.version },
		]);
	}, 30_000);

	test('create is refused where a file already is', async () => {
		const person = await signIn('occupied');
		const remote = openRemote(recorder, { account: person.account });
		const id = timeId();
		expectOk(await remote.recordings.create({ id, title: 'Mine' }));
		expect(
			expectErr(await remote.recordings.create({ id, title: 'Again' })).name,
		).toBe('Occupied');
		expect(expectOk(await remote.recordings.get({ id })).title).toBe('Mine');
	}, 30_000);

	test('notes are written in house style and listed with their versions', async () => {
		const person = await signIn('house-style');
		const remote = openRemote(recorder, { account: person.account });
		const id = timeId();
		const created = expectOk(
			await remote.recordings.create({
				id,
				zeta: 1,
				title: 'Styled',
				body: 'text\n',
			} as never),
		);
		const listed = expectOk(await remote.recordings.list());
		expect(listed).toEqual({ items: [created], invalid: [] });
		const file = await person.account.fetch(
			`${audiences.git}/~/recorder.git/epicenter/file?path=recordings/${id}.md`,
		);
		expect(((await file.json()) as { text: string }).text).toBe(
			'---\ntitle: Styled\nzeta: 1\n---\ntext\n',
		);
		expect(created.version).toBe(
			(
				(await (
					await person.account.fetch(
						`${audiences.git}/~/recorder.git/epicenter/file?path=recordings/${id}.md`,
					)
				).json()) as { blob: Version }
			).blob,
		);
	}, 30_000);

	test('a note that does not read on main is listed with its text and version, and replace repairs it', async () => {
		const person = await signIn('repair');
		const remote = openRemote(recorder, { account: person.account });
		const id = timeId();
		const broken = '---\ntitle: [unclosed\n---\nKept.\n';
		const raw = await person.account.fetch(
			`${audiences.git}/~/recorder.git/epicenter/writes`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					files: [{ path: `recordings/${id}.md`, text: broken }],
				}),
			},
		);
		expect(raw.status).toBe(200);
		const { invalid } = expectOk(await remote.recordings.list());
		expect(invalid).toHaveLength(1);
		const [entry] = invalid;
		if (entry === undefined) throw new Error('expected the broken note');
		expect(entry).toMatchObject({
			id,
			path: `recordings/${id}.md`,
			text: broken,
		});
		expect(
			expectErr(
				await remote.recordings.replace({ id }, '---\ntitle: [\n---\n', {
					over: entry.version,
				}),
			).name,
		).toBe('Invalid');
		const repaired = expectOk(
			await remote.recordings.replace(
				{ id },
				'---\nzeta: 1\ntitle: Fixed\n---\nKept.\n',
				{ over: entry.version },
			),
		);
		expect(repaired).toMatchObject({ id, title: 'Fixed', body: 'Kept.\n' });
		expect(expectOk(await remote.recordings.get({ id }))).toEqual(repaired);
		const file = await person.account.fetch(
			`${audiences.git}/~/recorder.git/epicenter/file?path=recordings/${id}.md`,
		);
		expect(((await file.json()) as { text: string }).text).toBe(
			'---\ntitle: Fixed\nzeta: 1\n---\nKept.\n',
		);
		expect(
			expectErr(
				await remote.recordings.replace({ id }, '---\ntitle: X\n---\n', {
					over: entry.version,
				}),
			),
		).toMatchObject({ name: 'Conflict', current: repaired.version });
	}, 30_000);

	test("listeners hear this client's writes at once, another writer's within a poll, and polling stops with the last listener", async () => {
		const person = await signIn('notify');
		const remote = openRemote(recorder, { account: person.account });
		const other = openRemote(recorder, { account: person.account });
		const HEAD = /^GET .*\/epicenter\/head$/;
		let notes = 0;
		let audio = 0;
		const stopNotes = remote.recordings.subscribe(() => notes++);
		const stopAudio = remote.audio.subscribe(() => audio++);
		const id = timeId();
		const created = expectOk(
			await remote.recordings.create({ id, title: 'Mine' }),
		);
		expect([notes, audio]).toEqual([1, 0]);

		// Another writer moves main; a poll of main hears it.
		notes = 0;
		expectOk(
			await other.recordings.update(
				{ id },
				{ title: 'Theirs' },
				{ over: created.version },
			),
		);
		for (let turn = 0; turn < 100 && notes === 0; turn++) await Bun.sleep(50);
		expect(notes).toBeGreaterThan(0);
		expect(person.requests(HEAD).length).toBeGreaterThan(0);

		stopNotes();
		stopAudio();
		await Bun.sleep(100);
		const polls = person.requests(HEAD).length;
		await Bun.sleep(3500);
		expect(person.requests(HEAD).length).toBe(polls);
	}, 30_000);

	test('a retired account makes every call Unavailable, never a throw', async () => {
		const person = await signIn('retired-reads');
		const remote = openRemote(recorder, { account: person.account });
		person.retire();
		expect(expectErr(await remote.recordings.list()).name).toBe('Unavailable');
	}, 30_000);
});
