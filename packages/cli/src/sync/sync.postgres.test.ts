/**
 * The CLI's sync end to end (ADR-0804): the real authorization server and a
 * folder's routes on a disposable Postgres cluster behind a real listener,
 * repositories and attachments on disk, and fresh `epicenter` processes on
 * machines of their own, each signed in as its own person with the device
 * grant. No Git runs on a machine.
 *
 * Key behaviors:
 * - A folder's first sync makes its repository; `clone <folder>` brings its
 *   files, attachments byte for byte; both sides' edits merge by note
 * - `diff`, `log`, and `restore` read and bring back the server's history
 * - A grant lets another person clone and, with write, sync; a revoke
 *   refuses their next sync and leaves their files
 *
 * Requires initdb and pg_ctl on PATH; never connects to a configured
 * database.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timeId } from '@epicenter/definition/ids';
import { resolveOAuthAudiences } from '@epicenter/definition/site';
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
import { expectOk } from 'wellcrafted/testing';
import { startDisposablePostgres } from '../../../server/src/test-helpers/disposable-postgres.js';
import {
	OAuthTestClient,
	type Person,
} from '../../../server/src/test-helpers/oauth-client.js';
import {
	type AuthContext,
	accessToken,
	loginWithDevice,
	resolveDeployment,
} from '../auth.ts';
import { createMemorySecrets } from '../secrets.ts';

const secret = 'cli-sync-secret-0123456789abcdefghijklmn';
const bin = resolve(import.meta.dir, '..', 'bin.ts');
const scopes = [
	'openid',
	'offline_access',
	'profile',
	'ai',
	'folders:read',
	'folders:write',
];

let scratch: string;
let origin: string;
let stopPostgres: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let oauth: OAuthTestClient;
let app: ReturnType<typeof createServerApp<CloudEnv>>;

beforeAll(async () => {
	scratch = await realpath(await mkdtemp(join(tmpdir(), 'epicenter-sync-')));
	const cluster = await startDisposablePostgres();
	stopPostgres = cluster.stop;
	const sql = cluster.clients[0];
	const db = createDb(sql);
	await migrate(db, {
		migrationsFolder: fileURLToPath(
			new URL('../../../../apps/api/drizzle/', import.meta.url),
		),
	});
	app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => [origin],
		resolveAudiences: resolveOAuthAudiences,
	});
	server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch: (request) => app.fetch(request),
		idleTimeout: 30,
	});
	origin = `http://127.0.0.1:${server.port}`;
	const audiences = resolveOAuthAudiences(origin);
	await registerFirstPartyClients(db, {
		audiences,
		clients: [
			{
				clientId: 'so.epicenter.cli',
				name: 'Epicenter CLI',
				redirectUris: [],
				grantTypes: [
					'urn:ietf:params:oauth:grant-type:device_code',
					'refresh_token',
				],
				scopes: scopes as never,
				resources: [audiences.api, audiences.git],
				skipConsent: false,
				applicationType: 'native',
			},
		],
	});
	const context = {
		connect: async () => ({ db, close: async () => {} }),
		afterResponse: () => {},
		resolveAuthSecrets: () => ({ BETTER_AUTH_SECRET: secret }),
	};
	mountAuthRoutes(app, {
		setup: createCloudContextMiddleware({ ...context, oauthServer: true }),
		serveAuthUiShell: (c) => c.html('<html>shell</html>'),
	});
	const host = createDiskGitHost({ root: join(scratch, 'store') });
	const lfs = createDiskLfsStore({ root: join(scratch, 'lfs') });
	mountGitHost(app, {
		setup: createCloudContextMiddleware(context),
		resolveHost: () => host,
		resolveLfs: () => lfs,
	});
	oauth = new OAuthTestClient(origin, sql, secret, async (url, init) =>
		app.fetch(new Request(url, init)),
	);
}, 60_000);

afterAll(async () => {
	server?.stop(true);
	await stopPostgres?.();
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

type Run = { code: number; stdout: string; stderr: string };

/**
 * A person with a machine of their own: signed in with the device grant as
 * `epicenter auth login` does, its Git-audience token cached so no process
 * refreshes, and an `epicenter` that runs as them.
 */
async function machine(label: string) {
	const person: Person = await oauth.person(label);
	const home = join(scratch, label);
	await mkdir(home, { recursive: true });
	const secrets = createMemorySecrets();
	const ctx: AuthContext = {
		deployment: resolveDeployment(origin),
		secrets,
		lockDir: join(home, 'locks'),
		fetch: async (input, init) => app.fetch(new Request(input, init)),
		now: Date.now,
	};
	let approved = false;
	const codes: { userCode: string }[] = [];
	const login = await loginWithDevice(ctx, {
		onCode: (code) => codes.push(code),
		sleep: async () => {
			if (approved) return;
			approved = true;
			await oauth.approveDeviceCode({
				cookie: person.cookie,
				userCode: codes[0]?.userCode as string,
				clientId: 'so.epicenter.cli',
				target: '*',
			});
		},
	});
	expect(login.error).toBeNull();
	expectOk(await accessToken(ctx, 'device', ctx.deployment.audiences.git));
	const entry = `device ${ctx.deployment.origin}`;
	const stored = JSON.parse((await secrets.get(entry)) as string);
	const env = {
		PATH: process.env.PATH as string,
		HOME: home,
		EPICENTER_API_URL: origin,
		EPICENTER_DATA_DIR: join(home, 'data'),
		EPICENTER_TEST_SECRETS: JSON.stringify({ $auth: { [entry]: stored } }),
	};
	return {
		/** The person's handle: their personal namespace's id. */
		handle: person.personal,
		home,
		async epicenter(...args: string[]): Promise<Run> {
			const child = Bun.spawn(
				[process.execPath, '--no-install', bin, ...args],
				{
					env,
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
		},
	};
}

/** The folder id `.epicenter/synced.json` in `dir` records. */
async function folderIn(dir: string) {
	const manifest = JSON.parse(
		await readFile(join(dir, '.epicenter', 'synced.json'), 'utf8'),
	) as { folder: string };
	return manifest.folder;
}

const note = (title: string, body = '') => `---\ntitle: ${title}\n---\n${body}`;

test('a first sync makes the repository; clone brings it whole; both sides merge; diff, log, and restore read the history', async () => {
	const me = await machine('sync-me');
	const desk = join(me.home, 'notes');
	const laptop = join(me.home, 'laptop');
	const audio = crypto.getRandomValues(new Uint8Array(200_000));
	await mkdir(join(desk, 'notes'), { recursive: true });
	await writeFile(join(desk, 'notes/a.md'), note('A', 'one\ntwo\nthree\n'));
	await writeFile(join(desk, 'notes/a.webm'), audio);

	const first = await me.epicenter('sync', desk, '--json');
	expect(first.code, first.stdout + first.stderr).toBe(0);
	expect(JSON.parse(first.stdout).sync).toMatchObject({
		outcome: 'synced',
		pushed: ['notes/a.md', 'notes/a.webm'],
	});
	const folder = await folderIn(desk);
	expect((await me.epicenter('diff', desk)).stdout).toContain(
		'Nothing changed since the last sync.',
	);

	const cloned = await me.epicenter('clone', folder, laptop, '--json');
	expect(cloned.code, cloned.stdout + cloned.stderr).toBe(0);
	expect(new Uint8Array(await readFile(join(laptop, 'notes/a.webm')))).toEqual(
		audio,
	);
	expect(await folderIn(laptop)).toBe(folder);

	// Each side edits a different line; the later sync merges them.
	await writeFile(join(desk, 'notes/a.md'), note('A', 'ONE\ntwo\nthree\n'));
	await writeFile(join(laptop, 'notes/a.md'), note('A', 'one\ntwo\nTHREE\n'));
	await writeFile(join(laptop, 'notes/b.md'), note('B'));
	expect(
		JSON.parse((await me.epicenter('diff', laptop, '--json')).stdout),
	).toEqual({
		diff: [
			{ path: 'notes/a.md', change: 'changed' },
			{ path: 'notes/b.md', change: 'added' },
		],
	});
	expect((await me.epicenter('sync', desk)).code).toBe(0);
	const merged = await me.epicenter('sync', laptop, '--json');
	expect(JSON.parse(merged.stdout).sync).toMatchObject({
		merged: ['notes/a.md'],
	});
	expect((await me.epicenter('sync', desk)).code).toBe(0);
	const both = note('A', 'ONE\ntwo\nTHREE\n');
	expect(await readFile(join(desk, 'notes/a.md'), 'utf8')).toBe(both);
	expect(await readFile(join(desk, 'notes/b.md'), 'utf8')).toBe(note('B'));

	// The history: newest first, and what changed since the first commit.
	const log = JSON.parse(
		(await me.epicenter('log', desk, '--json')).stdout,
	) as {
		log: { id: string; message: string }[];
	};
	expect(log.log.length).toBeGreaterThanOrEqual(3);
	const oldest = log.log.at(-1)?.id as string;
	expect(
		JSON.parse(
			(await me.epicenter('diff', desk, '--since', oldest, '--json')).stdout,
		),
	).toEqual({
		diff: [
			{ path: 'notes/a.md', change: 'changed' },
			{ path: 'notes/b.md', change: 'added' },
		],
	});

	// Restore the first commit here, and sync it as a new change.
	const restored = await me.epicenter('restore', oldest, desk, '--json');
	expect(restored.code, restored.stderr).toBe(0);
	expect(JSON.parse(restored.stdout).restored).toMatchObject({
		written: ['notes/a.md'],
		removed: ['notes/b.md'],
	});
	expect(await readFile(join(desk, 'notes/a.md'), 'utf8')).toBe(
		note('A', 'one\ntwo\nthree\n'),
	);
	expect((await me.epicenter('sync', desk)).code).toBe(0);
	expect((await me.epicenter('sync', laptop)).code).toBe(0);
	expect(await readFile(join(laptop, 'notes/a.md'), 'utf8')).toBe(
		note('A', 'one\ntwo\nthree\n'),
	);
	// The repository lists it by its folder id.
	expect((await me.epicenter('repos')).stdout).toContain(`(folder ${folder})`);
}, 120_000);

test('a grant lets another person clone and, with write, sync; a revoke refuses their next sync', async () => {
	const alice = await machine('alice');
	const bob = await machine('bob');

	// Alice keeps a recording in a folder; her first sync makes the repository.
	const mine = join(alice.home, 'recorder');
	const id = timeId();
	const audio = crypto.getRandomValues(new Uint8Array(300_000));
	await mkdir(join(mine, 'recordings'), { recursive: true });
	await writeFile(join(mine, 'recordings', `${id}.md`), note('Kitchen'));
	await writeFile(join(mine, 'recordings', `${id}.m4a`), audio);
	expect((await alice.epicenter('sync', mine)).code).toBe(0);
	const folder = await folderIn(mine);
	const aliceNote = join(mine, 'recordings', `${id}.md`);

	// Before a grant, Bob reaches nothing of hers.
	const copy = join(bob.home, 'recorder');
	const stranger = await bob.epicenter('clone', folder, copy, '--json');
	expect(stranger.code).toBe(2);
	expect(stranger.stdout).toContain('403');

	// Read: Bob clones the same bytes, and may change nothing.
	const shared = await alice.epicenter(
		'share',
		mine,
		bob.handle,
		'--read',
		'--json',
	);
	expect(shared.stderr).toBe('');
	expect(JSON.parse(shared.stdout)).toEqual({
		person: bob.handle,
		level: 'read',
	});
	expect(
		JSON.parse((await alice.epicenter('share', mine, '--json')).stdout),
	).toEqual({
		grants: [{ person: bob.handle, level: 'read' }],
	});
	const cloned = await bob.epicenter('clone', folder, copy);
	expect(cloned.code, cloned.stdout + cloned.stderr).toBe(0);
	expect(
		new Uint8Array(await readFile(join(copy, 'recordings', `${id}.m4a`))),
	).toEqual(audio);
	const notePath = join(copy, 'recordings', `${id}.md`);
	await writeFile(notePath, note('Kitchen, by Bob'));
	const refused = await bob.epicenter('sync', copy, '--json');
	expect(refused.code).toBe(2);
	expect(refused.stdout).toContain('403');
	expect((await alice.epicenter('sync', mine)).code).toBe(0);
	expect(await readFile(aliceNote, 'utf8')).toBe(note('Kitchen'));

	// Write: Bob's edit lands on his next sync, and Alice syncs it down.
	expect(
		(await alice.epicenter('share', mine, bob.handle, '--write')).code,
	).toBe(0);
	expect((await bob.epicenter('sync', copy)).code).toBe(0);
	expect((await alice.epicenter('sync', mine)).code).toBe(0);
	expect(await readFile(aliceNote, 'utf8')).toBe(note('Kitchen, by Bob'));

	// Revoke: Bob's next sync is refused, and what he has stays.
	const revoked = await alice.epicenter('unshare', mine, bob.handle, '--json');
	expect(JSON.parse(revoked.stdout)).toEqual({
		person: bob.handle,
		revoked: true,
	});
	await writeFile(notePath, note('Kitchen, again'));
	const after = await bob.epicenter('sync', copy, '--json');
	expect(after.code).toBe(2);
	expect(after.stdout).toContain('403');
	expect(
		new Uint8Array(await readFile(join(copy, 'recordings', `${id}.m4a`))),
	).toEqual(audio);
}, 240_000);
