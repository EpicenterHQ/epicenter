/**
 * How a hosted remote's token reaches Git: fresh `epicenter` processes
 * against an `https` stand-in for the deployment's Git origin (`git
 * http-backend` and a small LFS server behind a self-signed certificate),
 * which refuses any request without the grant's Bearer token. Each process
 * holds a signed-in device and desktop grant, seeded with cached Git tokens
 * through `EPICENTER_TEST_SECRETS`, so none refreshes.
 *
 * Key behaviors:
 * - Clone, fetch, push, and every LFS request carry one
 *   `Authorization: Bearer` header, the token of the grant the command runs
 *   under (`--desktop` selects the desktop app's)
 * - The token is never in a `git` command line or the CLI's output
 * - `init` and `clone` write no credential helper into the clone, with or
 *   without `--desktop`
 *
 * The sandbox is sync.e2e's: its own `HOME`, `GIT_CONFIG_GLOBAL`, and
 * `GIT_CEILING_DIRECTORIES` at the sandbox, so no person's configuration or
 * repository is reached.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lfsHandler } from './lfs-server.test-support.ts';

const BIN = resolve(import.meta.dir, '..', 'bin.ts');
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'epicenter-credentials-')));
const HOME = join(BOX, 'home');
const STORE = join(BOX, 'store');
/** Every command line the CLI gave `git`, one per line. */
const ARGV_LOG = join(BOX, 'git-argv.log');
const NAMESPACE = 'abcdefghijkl';
const TOKENS = {
	device: 'device-token.0123456789abcdef',
	desktop: 'desktop-token.fedcba9876543210',
};

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let env: Record<string, string>;
/** Each request the Git origin answered: method, path, and the grant whose token it carried. */
const requests: { method: string; path: string; grant: string }[] = [];

/** Run `cmd` without blocking this process, which serves the Git origin. */
async function run(cwd: string, cmd: string[]) {
	const child = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}
const epicenter = (...args: string[]) =>
	run(BOX, [process.execPath, '--no-install', BIN, ...args]);
const git = (cwd: string, ...args: string[]) => run(cwd, ['git', ...args]);

/** Answer one smart HTTP request for the repository `pathInfo` names under STORE. */
async function httpBackend(request: Request, pathInfo: string) {
	const body =
		request.method === 'GET'
			? undefined
			: new Uint8Array(await request.arrayBuffer());
	const child = Bun.spawn(['git', 'http-backend'], {
		cwd: STORE,
		env: {
			...env,
			GIT_PROJECT_ROOT: STORE,
			GIT_HTTP_EXPORT_ALL: '1',
			PATH_INFO: pathInfo,
			REQUEST_METHOD: request.method,
			QUERY_STRING: new URL(request.url).search.slice(1),
			CONTENT_TYPE: request.headers.get('content-type') ?? '',
			CONTENT_LENGTH: String(body?.byteLength ?? 0),
			REMOTE_USER: 'test',
			REMOTE_ADDR: '127.0.0.1',
			SERVER_PROTOCOL: 'HTTP/1.1',
			GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
		},
		stdin: body ?? 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).arrayBuffer(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		return new Response(`git http-backend failed: ${err}`, { status: 500 });
	const bytes = Buffer.from(out);
	const split = bytes.indexOf('\r\n\r\n');
	const headers = new Headers();
	let status = 200;
	for (const line of bytes.subarray(0, split).toString().split('\r\n')) {
		const colon = line.indexOf(':');
		const value = line.slice(colon + 1).trim();
		if (line.slice(0, colon).toLowerCase() === 'status')
			status = Number(value.split(' ')[0]);
		else headers.append(line.slice(0, colon), value);
	}
	return new Response(bytes.subarray(split + 4), { status, headers });
}

beforeAll(async () => {
	mkdirSync(HOME, { recursive: true });
	mkdirSync(STORE, { recursive: true });
	// A certificate for 127.0.0.1, which Git is told not to verify.
	const key = join(BOX, 'key.pem');
	const cert = join(BOX, 'cert.pem');
	const made = Bun.spawnSync([
		'openssl',
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-subj',
		'/CN=127.0.0.1',
		'-days',
		'1',
		'-keyout',
		key,
		'-out',
		cert,
	]);
	if (made.exitCode !== 0) throw new Error(made.stderr.toString());

	const lfs = lfsHandler(join(BOX, 'lfs'));
	server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		tls: { key: Bun.file(key), cert: Bun.file(cert) },
		async fetch(request) {
			const url = new URL(request.url);
			const authorization = request.headers.get('authorization');
			const grant =
				Object.entries(TOKENS).find(
					([, token]) => authorization === `Bearer ${token}`,
				)?.[0] ?? 'none';
			requests.push({ method: request.method, path: url.pathname, grant });
			if (grant === 'none')
				return new Response('a token is required', {
					status: 401,
					headers: { 'www-authenticate': 'Basic realm="test"' },
				});
			if (!url.pathname.startsWith('/git/'))
				return new Response('not found', { status: 404 });
			if (url.pathname.includes('/info/lfs/')) return lfs(request);
			return httpBackend(request, url.pathname.slice('/git'.length));
		},
	});
	origin = `https://127.0.0.1:${server.port}`;

	const grant = (client: string, token: string) => ({
		client,
		generation: `generation-${client}`,
		issuer: origin,
		refreshToken: `refresh-${client}`,
		scope: 'openid offline_access folders:read folders:write',
		account: { id: 'person' },
		signedInAt: new Date().toISOString(),
		access: {
			[`${origin}/git`]: { token, expiresAt: Date.now() + 3_600_000 },
		},
	});
	const wrapper = join(BOX, 'git-wrapper');
	const realGit = Bun.which('git') as string;
	writeFileSync(
		wrapper,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> '${ARGV_LOG}'\nexec '${realGit}' "$@"\n`,
	);
	chmodSync(wrapper, 0o755);
	env = {
		PATH: process.env.PATH ?? '/usr/bin:/bin',
		HOME,
		TMPDIR: tmpdir(),
		XDG_CONFIG_HOME: join(HOME, '.config'),
		GIT_CONFIG_GLOBAL: join(HOME, '.gitconfig'),
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_CEILING_DIRECTORIES: BOX,
		GIT_SSL_NO_VERIFY: '1',
		NO_PROXY: '127.0.0.1,localhost',
		EPICENTER_GIT: wrapper,
		EPICENTER_API_URL: origin,
		EPICENTER_DATA_DIR: join(BOX, 'data'),
		EPICENTER_TEST_SECRETS: JSON.stringify({
			$auth: {
				[`device ${origin}`]: grant('so.epicenter.cli', TOKENS.device),
				[`desktop ${origin}`]: grant('so.epicenter', TOKENS.desktop),
			},
		}),
	};
	writeFileSync(env.GIT_CONFIG_GLOBAL as string, '');
	// The engine the merge driver runs: this checkout's CLI.
	const link = join(HOME, '.epicenter', 'bin', 'epicenter');
	mkdirSync(join(link, '..'), { recursive: true });
	writeFileSync(
		link,
		`#!/bin/sh\nexec '${process.execPath}' --no-install '${BIN}' "$@"\n`,
	);
	chmodSync(link, 0o755);

	const bare = join(STORE, NAMESPACE, 'notes.git');
	mkdirSync(bare, { recursive: true });
	for (const args of [
		['init', '-q', '--bare', '-b', 'main', bare],
		['-C', bare, 'config', 'http.receivepack', 'true'],
	])
		if ((await git(BOX, ...args)).code !== 0)
			throw new Error(`git ${args.join(' ')}`);
}, 60_000);

afterAll(() => {
	server?.stop(true);
	rmSync(BOX, { recursive: true, force: true });
});

/** The clone's own configuration keys that name a credential, if any. */
const credentialKeys = async (dir: string) =>
	(
		await git(
			dir,
			'config',
			'--local',
			'--name-only',
			'--get-regexp',
			'^credential\\.',
		)
	).stdout.trim();

/** The requests since `from` that `grant`'s token carried, as `METHOD path?service`. */
const carried = (from: number, grant: keyof typeof TOKENS) =>
	requests
		.slice(from)
		.filter((request) => request.grant === grant)
		.map(({ method, path }) =>
			`${method} ${path.replace(/^\/git\/[a-z0-9]+\/notes\.git/, '')}`.replace(
				/[0-9a-f]{64}/,
				'<oid>',
			),
		);

test('clone, fetch, push, and LFS carry the grant’s Bearer token; no clone keeps a credential', async () => {
	const remote = `${origin}/git/${NAMESPACE}/notes.git`;
	const A = join(BOX, 'A');
	const B = join(BOX, 'B');
	const outputs: string[] = [];
	const ok = (ran: Awaited<ReturnType<typeof run>>) => {
		outputs.push(ran.stdout, ran.stderr);
		expect(ran.stderr).toBe('');
		expect(ran.code).toBe(0);
	};

	// init without --desktop writes no credential helper.
	ok(await epicenter('init', A));
	expect(await credentialKeys(A)).toBe('');
	expect((await git(A, 'remote', 'add', 'origin', remote)).code).toBe(0);
	mkdirSync(join(A, 'notes'), { recursive: true });
	mkdirSync(join(A, 'audio'), { recursive: true });
	writeFileSync(join(A, 'notes', 'a.md'), '---\ntitle: A\n---\n');
	const first = randomBytes(2048);
	writeFileSync(join(A, 'audio', 'first.bin'), first);

	// The first sync's fetch, LFS upload, and push, under the device grant.
	let from = requests.length;
	ok(await epicenter('sync', A));
	expect(carried(from, 'device')).toEqual(
		expect.arrayContaining([
			'GET /info/refs',
			'POST /info/lfs/objects/batch',
			'PUT /info/lfs/objects/<oid>',
			'POST /git-receive-pack',
		]),
	);
	expect(carried(from, 'desktop')).toEqual([]);

	// Clone and its LFS download, under the desktop grant.
	from = requests.length;
	ok(await epicenter('clone', `${NAMESPACE}/notes`, B, '--desktop'));
	expect(new Uint8Array(readFileSync(join(B, 'audio', 'first.bin')))).toEqual(
		new Uint8Array(first),
	);
	expect(await credentialKeys(B)).toBe('');
	expect(carried(from, 'desktop')).toEqual(
		expect.arrayContaining([
			'GET /info/refs',
			'POST /git-upload-pack',
			'POST /info/lfs/objects/batch',
			'GET /info/lfs/objects/<oid>',
		]),
	);
	expect(carried(from, 'device')).toEqual([]);

	// A later fetch and its LFS download, under the desktop grant.
	const second = randomBytes(2048);
	writeFileSync(join(A, 'audio', 'second.bin'), second);
	ok(await epicenter('sync', A));
	from = requests.length;
	ok(await epicenter('sync', B, '--desktop'));
	expect(new Uint8Array(readFileSync(join(B, 'audio', 'second.bin')))).toEqual(
		new Uint8Array(second),
	);
	expect(carried(from, 'desktop')).toEqual(
		expect.arrayContaining([
			'POST /git-upload-pack',
			'GET /info/lfs/objects/<oid>',
		]),
	);
	expect(carried(from, 'device')).toEqual([]);

	// No request went without a token, and no token was in an argument or the output.
	expect(requests.filter((request) => request.grant === 'none')).toEqual([]);
	expect(existsSync(ARGV_LOG)).toBe(true);
	const argv = readFileSync(ARGV_LOG, 'utf8');
	expect(argv).toContain('clone');
	for (const token of Object.values(TOKENS)) {
		expect(argv).not.toContain(token);
		for (const output of outputs) expect(output).not.toContain(token);
	}
}, 120_000);
