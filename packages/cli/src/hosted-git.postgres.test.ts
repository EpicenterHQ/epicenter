/**
 * Hosted Git end to end through the `epicenter` command (ADR-0546): the real
 * authorization server and Git routes on a disposable Postgres cluster behind
 * a real listener, bare repositories on disk, and fresh CLI processes for
 * `init`, `sync`, `clone`, and `repos`. A folder connects with plain
 * `git remote add origin`, and its first sync's push creates the repository
 * (decision 39). Git reaches this `http` server through
 * `epicenter auth git-credential`, the credential helper `auth login`
 * writes, which the test writes the same way. Git can find no repository
 * above the scratch directory (`GIT_CEILING_DIRECTORIES`). The processes share a sign-in the
 * test seeds into their in-memory keychain (`EPICENTER_TEST_SECRETS`), with
 * the Git and API tokens already cached, so none refreshes and the rotating
 * refresh token is never replayed. Requires initdb, pg_ctl, and git on PATH;
 * never connects to a configured database.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
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
import { createMemorySecrets } from '@epicenter/ai/send';
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import type { RepositoryListing } from '@epicenter/constants/repositories';
import {
	type CloudEnv,
	createCloudContextMiddleware,
	createDb,
	createDiskGitHost,
	createServerApp,
	mountAuthRoutes,
	mountGitHost,
	registerFirstPartyClients,
} from '@epicenter/server/bun';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { startDisposablePostgres } from '../../server/src/test-helpers/disposable-postgres.js';
import {
	OAuthTestClient,
	type Person,
} from '../../server/src/test-helpers/oauth-client.js';
import {
	type AuthContext,
	accessToken,
	configureGitHelper,
	loginWithDevice,
	resolveDeployment,
} from './auth.ts';

const secret = 'cli-hosted-git-secret-0123456789abcdefgh';
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
let person: Person;
let env: Record<string, string>;
let globalConfig: string;

beforeAll(async () => {
	scratch = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-hosted-git-')),
	);
	const cluster = await startDisposablePostgres();
	stopPostgres = cluster.stop;
	const sql = cluster.clients[0];
	const db = createDb(sql);
	await migrate(db, {
		migrationsFolder: fileURLToPath(
			new URL('../../../apps/api/drizzle/', import.meta.url),
		),
	});
	const app = createServerApp<CloudEnv>({
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
		setup: createCloudContextMiddleware({
			...context,
			oauthServer: true,
		}),
		serveAuthUiShell: (c) => c.html('<html>shell</html>'),
	});
	const host = createDiskGitHost({ root: join(scratch, 'store') });
	mountGitHost(app, {
		setup: createCloudContextMiddleware(context),
		resolveHost: () => host,
	});
	const client = new OAuthTestClient(origin, sql, secret, async (url, init) =>
		app.fetch(new Request(url, init)),
	);

	// Sign a machine in with the device grant, as `epicenter auth login` does.
	person = await client.person('hosted-git');
	const secrets = createMemorySecrets();
	const ctx: AuthContext = {
		deployment: resolveDeployment(origin),
		secrets,
		lockDir: join(scratch, 'locks'),
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
			await client.approveDeviceCode({
				cookie: person.cookie,
				userCode: codes[0]!.userCode,
				clientId: 'so.epicenter.cli',
				target: '*',
			});
		},
	});
	expect(login.error).toBeNull();
	// Cache the Git token too, so no process refreshes.
	expect((await accessToken(ctx, 'device', audiences.git)).error).toBeNull();
	const entry = `device ${ctx.deployment.origin}`;
	const stored = JSON.parse((await secrets.get(entry)) as string);

	globalConfig = join(scratch, 'gitconfig');
	await writeFile(globalConfig, '');
	env = {
		PATH: process.env.PATH as string,
		HOME: scratch,
		GIT_CONFIG_GLOBAL: globalConfig,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_CEILING_DIRECTORIES: scratch,
		EPICENTER_API_URL: origin,
		EPICENTER_DATA_DIR: join(scratch, 'data'),
		EPICENTER_FOLDER_DIR: join(scratch, 'Epicenter'),
		EPICENTER_TEST_SECRETS: JSON.stringify({ $auth: { [entry]: stored } }),
	};
	// What `auth login` writes. An `http` server like this one gets no token
	// as a header, so the CLI's own `git` signs in through the helper too.
	const helper = await configureGitHelper(
		{ deployment: resolveDeployment(origin) } as AuthContext,
		[process.execPath, '--no-install', bin],
		env,
	);
	if (helper.error !== null) throw new Error(helper.error);
	// The command link the merge driver runs: this checkout's CLI.
	const link = join(scratch, '.local', 'bin', 'epicenter');
	await mkdir(join(link, '..'), { recursive: true });
	await writeFile(
		link,
		`#!/bin/sh\nexec '${process.execPath}' --no-install '${bin}' "$@"\n`,
	);
	await chmod(link, 0o755);
}, 60_000);

afterAll(async () => {
	server?.stop(true);
	await stopPostgres?.();
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** A fresh `epicenter` process. */
async function epicenter(...args: string[]) {
	const child = Bun.spawn([process.execPath, '--no-install', bin, ...args], {
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

async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(['git', ...args], {
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

test('init, a remote added by hand, and sync create the repository; clone and sync carry it to another folder; repos lists it', async () => {
	const folder = join(scratch, 'notes');
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, 'a.md'), 'one\n');

	const url = `${origin}/git/${person.personal}/notes.git`;
	const globalBefore = await readFile(globalConfig, 'utf8');
	const initialized = await epicenter('init', folder, '--json');
	expect(initialized.code).toBe(0);
	expect((await git(folder, 'remote', 'add', 'origin', url)).code).toBe(0);
	const created = await epicenter('sync', folder, '--json');
	expect(created.code).toBe(0);
	expect(JSON.parse(created.stdout).sync.status).toBe('synced');
	// Init only registers the folder in the global configuration; the
	// credential helper there is the one `auth login` wrote.
	expect(await readFile(globalConfig, 'utf8')).toBe(
		`${globalBefore}[epicenter]\n\tfolder = ${folder}\n`,
	);

	const listing = await epicenter('repos', '--json');
	expect(listing.code).toBe(0);
	const { namespaces } = JSON.parse(listing.stdout) as RepositoryListing;
	expect(namespaces[0]).toMatchObject({
		id: person.personal,
		personal: true,
		repositories: [{ name: 'notes', url }],
	});
	expect((await epicenter('repos')).stdout).toContain(
		`${person.personal}/notes`,
	);

	// Plain Git signs in through the helper `auth login` wrote.
	expect(globalBefore).toContain(`${origin}/git`);
	expect((await git(scratch, 'ls-remote', url)).code).toBe(0);

	const copy = join(scratch, 'Epicenter', 'notes');
	const cloned = await epicenter('clone', `${person.personal}/notes`, '--json');
	expect(cloned.stderr).toBe('');
	expect(cloned.code).toBe(0);
	expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\n');

	// Each side adds a file; syncing both ways brings them together.
	await writeFile(join(copy, 'b.md'), 'two\n');
	expect((await epicenter('sync', copy)).code).toBe(0);
	await writeFile(join(folder, 'c.md'), 'three\n');
	expect((await epicenter('sync', folder)).code).toBe(0);
	expect(await readFile(join(folder, 'b.md'), 'utf8')).toBe('two\n');
	expect((await epicenter('sync', copy)).code).toBe(0);
	expect(await readFile(join(copy, 'c.md'), 'utf8')).toBe('three\n');
}, 180_000);

test('a folder with a history of its own joins an existing repository on its first sync', async () => {
	const other = join(scratch, 'other-notes');
	await mkdir(other, { recursive: true });
	await writeFile(join(other, 'z.md'), 'z\n');
	expect((await epicenter('init', other)).code).toBe(0);
	const url = `${origin}/git/${person.personal}/notes.git`;
	await git(other, 'remote', 'add', 'origin', url);
	const joined = await epicenter('sync', other, '--json');
	expect(joined.code).toBe(0);
	expect(await readFile(join(other, 'a.md'), 'utf8')).toBe('one\n');
	expect((await git(other, 'cat-file', '-e', 'origin/main:z.md')).code).toBe(0);
}, 60_000);
