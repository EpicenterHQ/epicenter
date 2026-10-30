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
 * - A resend after a lost reply recovers the first receipt instead of writing again
 * - A crash after the PUT, after the write, or before the delete resumes without loss
 * - The remote client refuses a stale version (`Conflict`) and an occupied path (`Occupied`)
 * - A capture naming a path outside the contract stays on the device and is never sent
 * - Files no capture names are adopted and uploaded
 * - Retiring the account stops uploading for good
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
import { openDevice, outboxOf } from '../node.js';
import { openRemote, startUploading } from '../remote.js';

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
 * which is where a test closes the page.
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
		lose: 'request' | 'reply';
		then?: () => void;
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
		sent,
		/** The requests whose `METHOD url` matches `pattern`. */
		requests: (pattern: RegExp) =>
			sent.filter(({ method, url }) => pattern.test(`${method} ${url}`)),
		lose(pattern: RegExp, lose: 'request' | 'reply', then?: () => void) {
			faults.push({ pattern, lose, then });
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
	const note = expectOk(await device.recordings.create({ id, title }));
	const audio = expectOk(await device.audio.create({ id, ext: 'm4a', bytes }));
	expectOk(
		await outboxOf(device).add({
			id,
			files: [
				{ collection: 'recordings', ...note },
				{ collection: 'audio', ...audio },
			],
		}),
	);
	return { id, bytes };
}

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
		expect(await filesIn(root)).toEqual([]);
		const note = expectOk(await remote.recordings.get({ id }));
		expect(note).toMatchObject({ id, title: 'Standup', body: '' });
		expect(note.version).toMatch(/^[0-9a-f]{40}$/);
		const audio = expectOk(await remote.audio.get({ id, ext: 'm4a' }));
		expect(audio.bytes).toEqual(bytes);
		expect(expectOk(await remote.audio.list()).items).toEqual([
			{ id, ext: 'm4a', version: audio.version },
		]);
	}, 30_000);

	test('a resend after a lost reply recovers the first receipt instead of writing again', async () => {
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
			replayed: true,
		});
		expect(person.requests(WRITES)).toHaveLength(2);
		expect(await filesIn(root)).toEqual([]);
	}, 30_000);

	test('a crash after the write keeps everything on the device, and the next page recovers the receipt', async () => {
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
		expect(writes[1]?.body).toMatchObject({ replayed: true });
		expect(await filesIn(root)).toEqual([]);
		expect(expectOk(await remote.audio.get({ id, ext: 'm4a' })).bytes).toEqual(
			bytes,
		);
	}, 30_000);

	test('an edit made after a lost reply is never dropped: it goes up as an update over what landed', async () => {
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

		expect(resent.interrupted).toBeNull();
		const [lost, replay, update] = person.requests(WRITES);
		expect(replay?.body).toMatchObject({
			commit: (lost?.body as { commit: string }).commit,
			replayed: true,
		});
		// The kept edit went up under an id of its own, over the blob that landed.
		expect(update?.body).toMatchObject({
			outcomes: [{ path: `recordings/${id}.md`, outcome: 'written' }],
		});
		expect(expectOk(await remote.recordings.get({ id })).title).toBe('After');
		expect(expectOk(await remote.audio.get({ id, ext: 'm4a' })).bytes).toEqual(
			bytes,
		);
		expect(await filesIn(root)).toEqual([]);
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
		expect(await filesIn(root)).toEqual([]);
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
		await capture(device, 'One');
		using uploader = startUploading(
			device,
			openRemote(recorder, { account: person.account }),
		);
		await Promise.all([uploader.drain(), uploader.drain(), uploader.drain()]);
		expect(person.requests(WRITES)).toHaveLength(1);

		// No drain is asked for: the capture itself starts a run.
		await capture(device, 'Two');
		for (let i = 0; i < 100 && person.requests(WRITES).length < 2; i++)
			await Bun.sleep(50);
		await uploader.drain();
		expect(person.requests(WRITES)).toHaveLength(2);
		expect(await filesIn(root)).toEqual([]);
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
		await uploader.drain();
		const before = person.sent.length;

		person.retire();
		// A capture after sign-out starts no run, and an asked-for one does nothing.
		await capture(device, 'After sign-out');
		const report = await uploader.drain();

		expect(report.uploaded).toEqual([]);
		expect(report.interrupted?.name).toBe('Unavailable');
		expect(person.sent).toHaveLength(before);
		expect(events).toEqual([]);
		// The capture waits on the device for the next person to sign in.
		expect(await filesIn(root)).toHaveLength(3);
	}, 30_000);
});

describe('the remote client', () => {
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

	test('a retired account makes every call Unavailable, never a throw', async () => {
		const person = await signIn('retired-reads');
		const remote = openRemote(recorder, { account: person.account });
		person.retire();
		expect(expectErr(await remote.recordings.list()).name).toBe('Unavailable');
	}, 30_000);
});
