/**
 * Sharing one repository between two people, end to end: the real
 * authorization server and Git routes on a disposable Postgres cluster
 * behind a real listener, bare repositories and Git LFS on disk, and fresh
 * `epicenter` processes on two machines, each signed in as its own person
 * with the device grant.
 *
 * Alice keeps a recording in a folder (a note and its audio, which goes up
 * through Git LFS) and syncs it to her repository, then shares it with Bob,
 * read only: he clones it with the same bytes, and his sync is refused. She
 * upgrades him to write: his edit lands and she syncs it down, though he
 * still may not rewrite `main`. She revokes him: his next sync is refused,
 * and his files stay. Each request's authorization at the HTTP level is
 * `packages/server`'s to test (`git.postgres.test.ts`).
 *
 * Each machine has its own HOME, Git configuration and keychain; Git can
 * find no repository above the scratch directory (`GIT_CEILING_DIRECTORIES`).
 * Requires initdb, pg_ctl, git, and git-lfs on PATH; never connects to a
 * configured database.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	chmod,
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
import { startDisposablePostgres } from '../../server/src/test-helpers/disposable-postgres.js';
import {
	OAuthTestClient,
	type Person,
} from '../../server/src/test-helpers/oauth-client.js';
import {
	type AuthContext,
	accessToken,
	loginWithDevice,
	resolveDeployment,
} from './auth.ts';
import { createMemorySecrets } from './secrets.ts';
import { configureTestGitHelper } from './test-git-helper.ts';

const secret = 'cli-grants-secret-0123456789abcdefghijkl';
const bin = resolve(import.meta.dir, 'bin.ts');
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
	scratch = await realpath(await mkdtemp(join(tmpdir(), 'epicenter-grants-')));
	const cluster = await startDisposablePostgres();
	stopPostgres = cluster.stop;
	const sql = cluster.clients[0];
	const db = createDb(sql);
	await migrate(db, {
		migrationsFolder: fileURLToPath(
			new URL('../../../apps/api/drizzle/', import.meta.url),
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

async function run(
	command: string[],
	env: Record<string, string>,
	cwd?: string,
): Promise<Run> {
	const child = Bun.spawn(command, {
		cwd,
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

/**
 * A person with a machine of their own: signed in with the device grant as
 * `epicenter auth login` does, its Git and API tokens cached so no process
 * refreshes, the credential helper `auth login` writes, and the command
 * link the merge driver runs.
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
	const globalConfig = join(home, 'gitconfig');
	await writeFile(globalConfig, '');
	const env = {
		PATH: process.env.PATH as string,
		HOME: home,
		GIT_CONFIG_GLOBAL: globalConfig,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_CEILING_DIRECTORIES: scratch,
		GIT_AUTHOR_NAME: label,
		GIT_AUTHOR_EMAIL: `${label}@example.test`,
		GIT_COMMITTER_NAME: label,
		GIT_COMMITTER_EMAIL: `${label}@example.test`,
		EPICENTER_API_URL: origin,
		EPICENTER_DATA_DIR: join(home, 'data'),
		EPICENTER_TEST_SECRETS: JSON.stringify({ $auth: { [entry]: stored } }),
	};
	configureTestGitHelper(
		resolveDeployment(origin).audiences.git,
		[process.execPath, '--no-install', bin],
		env,
	);
	const link = join(home, '.epicenter', 'bin', 'epicenter');
	await mkdir(join(link, '..'), { recursive: true });
	await writeFile(
		link,
		`#!/bin/sh\nexec '${process.execPath}' --no-install '${bin}' "$@"\n`,
	);
	await chmod(link, 0o755);
	return {
		/** The person's handle: their personal namespace's id. */
		handle: person.personal,
		home,
		epicenter: (...args: string[]) =>
			run([process.execPath, '--no-install', bin, ...args], env),
		git: (cwd: string, ...args: string[]) => run(['git', ...args], env, cwd),
	};
}

const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

test('a family member with a grant sees the recording; write lets them edit; a revoke stops their next sync', async () => {
	const alice = await machine('alice');
	const bob = await machine('bob');
	const repository = `${alice.handle}/recorder` as const;

	// Alice keeps a recording in a folder: a note, and its audio, which
	// goes up through Git LFS. Her first sync creates the repository.
	const mine = join(alice.home, 'recorder');
	const id = timeId();
	const audio = crypto.getRandomValues(new Uint8Array(300_000));
	await mkdir(join(mine, 'recordings'), { recursive: true });
	await writeFile(
		join(mine, 'recordings', `${id}.md`),
		'---\ntitle: Kitchen\n---\n',
	);
	await writeFile(join(mine, 'recordings', `${id}.m4a`), audio);
	const initialized = await alice.epicenter(
		'init',
		mine,
		'--name',
		'My recordings',
	);
	expect(initialized.code, initialized.stdout + initialized.stderr).toBe(0);
	expect((await alice.epicenter('connect', mine, '~/recorder')).code).toBe(0);
	const created = await alice.epicenter('sync', mine, '--json');
	expect(created.code, created.stdout + created.stderr).toBe(0);
	const aliceNote = join(mine, 'recordings', `${id}.md`);

	// Before a grant, Bob reaches nothing of hers.
	const copy = join(bob.home, 'Epicenter', 'recorder');
	const clone = () =>
		bob.epicenter(
			'clone',
			repository,
			copy,
			'--name',
			'Recordings from Alice',
			'--json',
		);
	const stranger = await clone();
	expect(stranger.code).toBe(2);

	// Read: Bob clones the same bytes, and may change nothing.
	const shared = await alice.epicenter(
		'share',
		repository,
		bob.handle,
		'--read',
		'--json',
	);
	expect(shared.stderr).toBe('');
	expect(JSON.parse(shared.stdout)).toEqual({
		person: bob.handle,
		level: 'read',
	});
	const listed = await alice.epicenter('share', '~/recorder', '--json');
	expect(JSON.parse(listed.stdout)).toEqual({
		grants: [{ person: bob.handle, level: 'read' }],
	});
	// Only the owner shares it on.
	expect(
		(await bob.epicenter('share', repository, alice.handle, '--read')).code,
	).toBe(2);

	const cloned = await clone();
	expect(cloned.stderr).toBe('');
	expect(cloned.code).toBe(0);
	const received = new Uint8Array(
		await readFile(join(copy, 'recordings', `${id}.m4a`)),
	);
	expect(sha256(received)).toBe(sha256(audio));
	expect(received).toEqual(audio);

	const notePath = join(copy, 'recordings', `${id}.md`);
	const note = await readFile(notePath, 'utf8');
	expect(note).toContain('title: Kitchen');
	await writeFile(
		notePath,
		note.replace('title: Kitchen', 'title: Kitchen, by Bob'),
	);
	const refused = await bob.epicenter('sync', copy, '--json');
	expect(refused.code, refused.stdout + refused.stderr).toBe(2);
	expect(refused.stdout + refused.stderr).toContain('403');
	expect((await alice.epicenter('sync', mine)).code).toBe(0);
	expect(await readFile(aliceNote, 'utf8')).toContain('title: Kitchen\n');

	// Write: the edit Bob committed lands on his next sync, and Alice sees it.
	expect(
		(await alice.epicenter('share', repository, bob.handle, '--write')).code,
	).toBe(0);
	const synced = await bob.epicenter('sync', copy, '--json');
	expect(synced.code, synced.stdout + synced.stderr).toBe(0);
	expect((await alice.epicenter('sync', mine)).code).toBe(0);
	expect(await readFile(aliceNote, 'utf8')).toContain('title: Kitchen, by Bob');
	// Only the owner may rewrite main (decision 33).
	const rewound = await bob.git(
		copy,
		'push',
		'--force',
		'origin',
		'HEAD~1:refs/heads/main',
	);
	expect(rewound.code).not.toBe(0);
	expect(rewound.stderr).toContain(
		'only the repository owner may rewrite main',
	);

	// Revoke: Bob's next sync is refused, and what he has stays.
	const revoked = await alice.epicenter(
		'unshare',
		repository,
		bob.handle,
		'--json',
	);
	expect(JSON.parse(revoked.stdout)).toEqual({
		person: bob.handle,
		revoked: true,
	});
	const after = await bob.epicenter('sync', copy, '--json');
	expect(after.code, after.stdout + after.stderr).toBe(2);
	expect(after.stdout + after.stderr).toContain('403');
	expect(
		new Uint8Array(await readFile(join(copy, 'recordings', `${id}.m4a`))),
	).toEqual(audio);
	expect(await readFile(notePath, 'utf8')).toContain('title: Kitchen, by Bob');
	expect(
		JSON.parse((await alice.epicenter('share', repository, '--json')).stdout),
	).toEqual({ grants: [] });
}, 240_000);
