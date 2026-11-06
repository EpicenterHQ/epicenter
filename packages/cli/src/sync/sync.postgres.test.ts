/**
 * The CLI's sync end to end (ADR-0804): the real authorization server and a
 * folder's routes on a disposable Postgres cluster behind a real listener,
 * larger bytes on disk, and fresh `epicenter` processes on
 * machines of their own, each signed in as its own person with the device
 * grant. No Git runs on a machine.
 *
 * Key behaviors:
 * - A folder's first sync makes it on the server; `clone <folder>` brings
 *   its files, attachments byte for byte; both sides' edits merge by note
 * - `diff`, `log`, and `restore` read and bring back the server's history
 * - `share` waits for `accept`, which lands the folder in the other
 *   person's Epicenter folder; a reader cannot write; `unshare` refuses
 *   their next sync and leaves their files
 * - `init` proposes a contract, `status` lists each folder's state, and a
 *   copy asks which folder it is, answered by `--join` or `--create`; a first
 *   sync on another computer joins the folder held by name; many deletions
 *   wait for `--push-deletions` or `--restore-deletions`
 *
 * Requires initdb and pg_ctl on PATH; never connects to a configured
 * database.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
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
	createDiskBlobStore,
	createServerApp,
	mountAuthRoutes,
	mountFolders,
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
	'folders:all',
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
	const blobs = createDiskBlobStore({ root: join(scratch, 'blobs') });
	mountFolders(app, {
		setup: createCloudContextMiddleware(context),
		resolveBlobs: () => blobs,
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
 * A computer of a person (a new one, or `of`'s): signed in with the device
 * grant as `epicenter auth login` does, its Git-audience token cached so no
 * process refreshes, and an `epicenter` that runs as them. Its Epicenter
 * folder is `<home>/Epicenter`.
 */
async function machine(label: string, of?: { person: Person }) {
	const person: Person = of?.person ?? (await oauth.person(label));
	const home = join(scratch, label);
	await mkdir(join(home, 'Epicenter'), { recursive: true });
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
			});
		},
	});
	expect(login.error).toBeNull();
	expectOk(await accessToken(ctx, ctx.deployment.audiences.git));
	const entry = `device ${ctx.deployment.origin}`;
	const stored = JSON.parse((await secrets.get(entry)) as string);
	const env = {
		PATH: process.env.PATH as string,
		HOME: home,
		EPICENTER_API_URL: origin,
		EPICENTER_DATA_DIR: join(home, 'data'),
		EPICENTER_TEST_SECRETS: JSON.stringify({ $auth: { [entry]: stored } }),
	};
	const epicenterFolder = join(home, 'Epicenter');
	return {
		person,
		/** The email the person signs in with, which others share with. */
		email: person.email,
		home,
		/** The folder `name` in its Epicenter folder. */
		at: (name: string) => join(epicenterFolder, name),
		/** The folder id this computer's record of the folder `name` names. */
		async folderOf(name: string) {
			const records = join(epicenterFolder, '.epicenter', 'synced');
			for (const file of await readdir(records)) {
				const record = JSON.parse(
					await readFile(join(records, file), 'utf8'),
				) as { folder: string; name: string };
				if (record.name === name) return record.folder;
			}
			return null;
		},
		async epicenter(...args: string[]): Promise<Run> {
			const child = Bun.spawn(
				[process.execPath, '--no-install', bin, ...args],
				{
					env,
					cwd: home,
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

const note = (title: string, body = '') => `---\ntitle: ${title}\n---\n${body}`;

test('a first sync makes the repository; clone brings it whole to another computer; both sides merge; diff, log, and restore read the history', async () => {
	const me = await machine('sync-me');
	const other = await machine('sync-me-laptop', me);
	const desk = me.at('notes');
	const audio = crypto.getRandomValues(new Uint8Array(200_000));
	await mkdir(join(desk, 'notes'), { recursive: true });
	await writeFile(join(desk, 'notes/a.md'), note('A', 'one\ntwo\nthree\n'));
	await writeFile(join(desk, 'notes/a.webm'), audio);

	const first = await me.epicenter('sync', desk, '--json');
	expect(first.code, first.stdout + first.stderr).toBe(0);
	expect(JSON.parse(first.stdout).sync).toMatchObject({
		outcome: 'synced',
		made: true,
		pushed: ['epicenter.json', 'notes/a.md', 'notes/a.webm'],
	});
	const folder = (await me.folderOf('notes')) as string;
	// The folder holds only its files; the record is at the Epicenter folder's root.
	expect((await readdir(desk)).sort()).toEqual(['epicenter.json', 'notes']);
	expect((await me.epicenter('diff', desk)).stdout).toContain(
		'Nothing changed since the last sync.',
	);

	const cloned = await other.epicenter('clone', folder, 'Laptop', '--json');
	expect(cloned.code, cloned.stdout + cloned.stderr).toBe(0);
	const laptop = other.at('Laptop');
	expect(new Uint8Array(await readFile(join(laptop, 'notes/a.webm')))).toEqual(
		audio,
	);
	expect(await other.folderOf('Laptop')).toBe(folder);

	// Each side edits a different line; the later sync merges them.
	await writeFile(join(desk, 'notes/a.md'), note('A', 'ONE\ntwo\nthree\n'));
	await writeFile(join(laptop, 'notes/a.md'), note('A', 'one\ntwo\nTHREE\n'));
	await writeFile(join(laptop, 'notes/b.md'), note('B'));
	expect(
		JSON.parse((await other.epicenter('diff', laptop, '--json')).stdout),
	).toEqual({
		diff: [
			{ path: 'notes/a.md', change: 'changed' },
			{ path: 'notes/b.md', change: 'added' },
		],
	});
	expect((await me.epicenter('sync', desk)).code).toBe(0);
	const merged = await other.epicenter('sync', 'Laptop', '--json');
	expect(JSON.parse(merged.stdout).sync).toMatchObject({
		merged: ['notes/a.md'],
	});
	expect((await me.epicenter('sync', 'notes')).code).toBe(0);
	const both = note('A', 'ONE\ntwo\nTHREE\n');
	expect(await readFile(join(desk, 'notes/a.md'), 'utf8')).toBe(both);
	expect(await readFile(join(desk, 'notes/b.md'), 'utf8')).toBe(note('B'));

	// The history: newest first, and what changed since the first change.
	const log = JSON.parse(
		(await me.epicenter('log', desk, '--json')).stdout,
	) as {
		log: { seq: number }[];
	};
	expect(log.log.length).toBeGreaterThanOrEqual(3);
	const oldest = String(log.log.at(-1)?.seq);
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

	// Restore the first change on the server, as a new change, and sync it here.
	const restored = await me.epicenter('restore', oldest, desk, '--json');
	expect(restored.code, restored.stderr).toBe(0);
	expect(JSON.parse(restored.stdout).restored).toMatchObject({
		written: ['notes/a.md'],
		removed: ['notes/b.md'],
	});
	expect((await me.epicenter('sync', desk)).code).toBe(0);
	expect(await readFile(join(desk, 'notes/a.md'), 'utf8')).toBe(
		note('A', 'one\ntwo\nthree\n'),
	);
	expect((await other.epicenter('sync', laptop)).code).toBe(0);
	expect(await readFile(join(laptop, 'notes/a.md'), 'utf8')).toBe(
		note('A', 'one\ntwo\nthree\n'),
	);
	// The person's folders list it by its id.
	const listed = JSON.parse((await me.epicenter('clone', '--json')).stdout) as {
		folders: { id: string }[];
	};
	expect(listed.folders.map(({ id }) => id)).toEqual([folder]);
}, 120_000);

test('share waits for accept, which lands the folder in the other Epicenter folder; a reader cannot write; unshare refuses the next sync', async () => {
	const alice = await machine('alice');
	const bob = await machine('bob');

	// Alice keeps a recording in a folder; her first sync makes it on the server.
	const mine = alice.at('Recorder');
	const id = timeId();
	const audio = crypto.getRandomValues(new Uint8Array(300_000));
	await mkdir(join(mine, 'recordings'), { recursive: true });
	await writeFile(join(mine, 'recordings', `${id}.md`), note('Kitchen'));
	await writeFile(join(mine, 'recordings', `${id}.m4a`), audio);
	expect(
		(await alice.epicenter('init', mine, '--title', 'Kitchen sounds')).code,
	).toBe(0);
	expect((await alice.epicenter('sync', mine)).code).toBe(0);
	const folder = (await alice.folderOf('Recorder')) as string;
	const aliceNote = join(mine, 'recordings', `${id}.md`);

	// Before a share, Bob reaches nothing of hers.
	const stranger = await bob.epicenter('clone', folder, '--json');
	expect(stranger.code).toBe(2);
	expect(stranger.stdout).toContain('no folder');

	const shared = await alice.epicenter(
		'share',
		mine,
		bob.email,
		'--role',
		'reader',
		'--json',
	);
	expect(shared.stderr).toBe('');
	expect(JSON.parse(shared.stdout)).toEqual({
		share: { folder, person: bob.email, role: 'reader', pending: true },
	});
	// Waiting: it is not among Bob's folders, and nothing of it is his yet.
	expect(JSON.parse((await bob.epicenter('clone', '--json')).stdout)).toEqual({
		folders: [],
	});
	const waiting = JSON.parse((await bob.epicenter('accept', '--json')).stdout);
	expect(waiting.pending).toMatchObject([
		{ folder, title: 'Kitchen sounds', role: 'reader' },
	]);
	expect(
		JSON.parse((await bob.epicenter('status', '--json')).stdout).folders,
	).toEqual([]);

	// Accepted, it lands in Bob's Epicenter folder, named for its title.
	const accepted = await bob.epicenter('accept', 'Kitchen sounds');
	expect(accepted.code, accepted.stdout + accepted.stderr).toBe(0);
	const copy = bob.at('Kitchen sounds');
	expect(
		new Uint8Array(await readFile(join(copy, 'recordings', `${id}.m4a`))),
	).toEqual(audio);
	const status = JSON.parse((await bob.epicenter('status', '--json')).stdout);
	expect(status.folders).toMatchObject([
		{
			name: 'Kitchen sounds',
			title: 'Kitchen sounds',
			state: 'shared',
			folder,
		},
	]);
	expect((await alice.epicenter('status')).stdout).toContain(
		'Recorder (Kitchen sounds): shared, You and bob',
	);

	// A reader's edit is refused, and Alice's note stays.
	const notePath = join(copy, 'recordings', `${id}.md`);
	await writeFile(notePath, note('Kitchen, by Bob'));
	const refused = await bob.epicenter('sync', copy, '--json');
	expect(refused.code).toBe(2);
	expect(refused.stdout).toContain('403');
	expect((await alice.epicenter('sync', mine)).code).toBe(0);
	expect(await readFile(aliceNote, 'utf8')).toBe(note('Kitchen'));

	// As a member, his edit lands on his next sync, and Alice syncs it down.
	expect(
		(await alice.epicenter('share', folder, bob.email, '--role', 'member'))
			.code,
	).toBe(0);
	expect((await bob.epicenter('sync', copy)).code).toBe(0);
	expect((await alice.epicenter('sync', mine)).code).toBe(0);
	expect(await readFile(aliceNote, 'utf8')).toBe(note('Kitchen, by Bob'));

	// Unshared: Bob's next sync is refused, and what he has stays.
	const revoked = await alice.epicenter('unshare', mine, bob.email, '--json');
	expect(JSON.parse(revoked.stdout)).toEqual({
		unshare: { folder, person: bob.email, removed: true, folderGone: false },
	});
	await writeFile(notePath, note('Kitchen, again'));
	const after = await bob.epicenter('sync', copy, '--json');
	expect(after.code).toBe(2);
	expect(after.stdout).toContain('403');
	expect(
		new Uint8Array(await readFile(join(copy, 'recordings', `${id}.m4a`))),
	).toEqual(audio);
}, 240_000);

test('a first sync on another computer joins the folder the person holds; a copy asks which folder it is and is answered by --join or --create', async () => {
	const me = await machine('asker');
	const other = await machine('asker-laptop', me);
	const diary = me.at('Diary');
	await mkdir(join(diary, 'days'), { recursive: true });
	await writeFile(join(diary, 'days/one.md'), note('One'));
	const dry = await me.epicenter('init', diary, '--dry-run', '--json');
	expect(JSON.parse(dry.stdout).init).toMatchObject({
		written: false,
		contract: {
			title: 'Diary',
			collections: {
				days: { path: 'days/{name}.md', fields: { title: { type: 'string' } } },
			},
		},
	});
	expect((await me.epicenter('sync', diary)).code).toBe(0);
	const folder = (await me.folderOf('Diary')) as string;

	// The laptop's own Diary, never synced, joins the one folder she holds by
	// that name: from first contact, so both sides' notes stay.
	await mkdir(join(other.at('Diary'), 'days'), { recursive: true });
	await writeFile(join(other.at('Diary'), 'days/two.md'), note('Two'));
	const joined = await other.epicenter('sync', 'Diary', '--json');
	expect(joined.code, joined.stdout + joined.stderr).toBe(0);
	expect(JSON.parse(joined.stdout).sync).toMatchObject({
		id: folder,
		joined: true,
		made: false,
	});
	expect(await readdir(join(other.at('Diary'), 'days'))).toEqual([
		'one.md',
		'two.md',
	]);

	// Two more of her folders are titled Diary, made with --create, which
	// never joins one she has.
	for (const name of ['Second', 'Third']) {
		await mkdir(me.at(name), { recursive: true });
		await writeFile(
			join(me.at(name), 'epicenter.json'),
			JSON.stringify({ title: 'Diary', collections: {} }),
		);
		expect((await me.epicenter('sync', name, '--create')).code).toBe(0);
	}
	const second = (await me.folderOf('Second')) as string;
	const third = (await me.folderOf('Third')) as string;
	expect(new Set([folder, second, third]).size).toBe(3);
	// On the laptop, a folder titled Diary could be either of the two not
	// synced there: it asks, and sends nothing.
	const notebook = other.at('Notebook');
	await mkdir(notebook, { recursive: true });
	await writeFile(
		join(notebook, 'epicenter.json'),
		JSON.stringify({ title: 'Diary', collections: {} }),
	);
	await writeFile(join(notebook, 'private.md'), note('Private'));
	const asked = await other.epicenter('sync', 'Notebook', '--json');
	expect(asked.code).toBe(1);
	const question = JSON.parse(asked.stdout).question;
	expect(question).toMatchObject({ folder: 'Notebook', preselected: null });
	expect(
		question.candidates.map(({ id }: { id: string }) => id).sort(),
	).toEqual([second, third].sort());
	const human = await other.epicenter('sync', 'Notebook');
	expect(human.stderr).toContain('is not synced on this computer yet');
	expect(human.stderr).toContain('--join');
	expect(
		JSON.parse((await other.epicenter('status', '--json')).stdout).folders,
	).toMatchObject([
		{ name: 'Diary', state: 'synced', folder },
		{ name: 'Notebook', state: 'local', folder: null },
	]);
	expect(
		(await other.epicenter('sync', 'Notebook', '--join', second, '--create'))
			.code,
	).toBe(2);
	const answered = await other.epicenter(
		'sync',
		'Notebook',
		'--join',
		third,
		'--json',
	);
	expect(answered.code, answered.stdout + answered.stderr).toBe(0);
	expect(JSON.parse(answered.stdout).sync).toMatchObject({
		id: third,
		joined: true,
	});

	// A copy of Diary here could be no folder not already synced here: its
	// sync makes a new one, and the original never takes its private note.
	const copy = me.at('Diary copy');
	await cp(diary, copy, { recursive: true });
	await writeFile(join(copy, 'days/private.md'), note('Private'));
	const made = await me.epicenter('sync', copy, '--json');
	expect(made.code, made.stdout + made.stderr).toBe(0);
	expect(JSON.parse(made.stdout).sync).toMatchObject({ made: true });
	expect(await me.folderOf('Diary copy')).not.toBe(folder);
	expect((await me.epicenter('sync', diary, '--json')).code).toBe(0);
	await expect(readFile(join(diary, 'days/private.md'))).rejects.toThrow();

	// Outside the Epicenter folder, or inside a record, nothing syncs.
	const outside = join(me.home, 'elsewhere');
	await mkdir(outside, { recursive: true });
	for (const target of [outside, join(diary, 'days')]) {
		const refused = await me.epicenter('sync', target, '--json');
		expect(refused.code).toBe(2);
		expect(JSON.parse(refused.stdout).error).toContain('is not a folder in');
	}
}, 240_000);

test("history, show, at, and mark read a folder's log by change, mark, or time", async () => {
	const me = await machine('history-me');
	const desk = me.at('Journal');
	await mkdir(join(desk, 'days'), { recursive: true });
	await writeFile(join(desk, 'days/a.md'), note('A', 'first\n'));
	expect((await me.epicenter('sync', desk)).code).toBe(0);
	const marked = await me.epicenter('mark', 'v1', desk, '--json');
	expect(marked.code, marked.stderr).toBe(0);
	expect(JSON.parse(marked.stdout).mark).toMatchObject({ name: 'v1' });
	await writeFile(join(desk, 'days/a.md'), note('A', 'second\n'));
	await writeFile(join(desk, 'days/b.md'), note('B'));
	expect((await me.epicenter('sync', desk)).code).toBe(0);
	// A taken name stays, unless it is moved.
	expect((await me.epicenter('mark', 'v1', desk)).code).toBe(2);

	const history = JSON.parse(
		(await me.epicenter('history', join(desk, 'days/a.md'), '--json')).stdout,
	) as {
		history: { path: string; versions: { seq: number; marks: string[] }[] };
	};
	expect(history.history.path).toBe('days/a.md');
	expect(history.history.versions).toHaveLength(2);
	expect(history.history.versions[1]?.marks).toEqual(['v1']);

	const then = await me.epicenter(
		'show',
		join(desk, 'days/a.md'),
		'--at',
		'v1',
	);
	expect(then.code, then.stderr).toBe(0);
	expect(then.stdout).toBe(note('A', 'first\n'));
	expect((await me.epicenter('show', join(desk, 'days/a.md'))).stdout).toBe(
		note('A', 'second\n'),
	);

	const at = JSON.parse((await me.epicenter('at', 'v1', desk, '--json')).stdout)
		.at as { files: { path: string }[] };
	expect(at.files.map(({ path }) => path)).toEqual([
		'days/a.md',
		'epicenter.json',
	]);
	const early = JSON.parse(
		(await me.epicenter('at', '2000-01-01', desk, '--json')).stdout,
	).at as { seq: number; files: unknown[] };
	expect(early).toMatchObject({ seq: 0, files: [] });

	const log = JSON.parse(
		(await me.epicenter('log', desk, '--path', 'days/b.md', '--json')).stdout,
	).log as { files: { path: string }[] }[];
	expect(log).toHaveLength(1);
}, 120_000);

test('a sync that would delete many files stops until --push-deletions or --restore-deletions', async () => {
	const me = await machine('deleter');
	const log = me.at('Log');
	await mkdir(join(log, 'days'), { recursive: true });
	for (let day = 1; day <= 25; day++)
		await writeFile(join(log, `days/${day}.md`), note(`Day ${day}`));
	expect((await me.epicenter('sync', 'Log')).code).toBe(0);
	for (let day = 1; day <= 21; day++) await rm(join(log, `days/${day}.md`));
	const stopped = await me.epicenter('sync', 'Log');
	expect(stopped.code).toBe(1);
	expect(stopped.stderr).toContain('would delete 21 files on the server');
	expect(stopped.stderr).toContain('--push-deletions');
	const json = JSON.parse((await me.epicenter('sync', 'Log', '--json')).stdout);
	expect(json.sync).toMatchObject({ outcome: 'deletions' });
	expect(json.sync.deletions).toHaveLength(21);
	expect((await me.epicenter('sync', 'Log', '--restore-deletions')).code).toBe(
		0,
	);
	expect(await readdir(join(log, 'days'))).toHaveLength(25);
	for (let day = 1; day <= 21; day++) await rm(join(log, `days/${day}.md`));
	const pushed = await me.epicenter(
		'sync',
		'Log',
		'--push-deletions',
		'--json',
	);
	expect(JSON.parse(pushed.stdout).sync).toMatchObject({ outcome: 'synced' });
	expect(JSON.parse(pushed.stdout).sync.pushed).toHaveLength(21);
}, 240_000);
