/**
 * Everything the end-to-end suite runs against, as one Bun process (the
 * Playwright runner is Node, and the server and CLI helpers are Bun):
 *
 * 1. A disposable Postgres cluster, migrated with `apps/api/drizzle`.
 * 2. The real local API, `bun apps/api/server.ts`, on a free port, with Git
 *    and LFS stores in a temporary directory. It registers the demo's
 *    local-only OAuth client at boot.
 * 3. One person per browser project, with a signed-in session cookie for
 *    the browser, and a desktop sandbox for the `epicenter` CLI: its own
 *    HOME, GIT_CONFIG_GLOBAL and GIT_CEILING_DIRECTORIES, a device-grant
 *    sign-in seeded through EPICENTER_TEST_SECRETS, the Git credential
 *    helper `auth login` writes, and the command link the merge driver runs.
 * 4. The demo built against that API and served by `vite preview` on its
 *    registered port.
 *
 * It writes what the tests need to the JSON file named by its argument,
 * prints `ready`, and tears everything down on SIGTERM or SIGINT.
 *
 *   bun apps/recorder-demo/e2e/stack.ts /tmp/state.json
 *
 * With `--demo` (`bun run demo`), the same environment is for a person
 * trying the demo by hand: one person, a sign-in helper page that sets that
 * person's session on the API (cookies ignore the port, so any `localhost`
 * page can), and a script to `source` for the desktop sandbox. It runs until
 * Ctrl-C.
 */
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	LOCAL_APPS,
	localUrl,
	resolveOAuthAudiences,
} from '@epicenter/constants/apps';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createMemorySecrets } from '../../../packages/ai/src/send.ts';
import {
	type AuthContext,
	accessToken,
	configureGitHelper,
	loginWithDevice,
	resolveDeployment,
} from '../../../packages/cli/src/auth.ts';
import { startDisposablePostgres } from '../../../packages/server/src/test-helpers/disposable-postgres.ts';
import { OAuthTestClient } from '../../../packages/server/src/test-helpers/oauth-client.ts';

/** What the tests read from the state file. */
export type Stack = {
	/** The API's origin, `http://localhost:<port>`. */
	origin: string;
	/** The demo's origin, its registered `http://localhost:5214`. */
	app: string;
	bun: string;
	/** `packages/cli/src/bin.ts`: the `epicenter` command from this checkout. */
	cli: string;
	people: Record<string, Person>;
	/** Per browser project, a second person the first shares with: a browser session only. */
	guests: Record<string, Guest>;
};

export type Guest = Pick<Person, 'namespace' | 'cookie'>;

export type Person = {
	namespace: string;
	/** The browser's session cookie on the API's host. */
	cookie: { name: string; value: string };
	/** The desktop sandbox directory, and the environment every CLI and git process there runs with. */
	home: string;
	env: Record<string, string>;
};

const demo = process.argv.includes('--demo');
const statePath = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
if (!demo && !statePath)
	throw new Error('usage: bun stack.ts <state.json> | bun stack.ts --demo');

const repo = resolve(import.meta.dir, '../../..');
const appDir = resolve(import.meta.dir, '..');
const cli = join(repo, 'packages/cli/src/bin.ts');
const secret = 'recorder-demo-e2e-0123456789abcdefghijk';
const projects = demo ? ['demo'] : ['chromium', 'webkit'];

const children: ReturnType<typeof Bun.spawn>[] = [];
let stopPostgres: (() => Promise<void>) | undefined;
let scratch: string | undefined;

async function teardown() {
	// Awaiting alone does not keep Bun running once the children are gone;
	// this does, until the cluster and the directory are gone too.
	const alive = setInterval(() => {}, 1000);
	try {
		for (const child of children) child.kill('SIGTERM');
		const exited = Promise.all(children.map((child) => child.exited));
		const late = setTimeout(() => {
			for (const child of children) child.kill('SIGKILL');
		}, 5000);
		await exited;
		clearTimeout(late);
		await stopPostgres?.();
		if (scratch) await rm(scratch, { recursive: true, force: true });
	} finally {
		clearInterval(alive);
	}
}

/**
 * Stop on SIGTERM or SIGINT only after tearing down. The CLI's sign-in code
 * this process borrows installs the CLI's own stop handler, which exits at
 * once (`packages/cli/src/stop.ts`), so this replaces it once that code is done.
 */
function stopOnSignal() {
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.removeAllListeners(signal);
		process.on(signal, () => {
			void teardown()
				.catch((cause) => console.error('teardown failed', cause))
				.finally(() => process.exit(0));
		});
	}
}
stopOnSignal();

async function freePort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
	const address = listener.address();
	await new Promise((done) => listener.close(done));
	if (!address || typeof address === 'string') throw new Error('no port');
	return address.port;
}

/** Wait until `url` answers at all, or fail with the process's log. */
async function waitFor(url: string, log: string) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			await fetch(url);
			return;
		} catch {
			await Bun.sleep(200);
		}
	}
	throw new Error(
		`${url} never answered:\n${await Bun.file(log)
			.text()
			.catch(() => '')}`,
	);
}

/** A child process whose output goes to `log`; it stops with the stack. */
function start(
	command: string[],
	options: { cwd: string; env: Record<string, string>; log: string },
) {
	const child = Bun.spawn(command, {
		cwd: options.cwd,
		env: options.env,
		stdout: Bun.file(options.log),
		stderr: Bun.file(`${options.log}.err`),
	});
	children.push(child);
	return child;
}

async function run(
	command: string[],
	options: { cwd: string; env: Record<string, string> },
) {
	const child = Bun.spawn(command, {
		...options,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(
			`${command.join(' ')} exited ${code}:\n${stdout}\n${stderr}`,
		);
}

/** Git and the server's git never read the real home or global config. */
function sandboxEnv(home: string): Record<string, string> {
	return {
		PATH: process.env.PATH as string,
		HOME: home,
		GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_CEILING_DIRECTORIES: home,
	};
}

async function sandbox(name: string) {
	const home = join(scratch as string, name);
	await mkdir(home, { recursive: true });
	await writeFile(join(home, 'gitconfig'), '');
	return home;
}

try {
	scratch = await realpath(await mkdtemp(join(tmpdir(), 'recorder-demo-e2e-')));

	// 1. Postgres.
	const cluster = await startDisposablePostgres();
	stopPostgres = cluster.stop;
	const sql = cluster.clients[0];
	await migrate(drizzle(sql), {
		migrationsFolder: join(repo, 'apps/api/drizzle'),
	});

	// 2. The API.
	const port = await freePort();
	const origin = `http://localhost:${port}`;
	const serverHome = await sandbox('server');
	const apiLog = join(scratch, 'api.log');
	start([process.execPath, 'server.ts'], {
		cwd: join(repo, 'apps/api'),
		log: apiLog,
		env: {
			...sandboxEnv(serverHome),
			DATABASE_URL: `postgres://postgres@127.0.0.1:${cluster.port}/postgres`,
			BETTER_AUTH_SECRET: secret,
			PORT: String(port),
			GIT_STORE_ROOT: join(scratch, 'git'),
			LFS_STORE_ROOT: join(scratch, 'lfs'),
			GOOGLE_CLIENT_ID: 'x',
			GOOGLE_CLIENT_SECRET: 'x',
			GITHUB_CLIENT_ID: 'x',
			GITHUB_CLIENT_SECRET: 'x',
			MICROSOFT_CLIENT_ID: 'x',
			MICROSOFT_CLIENT_SECRET: 'x',
		},
	});
	await waitFor(`${origin}/`, apiLog);

	// 3. People: a browser session and a signed-in desktop each.
	const client = new OAuthTestClient(origin, sql, secret);
	const deployment = resolveDeployment(origin);
	const { git } = resolveOAuthAudiences(origin);
	const people: Record<string, Person> = {};
	const guests: Record<string, Guest> = {};
	for (const project of projects) {
		const person = await client.person(project);
		const home = await sandbox(`desktop-${project}`);
		const secrets = createMemorySecrets();
		const ctx: AuthContext = {
			deployment,
			secrets,
			lockDir: join(home, 'locks'),
			fetch: (input, init) => fetch(input, init),
			now: Date.now,
		};
		const codes: { userCode: string }[] = [];
		let approved = false;
		const login = await loginWithDevice(ctx, {
			onCode: (code) => codes.push(code),
			sleep: async () => {
				if (approved) return;
				approved = true;
				await client.approveDeviceCode({
					cookie: person.cookie,
					userCode: (codes[0] as { userCode: string }).userCode,
					clientId: 'so.epicenter.cli',
					target: '*',
				});
			},
		});
		if (login.error !== null)
			throw new Error(`device sign-in: ${login.error.message}`);
		// Cache the Git token too, so no CLI process refreshes.
		const token = await accessToken(ctx, 'device', git);
		if (token.error !== null)
			throw new Error(`git token: ${token.error.message}`);
		const entry = `device ${deployment.origin}`;
		const stored = JSON.parse((await secrets.get(entry)) as string);
		const env = {
			...sandboxEnv(home),
			EPICENTER_API_URL: origin,
			EPICENTER_DATA_DIR: join(home, 'data'),
			EPICENTER_FOLDER_DIR: join(home, 'Epicenter'),
			EPICENTER_TEST_SECRETS: JSON.stringify({ $auth: { [entry]: stored } }),
		};
		const helper = await configureGitHelper(
			{ deployment } as AuthContext,
			[process.execPath, '--no-install', cli],
			env,
		);
		if (helper.error !== null) throw new Error(helper.error);
		const link = join(home, '.local', 'bin', 'epicenter');
		await mkdir(join(link, '..'), { recursive: true });
		await writeFile(
			link,
			`#!/bin/sh\nexec '${process.execPath}' --no-install '${cli}' "$@"\n`,
		);
		await chmod(link, 0o755);
		const [name, value] = person.cookie.split(/=(.*)/s) as [string, string];
		people[project] = {
			namespace: person.personal,
			cookie: { name, value },
			home,
			env,
		};
		const guest = await client.person(`${project}-guest`);
		const [guestName, guestValue] = guest.cookie.split(/=(.*)/s) as [
			string,
			string,
		];
		guests[project] = {
			namespace: guest.personal,
			cookie: { name: guestName, value: guestValue },
		};
	}

	stopOnSignal();

	// 4. The demo, built against this API and served as static files.
	const app = localUrl(LOCAL_APPS.RECORDER_DEMO);
	const dist = join(scratch, 'dist');
	const viteEnv = {
		PATH: process.env.PATH as string,
		HOME: serverHome,
		VITE_EPICENTER_SERVER: origin,
	};
	await run(
		[
			process.execPath,
			'x',
			'vite',
			'build',
			'--outDir',
			dist,
			'--emptyOutDir',
			'--logLevel',
			'warn',
		],
		{ cwd: appDir, env: viteEnv },
	);
	const previewLog = join(scratch, 'preview.log');
	start([process.execPath, 'x', 'vite', 'preview', '--outDir', dist], {
		cwd: appDir,
		env: viteEnv,
		log: previewLog,
	});
	await waitFor(`${app}/contract.json`, previewLog);

	const stack: Stack = {
		origin,
		app,
		bun: process.execPath,
		cli,
		people,
		guests,
	};
	if (statePath) await writeFile(statePath, JSON.stringify(stack, null, '\t'));
	if (demo) await printDemo(stack);
	console.log('ready');
} catch (cause) {
	console.error(cause);
	await teardown();
	process.exit(1);
}

/**
 * For `--demo`: a page that signs the browser in as the demo person, then
 * opens the app, and a script that puts a shell in the desktop sandbox.
 */
async function printDemo(stack: Stack) {
	const person = stack.people.demo as Person;
	const signIn = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () =>
			new Response(null, {
				status: 302,
				headers: {
					// Host-only on `localhost`, so the API on its own port gets it too.
					'set-cookie': `${person.cookie.name}=${person.cookie.value}; Path=/; HttpOnly; SameSite=Lax`,
					location: stack.app,
				},
			}),
	});
	const script = join(person.home, 'desktop.sh');
	const exports = Object.entries(person.env)
		.map(([key, value]) => `export ${key}='${value.replaceAll("'", `'\\''`)}'`)
		.join('\n');
	await writeFile(
		script,
		`${exports}\nepicenter() { '${stack.bun}' --no-install '${stack.cli}' "$@"; }\ncd '${person.home}'\n`,
	);
	console.log(`
Recorder demo     ${stack.app}
API               ${stack.origin}
Sign in           open http://localhost:${signIn.port}/ (sets the demo person's session), then press Sign in
Desktop sandbox   source '${script}'
                  epicenter clone ${person.namespace}/recorder-demo
                  epicenter check ${stack.app}/contract.json recorder-demo
                  epicenter sync recorder-demo
Stop              Ctrl-C (everything above is deleted)
`);
}
