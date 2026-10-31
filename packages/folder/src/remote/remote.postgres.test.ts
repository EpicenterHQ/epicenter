/**
 * Remote Client and Upload Tests
 *
 * `openRemote` and `startUploading` against the real server app: the
 * authorization server on a disposable Postgres, a `Bun.serve` listener, the
 * disk Git and LFS stores, and an access token from a real code grant. The
 * account is a stand-in for `@epicenter/auth`'s: it carries the token, can
 * be retired, records every request, and can lose a request or its reply,
 * which is how a crash or a dropped connection looks from here. A miss here
 * is a capture uploaded twice, lost, or deleted from the device before the
 * server has it, or a write landing over a version its writer never read.
 *
 * Key behaviors:
 * - A note plus its audio go up as one capture, and the device lets go of them
 * - A resend after a lost reply is the same write again: no new commit, or one conflict block after an edit
 * - A crash after the PUT, after the write, or before the delete resumes without loss
 * - The remote client refuses a stale version (`Conflict`) and an occupied path (`Occupied`)
 * - A capture naming a path outside the contract stays on the device and is never sent
 * - Files no capture names are adopted and uploaded, once quiet for `QUIET_MS`; a capture goes up at once
 * - Retiring the account stops uploading for good
 * - A note that does not read on main is listed with its text, and `replace` repairs it
 * - Listeners hear this client's writes at once and other writers' within a poll of `main`
 *
 * Requires initdb and pg_ctl on PATH; never connects to a configured database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
import { createLogger, memorySink } from 'wellcrafted/logger';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { startDisposablePostgres } from '../../../server/src/test-helpers/disposable-postgres.js';
import { OAuthTestClient } from '../../../server/src/test-helpers/oauth-client.js';
import { cacheOf, openDevice, outboxOf, saveCapture } from '../node.js';
import { openRemote, QUIET_MS, startUploading } from '../remote.js';

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
 * `lose` makes the next request matching `pattern` fail: `'request'` before
 * it is sent, `'reply'` after the server answered; `then` runs as it fails,
 * which is where a test closes the page. `meanwhile` runs `then` once the
 * server has answered the next such request, before its reply arrives:
 * what a person does while a write is in flight.
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
	const faults: {
		pattern: RegExp;
		lose: 'request' | 'reply' | null;
		then?: () => void | Promise<void>;
	}[] = [];
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
			const index = faults.findIndex(({ pattern }) =>
				pattern.test(`${method} ${url}`),
			);
			const fault = index === -1 ? undefined : faults.splice(index, 1)[0];
			if (fault?.lose === 'request') {
				fault.then?.();
				throw new TypeError('Failed to fetch');
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
			if (fault?.lose === null) await fault.then?.();
			if (fault?.lose === 'reply') {
				fault.then?.();
				throw new TypeError('Failed to fetch');
			}
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
		lose(pattern: RegExp, lose: 'request' | 'reply', then?: () => void) {
			faults.push({ pattern, lose, then });
		},
		meanwhile(pattern: RegExp, then: () => Promise<void>) {
			faults.push({ pattern, lose: null, then });
		},
		retire: () => lifetime.abort(new Error('signed out')),
	};
}

const WRITES = /^POST .*\/epicenter\/writes$/;
const PUTS = /^PUT .*\/info\/lfs\/objects\//;

async function deviceAt(path?: string) {
	const root = path ?? (await mkdtemp(join(scratch, 'device-')));
	return { root, device: openDevice(recorder, { path: root }) };
}

/** Record a note and its audio on `device` as one capture, as the demo app does. */
async function capture(
	device: ReturnType<typeof openDevice<typeof recorder>>,
	title: string,
	bytes = crypto.getRandomValues(new Uint8Array(200_000)),
) {
	const id = timeId();
	expectOk(
		await saveCapture(device, {
			id,
			files: [
				{ collection: 'recordings', value: { id, title } },
				{ collection: 'audio', value: { id, ext: 'm4a', bytes } },
			],
		}),
	);
	return { id, bytes };
}

/** Where the device caches the audio of capture `id` once it is uploaded. */
const cachedAudio = (id: string) => `.epicenter/cache/recordings/${id}.m4a`;

/** Every file left in a device folder, hidden ones included. */
async function filesIn(root: string) {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
		.sort();
}

describe('upload', () => {
	test('a note plus its audio go up as one capture, and the device lets go of them', async () => {
		const person = await signIn('upload');
		const { root, device } = await deviceAt();
		const remote = openRemote(recorder, { account: person.account });
		const { id, bytes } = await capture(device, 'Standup');

		using uploader = startUploading(device, remote);
		const report = await uploader.drain();

		expect(report).toMatchObject({ uploaded: [id], interrupted: null });
		expect(person.requests(WRITES)).toHaveLength(1);
		// Only the audio stays, as a cache: the note is the repository's.
		expect(await filesIn(root)).toEqual([cachedAudio(id)]);
		const note = expectOk(await remote.recordings.get({ id }));
		expect(note).toMatchObject({ id, title: 'Standup', body: '' });
		expect(note.version).toMatch(/^[0-9a-f]{40}$/);
		const audio = expectOk(await remote.audio.get({ id, ext: 'm4a' }));
		expect(audio.bytes).toEqual(bytes);
		expect(expectOk(await remote.audio.list()).items).toEqual([
			{ id, ext: 'm4a', version: audio.version },
		]);
		// The cache answers for the repository's version, offline too.
		const cache = cacheOf(device);
		expect(expectOk(await cache.list()).items).toEqual([
			{ collection: 'audio', id, ext: 'm4a' },
		]);
		const hit = expectOk(
			await cache.read(
				{ collection: 'audio', id, ext: 'm4a' },
				{ version: audio.version },
			),
		);
		expect(hit?.bytes).toEqual(bytes);
	}, 30_000);

	test('a plain resend after a lost reply lands as nothing: same commit, no new one', async () => {
		const person = await signIn('lost-reply');
		const { root, device } = await deviceAt();
		const { id } = await capture(device, 'Lost reply');
		person.lose(WRITES, 'reply');

		using uploader = startUploading(
			device,
			openRemote(recorder, { account: person.account }),
		);
		// The first run loses the reply; the run asked for here resends.
		const report = await uploader.drain();

		expect(report).toMatchObject({ uploaded: [id], interrupted: null });
		const [lost, resent] = person.requests(WRITES).map(({ body }) => body);
		expect(resent).toMatchObject({
			commit: (lost as { commit: string }).commit,
			outcomes: [{ outcome: 'unchanged' }, { outcome: 'unchanged' }],
		});
		expect(person.requests(WRITES)).toHaveLength(2);
		expect(await filesIn(root)).toEqual([cachedAudio(id)]);
	}, 30_000);

	test('a crash after the write keeps everything on the device, and the next page sends it again', async () => {
		const person = await signIn('after-write');
		const { root, device } = await deviceAt();
		const { id, bytes } = await capture(device, 'After the write');
		const crashed = startUploading(
			device,
			openRemote(recorder, { account: person.account }),
		);
		person.lose(WRITES, 'reply', () => crashed[Symbol.dispose]());
		expect((await crashed.drain()).interrupted?.name).toBe('Unavailable');
		// The server committed, but the device never heard: it keeps everything.
		expect(await filesIn(root)).toHaveLength(3);
		expect(expectOk(await outboxOf(device).list()).items[0]?.state).toBe(
			'pending',
		);

		const reopened = await deviceAt(root);
		const remote = openRemote(recorder, { account: person.account });
		using uploader = startUploading(reopened.device, remote);
		expect(await uploader.drain()).toMatchObject({ uploaded: [id] });
		const writes = person.requests(WRITES);
		expect(writes).toHaveLength(2);
		expect(writes[1]?.body).toMatchObject({
			commit: (writes[0]?.body as { commit: string }).commit,
			outcomes: [{ outcome: 'unchanged' }, { outcome: 'unchanged' }],
		});
		expect(await filesIn(root)).toEqual([cachedAudio(id)]);
		expect(expectOk(await remote.audio.get({ id, ext: 'm4a' })).bytes).toEqual(
			bytes,
		);
	}, 30_000);

	test('a lost reply, an edit, then a resend: one conflict block on the server, nothing lost', async () => {
		const person = await signIn('edit-after-lost-reply');
		const { root, device } = await deviceAt();
		const { id, bytes } = await capture(device, 'Before');
		const crashed = startUploading(
			device,
			openRemote(recorder, { account: person.account }),
		);
		person.lose(WRITES, 'reply', () => crashed[Symbol.dispose]());
		await crashed.drain();

		// Still pending on the device, the note is edited before the resend.
		const held = expectOk(await device.recordings.get({ id }));
		expectOk(
			await device.recordings.update(
				{ id },
				{ title: 'After' },
				{ over: held.version },
			),
		);

		const remote = openRemote(recorder, { account: person.account });
		using uploader = startUploading(device, remote);
		const resent = await uploader.drain();

		expect(resent).toMatchObject({
			uploaded: [id],
			refused: [],
			interrupted: null,
		});
		const writes = person.requests(WRITES);
		expect(writes).toHaveLength(2);
		// The resend is the same create with the edited note: two creates of
		// one path, so the note keeps what landed first and gains the edit as
		// one block; the audio is the same bytes and lands as nothing.
		expect(writes[1]?.body).toMatchObject({
			outcomes: [
				{ path: `recordings/${id}.md`, outcome: 'conflict' },
				{ path: `recordings/${id}.m4a`, outcome: 'unchanged' },
			],
		});
		const note = expectOk(await remote.recordings.get({ id }));
		expect(note.title).toBe('Before');
		expect(note.body.match(/^<<<<<<< /gm)).toHaveLength(1);
		expect(note.body).toContain('title: After');
		expect(expectOk(await remote.audio.get({ id, ext: 'm4a' })).bytes).toEqual(
			bytes,
		);
		// The device let go only of what the reply showed landed: everything.
		expect(await filesIn(root)).toEqual([cachedAudio(id)]);
	}, 30_000);

	test('a crash after the PUT resumes without uploading the bytes again', async () => {
		const person = await signIn('after-put');
		const { root, device } = await deviceAt();
		const { id } = await capture(device, 'After the PUT');
		const crashed = startUploading(
			device,
			openRemote(recorder, { account: person.account }),
		);
		person.lose(WRITES, 'request', () => crashed[Symbol.dispose]());
		expect((await crashed.drain()).interrupted?.name).toBe('Unavailable');
		expect(person.requests(PUTS)).toHaveLength(1);
		expect(person.requests(WRITES)).toHaveLength(0);

		// A new page: a new device client over the same files, a new remote.
		const reopened = await deviceAt(root);
		using uploader = startUploading(
			reopened.device,
			openRemote(recorder, { account: person.account }),
		);
		expect(await uploader.drain()).toMatchObject({ uploaded: [id] });
		expect(person.requests(PUTS)).toHaveLength(1);
		expect(person.requests(WRITES)).toHaveLength(1);
		expect(await filesIn(root)).toEqual([cachedAudio(id)]);
	}, 30_000);

	test('a crash before the delete finishes on the next page, without writing again', async () => {
		const person = await signIn('before-delete');
		const { root, device } = await deviceAt();
		const { id } = await capture(device, 'Before the delete');
		const outbox = outboxOf(device);
		const finish = outbox.finish;
		const crashed = startUploading(
			device,
			openRemote(recorder, { account: person.account }),
		);
		// The page dies between recording the receipt and deleting the files.
		outbox.finish = async () => {
			crashed[Symbol.dispose]();
			return {
				data: null,
				error: {
					name: 'Unavailable',
					message: 'The page closed',
					cause: 'crash',
				},
			};
		};
		await crashed.drain();
		outbox.finish = finish;
		const [left] = expectOk(await outbox.list()).items;
		expect(left).toMatchObject({ id, state: 'acknowledged' });
		expect(await filesIn(root)).toHaveLength(3);

		const reopened = await deviceAt(root);
		using uploader = startUploading(
			reopened.device,
			openRemote(recorder, { account: person.account }),
		);
		expect(await uploader.drain()).toMatchObject({ uploaded: [id] });
		expect(person.requests(WRITES)).toHaveLength(1);
		expect(await filesIn(root)).toEqual([cachedAudio(id)]);
	}, 30_000);

	test('a note deleted on the device while its write is in flight is deleted on the server too', async () => {
		const person = await signIn('deleted-in-flight');
		const { root, device } = await deviceAt();
		const remote = openRemote(recorder, { account: person.account });
		const id = timeId();
		const note = expectOk(
			await device.recordings.create({ id, title: 'Gone' }),
		);
		expectOk(
			await outboxOf(device).add({
				id,
				files: [{ collection: 'recordings', ...note }],
			}),
		);
		person.meanwhile(WRITES, async () => {
			expectOk(await device.recordings.delete({ id }, { over: note.version }));
		});

		using uploader = startUploading(device, remote);
		const report = await uploader.drain();

		expect(report.interrupted).toBeNull();
		expect(person.requests(WRITES)).toHaveLength(2);
		expect(expectErr(await remote.recordings.get({ id })).name).toBe(
			'NotFound',
		);
		expect(await filesIn(root)).toEqual([]);
	}, 30_000);

	test('files no capture names are adopted and uploaded', async () => {
		const person = await signIn('adopt');
		const { root, device } = await deviceAt();
		// A crash between `create` and the outbox's `add`.
		const id = timeId();
		expectOk(await device.recordings.create({ id, title: 'Orphan' }));
		const remote = openRemote(recorder, { account: person.account });

		using uploader = startUploading(device, remote);
		const report = await uploader.drain();

		expect(report.uploaded).toHaveLength(1);
		expect(await filesIn(root)).toEqual([]);
		expect(expectOk(await remote.recordings.get({ id })).title).toBe('Orphan');
	}, 30_000);

	test('a device file edited in a burst goes up once, after it has been quiet', async () => {
		const person = await signIn('quiet-burst');
		const { root, device } = await deviceAt();
		const remote = openRemote(recorder, { account: person.account });
		using uploader = startUploading(device, remote);
		await uploader.drain();

		// Typed into an app's view of this device: a create, then edits.
		const id = timeId();
		let { version } = expectOk(
			await device.recordings.create({ id, title: 'Draft 0' }),
		);
		for (let i = 1; i <= 4; i++) {
			await Bun.sleep(300);
			({ version } = expectOk(
				await device.recordings.update(
					{ id },
					{ title: `Draft ${i}` },
					{ over: version },
				),
			));
		}
		const lastEdit = Date.now();
		// A run asked for meanwhile leaves the file being typed in alone.
		await uploader.drain();
		expect(person.requests(WRITES)).toHaveLength(0);

		const deadline = lastEdit + QUIET_MS + 10_000;
		while (
			Date.now() < deadline &&
			(await filesIn(root)).some((path) => !path.startsWith('.'))
		)
			await Bun.sleep(100);

		expect(Date.now() - lastEdit).toBeGreaterThanOrEqual(QUIET_MS);
		expect(person.requests(WRITES)).toHaveLength(1);
		expect(await filesIn(root)).toEqual([]);
		expect(expectOk(await remote.recordings.get({ id })).title).toBe('Draft 4');
	}, 30_000);

	test('a capture goes up at once and whole, while a file being typed in waits to be quiet', async () => {
		const person = await signIn('quiet-capture');
		const { root, device } = await deviceAt();
		const remote = openRemote(recorder, { account: person.account });
		using uploader = startUploading(device, remote);
		await uploader.drain();

		const typing = timeId();
		expectOk(await device.recordings.create({ id: typing, title: 'Typing' }));
		const started = Date.now();
		const whole = await capture(device, 'Saved at Stop');
		const sent = (id: string) =>
			person
				.requests(WRITES)
				.filter(({ body }) => JSON.stringify(body).includes(id));
		while (Date.now() - started < 3_000 && sent(whole.id).length === 0)
			await Bun.sleep(50);

		// The capture's note and audio landed in one write, well inside the quiet period.
		expect(sent(whole.id)).toHaveLength(1);
		expect(Date.now() - started).toBeLessThan(QUIET_MS);
		expect(sent(typing)).toHaveLength(0);

		const deadline = started + QUIET_MS + 10_000;
		while (
			Date.now() < deadline &&
			(await filesIn(root)).some((path) => !path.startsWith('.'))
		)
			await Bun.sleep(100);
		expect(await filesIn(root)).toEqual([cachedAudio(whole.id)]);
		expect(expectOk(await remote.recordings.get({ id: typing })).title).toBe(
			'Typing',
		);
		expect(sent(whole.id)).toHaveLength(1);
	}, 30_000);

	test('a capture naming a path outside the contract stays on the device and is never sent', async () => {
		const person = await signIn('outside');
		const { root, device } = await deviceAt();
		await mkdir(join(root, 'notes'), { recursive: true });
		await writeFile(join(root, 'notes/evil.md'), '---\ntitle: x\n---\n');
		await mkdir(join(root, '.epicenter/outbox'), { recursive: true });
		await writeFile(
			join(root, '.epicenter/outbox/outside.json'),
			JSON.stringify({
				id: 'outside',
				paths: { 'notes/evil.md': 'a'.repeat(64) },
				bases: {},
				state: 'pending',
				receipt: null,
			}),
		);

		using uploader = startUploading(
			device,
			openRemote(recorder, { account: person.account }),
		);
		const report = await uploader.drain();

		expect(report.refused).toMatchObject([
			{ name: 'OutsideContract', id: 'outside', path: 'notes/evil.md' },
		]);
		expect(person.requests(WRITES)).toHaveLength(0);
		expect(await filesIn(root)).toEqual([
			'.epicenter/outbox/outside.json',
			'notes/evil.md',
		]);
	}, 30_000);

	test('each capture is written once however many runs are asked for, and a new capture starts one', async () => {
		const person = await signIn('single-flight');
		const { root, device } = await deviceAt();
		const one = await capture(device, 'One');
		using uploader = startUploading(
			device,
			openRemote(recorder, { account: person.account }),
		);
		await Promise.all([uploader.drain(), uploader.drain(), uploader.drain()]);
		expect(person.requests(WRITES)).toHaveLength(1);

		// No drain is asked for: the capture itself starts a run.
		const two = await capture(device, 'Two');
		for (let i = 0; i < 100 && person.requests(WRITES).length < 2; i++)
			await Bun.sleep(50);
		await uploader.drain();
		expect(person.requests(WRITES)).toHaveLength(2);
		expect(await filesIn(root)).toEqual(
			[cachedAudio(one.id), cachedAudio(two.id)].sort(),
		);
	}, 30_000);

	test('retiring the account stops uploading for good', async () => {
		const person = await signIn('retire');
		const { root, device } = await deviceAt();
		const { sink, events } = memorySink();
		using uploader = startUploading(
			device,
			openRemote(recorder, { account: person.account }),
			{ log: createLogger('upload', sink) },
		);
		const { id } = await capture(device, 'Before sign-out');
		await uploader.drain();
		expect(await filesIn(root)).toEqual([cachedAudio(id)]);
		const before = person.sent.length;

		person.retire();
		// A capture after sign-out starts no run, and an asked-for one does nothing.
		await capture(device, 'After sign-out');
		const report = await uploader.drain();

		expect(report.uploaded).toEqual([]);
		expect(report.interrupted?.name).toBe('Unavailable');
		expect(person.sent).toHaveLength(before);
		expect(events).toEqual([]);
		// The capture waits on the device for the next person to sign in, and
		// what the retired account's uploads cached is gone.
		const cachedNow = async () =>
			(await filesIn(root)).some((path) =>
				path.startsWith('.epicenter/cache/'),
			);
		for (let i = 0; i < 40 && (await cachedNow()); i++) await Bun.sleep(25);
		const left = await filesIn(root);
		expect(left).toHaveLength(3);
		expect(left.some((path) => path.startsWith('.epicenter/cache/'))).toBe(
			false,
		);
	}, 30_000);
});

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
