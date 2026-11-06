/**
 * The file contract's server half end to end on Bun (phase 4): the real
 * authorization server on a disposable Postgres, a `Bun.serve` listener, the
 * disk Git and LFS stores, web captures through a folder's `commits`, and stock
 * `git` plus `git-lfs` in a sandbox (`HOME`, `GIT_CONFIG_GLOBAL`,
 * `GIT_CEILING_DIRECTORIES`) as the desktop. Requires initdb, pg_ctl, git
 * and git-lfs on PATH; never connects to a configured database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY_ATTRIBUTES } from '@epicenter/definition/contract';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { type Client, Pool } from 'pg';
import { registerFirstPartyClients } from '../auth/oauth-registrations.js';
import { createCloudContextMiddleware } from '../create-cloud-context-middleware.js';
import { createDb } from '../db/create-db.js';
import { createDiskGitHost } from '../git-disk-store.js';
import { createDiskLfsStore } from '../lfs/disk-lfs-store.js';
import { createServerApp } from '../server-app.js';
import { startDisposablePostgres } from '../test-helpers/disposable-postgres.js';
import { OAuthTestClient, type Person } from '../test-helpers/oauth-client.js';
import {
	createGitSandbox,
	type GitSandbox,
} from '../test-helpers/sandbox-git.js';
import type { CloudEnv } from '../types.js';
import { mountAuthRoutes } from './auth.js';
import { mountGitHost } from './git.js';

/** What a commit answers: its id and the blob at each path. */
type Receipt = { commit: string; blobs: Record<string, string | null> };

const secret = 'contract-e2e-secret-0123456789abcdefghij';
const recorder = {
	clientId: 'so.epicenter.recorder',
	redirectUri: 'https://recorder.example.test/auth/callback',
};

let origin = '';
let audiences = { api: '', git: '' };
let box: GitSandbox;
let stopPostgres: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let sql: Client;
let pool: Pool;
let client: OAuthTestClient;
let maker: { person: Person; token: string };
let member: { person: Person; token: string };
/** The folder the maker shares with the member, attached to the recorder. */
let shared: string;

beforeAll(async () => {
	box = await createGitSandbox(
		'[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n[lfs]\n\tlocksverify = false\n[pull]\n\trebase = false\n',
	);
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
				clientId: recorder.clientId,
				name: 'Recorder',
				redirectUris: [recorder.redirectUri],
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
	const host = createDiskGitHost({ root: join(box.root, 'git-store') });
	const lfs = createDiskLfsStore({ root: join(box.root, 'lfs-store') });
	mountGitHost(app, {
		setup: createCloudContextMiddleware(context),
		resolveHost: () => host,
		resolveLfs: () => lfs,
	});
	client = new OAuthTestClient(origin, sql, secret, async (url, init) =>
		app.fetch(new Request(url, init)),
	);
	const signedIn = async (label: string) => {
		const person = await client.person(label);
		const tokens = await client.codeGrant({
			...recorder,
			cookie: person.cookie,
			resource: [audiences.git],
			scope: 'openid folders:read folders:write',
		});
		return { person, token: tokens.access_token };
	};
	maker = await signedIn('maker');
	member = await signedIn('member');
	const json = (token: string, method: string, body?: unknown) => ({
		method,
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	// The recorder's first sync makes its folder; the maker shares it, and the
	// member accepts.
	const made = await fetch(
		`${audiences.git}/folders`,
		json(maker.token, 'POST', {}),
	);
	shared = ((await made.json()) as { folder: string }).folder;
	const invited = await fetch(
		`${origin}/api/folders/${shared}/members/${encodeURIComponent(member.person.email)}`,
		json(maker.token, 'PUT', { role: 'member' }),
	);
	if (invited.status !== 200) throw new Error(await invited.text());
	const accepted = await fetch(
		`${origin}/api/folders/${shared}/accept`,
		json(member.token, 'POST'),
	);
	if (accepted.status !== 200) throw new Error(await accepted.text());
}, 120_000);

afterAll(async () => {
	server?.stop(true);
	await pool?.end();
	await stopPostgres?.();
	if (box) await rm(box.root, { recursive: true, force: true });
});

type LfsAnswer = {
	authenticated?: boolean;
	actions?: Record<'upload', { href: string }>;
};

const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

/**
 * A web client of one folder: every request with the account's token, the
 * sync routes at its id, and Git LFS at its Git remote.
 */
function webClient(token: string, folder: string) {
	const repo = `${audiences.git}/folders/${folder}.git`;
	const auth = { authorization: `Bearer ${token}` };
	const folderOf = async () => folder;
	return {
		repo,
		folderOf,
		async upload(bytes: Uint8Array) {
			const object = { oid: sha256(bytes), size: bytes.length };
			const batch = await fetch(`${repo}/info/lfs/objects/batch`, {
				method: 'POST',
				headers: {
					...auth,
					accept: 'application/vnd.git-lfs+json',
					'content-type': 'application/vnd.git-lfs+json',
				},
				body: JSON.stringify({
					operation: 'upload',
					transfers: ['basic'],
					objects: [object],
				}),
			});
			expect(batch.status).toBe(200);
			const [answer] = ((await batch.json()) as { objects: LfsAnswer[] })
				.objects;
			if (answer?.actions) {
				// The server's own route: git lfs must send the remote's credential.
				expect(answer.authenticated).toBeUndefined();
				const put = await fetch(answer.actions.upload.href, {
					method: 'PUT',
					headers: auth,
					body: bytes as BodyInit,
				});
				expect(put.status).toBe(200);
				const verify = await fetch(`${repo}/info/lfs/verify`, {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/vnd.git-lfs+json' },
					body: JSON.stringify(object),
				});
				expect(verify.status).toBe(200);
			}
			return object;
		},
		/** One commit of `files`, each over the blob it expects. */
		async write(body: { files: unknown[] }) {
			const response = await fetch(
				`${audiences.git}/folders/${await folderOf()}/commits`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				},
			);
			return {
				status: response.status,
				body: (await response.json()) as Receipt & { error?: string },
			};
		},
		/** The blob at `path` on main, and its text. */
		async read(path: string) {
			const base = `${audiences.git}/folders/${await folderOf()}`;
			const { commit } = (await (
				await fetch(`${base}/changes`, { headers: auth })
			).json()) as { commit: string };
			const tree = (await (
				await fetch(`${base}/tree`, {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ commit, paths: [path] }),
				})
			).json()) as {
				entries: { blob: string; oid?: string; size?: number }[];
			};
			const entry = tree.entries[0];
			const blob = entry?.blob as string;
			const lfs =
				entry?.oid === undefined
					? undefined
					: { oid: entry.oid, size: entry.size as number };
			const { blobs } = (await (
				await fetch(`${base}/blobs`, {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ ids: [blob] }),
				})
			).json()) as { blobs: string[] };
			return {
				blob,
				text: Buffer.from(blobs[0] ?? '', 'base64').toString(),
				lfs,
			};
		},
	};
}

/** A desktop clone through stock git, with the token on every Git and LFS request. */
async function desktop(token: string, url: string) {
	const dir = await box.dir('desktop');
	const header = `http.${audiences.git}/.extraHeader=Authorization: Bearer ${token}`;
	const cloned = await box.git(
		box.root,
		['-c', header, 'clone', '--quiet', url, dir],
		undefined,
	);
	expect(cloned.code).toBe(0);
	await box.ok(dir, [
		'config',
		`http.${audiences.git}/.extraHeader`,
		`Authorization: Bearer ${token}`,
	]);
	await box.ok(dir, ['lfs', 'install', '--local']);
	return dir;
}

const capture = (id: string, audio: { oid: string; size: number }) => ({
	files: [
		{
			path: `recordings/${id}.md`,
			expect: null,
			text: `---\ntitle: Recording ${id}\nrecordedAt: '2026-10-30T22:00:00Z'\n---\nTranscript ${id}.\n`,
		},
		{ path: `recordings/${id}.webm`, expect: null, lfs: audio },
	],
});

describe('the file contract on the local server', () => {
	const audio = randomBytes(300_000);
	let web: ReturnType<typeof webClient>;
	let first: Receipt;

	test('a web capture (note plus audio) is one commit, and a resend has moved, landing nothing', async () => {
		web = webClient(maker.token, shared);
		const before = await web.write(
			capture('a', { oid: sha256(audio), size: audio.length }),
		);
		expect(before.status).toBe(409);
		const object = await web.upload(audio);
		const landed = await web.write(capture('a', object));
		expect(landed.status).toBe(200);
		expect(Object.keys(landed.body.blobs)).toEqual([
			'recordings/a.md',
			'recordings/a.webm',
		]);
		first = landed.body;
		const resent = await web.write(capture('a', object));
		expect(resent).toMatchObject({
			status: 409,
			body: { error: 'moved', path: 'recordings/a.md' },
		});
		expect((await web.read('recordings/a.md')).blob).toBe(
			first.blobs['recordings/a.md'] as string,
		);
	}, 60_000);

	test('a desktop clone through stock git gets the audio byte for byte with git lfs pull, and fetches over protocol v2', async () => {
		const dir = await desktop(member.token, web.repo);
		await box.ok(dir, ['lfs', 'pull']);
		const pulled = await readFile(join(dir, 'recordings/a.webm'));
		expect(sha256(pulled)).toBe(sha256(audio));
		// The server wrote the standard attributes in the first commit (decision 59).
		expect(await Bun.file(join(dir, '.gitattributes')).text()).toBe(
			REPOSITORY_ATTRIBUTES,
		);
		expect(
			(
				await box.ok(dir, ['log', '--format=%s', '--', '.gitattributes'])
			).trim(),
		).toBe('Sync: 2 files');
		expect(
			(
				await box.ok(dir, [
					'log',
					'--format=%s',
					'--',
					'recordings/a.md',
					'recordings/a.webm',
				])
			).trim(),
		).toBe('Sync: 2 files');
		expect(await box.ok(dir, ['fsck', '--strict'])).toBe('');
		// Nothing is hidden from a client, so no protocol is forced: a fetch
		// asks for v2 and gets it.
		const trace = join(box.root, 'fetch-trace');
		const fetched = Bun.spawn(
			['git', '-c', 'protocol.version=2', 'fetch', 'origin'],
			{ cwd: dir, env: { ...box.env, GIT_TRACE_PACKET: trace } },
		);
		expect(await fetched.exited).toBe(0);
		const packets = await Bun.file(trace).text();
		expect(packets).toContain('fetch< version 2');
		expect(packets).toContain('fetch> command=ls-refs');
		expect(packets).toMatch(/fetch< [0-9a-f]{40} refs\/heads\/main/);
	}, 60_000);

	test('racing commits over one blob: one lands, the rest have moved, and nothing merges', async () => {
		const lines = Array.from({ length: 6 }, (_, i) => `line ${i}`);
		const base = `---\ntitle: Shared\n---\n${lines.join('\n')}\n`;
		const seeded = await web.write({
			files: [{ path: 'notes/shared.md', expect: null, text: base }],
		});
		const baseBlob = seeded.body.blobs['notes/shared.md'];
		const before = Number(
			(
				await box.ok(box.root, [
					'--git-dir',
					await gitDirOf(),
					'rev-list',
					'--count',
					'main',
				])
			).trim(),
		);
		const writes = await Promise.all(
			lines.map((_, i) => {
				const mine = [...lines];
				mine[i] = `line ${i} edited by writer ${i}`;
				return web.write({
					files: [
						{
							path: 'notes/shared.md',
							expect: baseBlob,
							text: `---\ntitle: Shared\nw${i}: yes\n---\n${mine.join('\n')}\n`,
						},
					],
				});
			}),
		);
		expect(writes.map((w) => w.status).sort()).toEqual([
			200, 409, 409, 409, 409, 409,
		]);
		for (const refused of writes.filter((w) => w.status === 409))
			expect(refused.body.error).toBe('moved');
		const winner = writes.findIndex((w) => w.status === 200);
		const final = (await web.read('notes/shared.md')).text as string;
		for (let i = 0; i < lines.length; i++)
			expect(final.includes(`line ${i} edited by writer ${i}`)).toBe(
				i === winner,
			);
		expect(final).not.toContain('<<<<<<<');
		const gitDir = await gitDirOf();
		expect(
			(
				await box.ok(box.root, [
					'--git-dir',
					gitDir,
					'rev-list',
					'--merges',
					'--count',
					'main',
				])
			).trim(),
		).toBe('0');
		expect(
			Number(
				(
					await box.ok(box.root, [
						'--git-dir',
						gitDir,
						'rev-list',
						'--count',
						'main',
					])
				).trim(),
			),
		).toBe(before + 1);
	}, 60_000);

	test('raw audio is refused, also after a .gitattributes edit; an LFS push and a raw hidden file land', async () => {
		const dir = await desktop(member.token, web.repo);
		const raw = randomBytes(50_000);
		const noFilter = [
			'-c',
			'filter.lfs.clean=',
			'-c',
			'filter.lfs.smudge=',
			'-c',
			'filter.lfs.process=',
			'-c',
			'filter.lfs.required=false',
		];
		await box.write(dir, { 'recordings/raw.webm': raw });
		await box.ok(dir, [...noFilter, 'add', 'recordings/raw.webm']);
		await box.ok(dir, [...noFilter, 'commit', '--quiet', '-m', 'raw audio']);
		const refused = await box.git(dir, [
			...noFilter,
			'push',
			'--no-verify',
			'origin',
			'HEAD:main',
		]);
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain('recordings/raw.webm in');
		expect(refused.stderr).toContain('is not a canonical Git LFS pointer');

		await box.ok(dir, ['reset', '--quiet', '--hard', 'origin/main']);
		await box.write(dir, {
			'.gitattributes': '# LFS removed\n',
			'recordings/raw2.webm': raw,
		});
		await box.ok(dir, ['add', '.gitattributes', 'recordings/raw2.webm']);
		expect(
			await box.ok(dir, ['check-attr', 'filter', 'recordings/raw2.webm']),
		).toContain('unspecified');
		await box.ok(dir, ['commit', '--quiet', '-m', 'drop LFS']);
		const stillRefused = await box.git(dir, [
			'push',
			'--no-verify',
			'origin',
			'HEAD:main',
		]);
		expect(stillRefused.code).not.toBe(0);
		expect(stillRefused.stderr).toContain('recordings/raw2.webm in');

		await box.ok(dir, ['reset', '--quiet', '--hard', 'origin/main']);
		const desk = randomBytes(80_000);
		await box.write(dir, {
			'recordings/desk.webm': desk,
			'recordings/desk.md': '---\ntitle: Desk\n---\n',
		});
		await box.ok(dir, ['add', 'recordings']);
		await box.ok(dir, ['commit', '--quiet', '-m', 'desktop recording']);
		expect(
			await box.ok(dir, ['cat-file', '-p', 'HEAD:recordings/desk.webm']),
		).toContain(sha256(desk));
		const pushed = await box.git(dir, ['push', 'origin', 'HEAD:main']);
		expect(pushed.code).toBe(0);
		expect((await web.read('recordings/desk.webm')).lfs).toEqual({
			oid: sha256(desk),
			size: desk.length,
		});

		// A hidden path is outside the contract: Finder's .DS_Store lands raw (decision 58).
		await box.write(dir, { 'recordings/.DS_Store': randomBytes(4096) });
		await box.ok(dir, ['add', 'recordings/.DS_Store']);
		expect(
			await box.ok(dir, ['check-attr', 'filter', 'recordings/.DS_Store']),
		).toBe('recordings/.DS_Store: filter: unspecified\n');
		await box.ok(dir, ['commit', '--quiet', '-m', 'finder']);
		const hidden = await box.git(dir, ['push', 'origin', 'HEAD:main']);
		expect(hidden.code).toBe(0);
	}, 120_000);

	test('a clone that authenticates through a credential helper pushes its LFS objects', async () => {
		// No extraHeader: git and git lfs ask the helper, as with Epicenter's own.
		const tokenFile = join(box.root, 'helper-token');
		await writeFile(tokenFile, member.token);
		const helper = `!f() { test "$1" = get && printf 'username=x\\npassword=%s\\n' "$(cat '${tokenFile}')"; }; f`;
		const dir = await box.dir('helper-desktop');
		const cloned = await box.git(
			box.root,
			['-c', `credential.helper=${helper}`, 'clone', '--quiet', web.repo, dir],
			undefined,
		);
		expect(cloned.code).toBe(0);
		await box.ok(dir, ['config', 'credential.helper', helper]);
		await box.ok(dir, ['lfs', 'install', '--local']);
		const audio = randomBytes(60_000);
		await box.write(dir, {
			'recordings/helper.webm': audio,
			'recordings/helper.md': '---\ntitle: Helper\n---\n',
		});
		await box.ok(dir, ['add', 'recordings']);
		await box.ok(dir, [
			'commit',
			'--quiet',
			'-m',
			'recording through a helper',
		]);
		const pushed = await box.git(dir, ['push', 'origin', 'HEAD:main']);
		expect(pushed.stderr).not.toContain('Authorization error');
		expect(pushed.code).toBe(0);
		expect((await web.read('recordings/helper.webm')).lfs).toEqual({
			oid: sha256(audio),
			size: audio.length,
		});
	}, 60_000);

	test("a member's force-push lands and keeps the old main, though another member made the folder", async () => {
		// The tip is a capture, which the member's rewrite then drops.
		const object = await web.upload(randomBytes(1000));
		const tipCapture = await web.write(capture('b', object));
		expect(tipCapture.status).toBe(200);
		const memberDir = await desktop(member.token, web.repo);
		const old = (await box.ok(memberDir, ['rev-parse', 'HEAD'])).trim();
		expect(old).toBe(tipCapture.body.commit);
		const rewritten = await box.git(memberDir, [
			'push',
			'--force',
			'origin',
			'HEAD~1:main',
		]);
		expect(rewritten.code).toBe(0);
		const refs = await box.ok(memberDir, ['ls-remote', 'origin']);
		expect(refs).toMatch(
			new RegExp(`^${old}\\trefs/epicenter/replaced/\\d{8}-\\d{9}Z$`, 'm'),
		);

		// The rewrite dropped capture b: a resend lands it again.
		const resent = await web.write(capture('b', object));
		expect(resent.status).toBe(200);
		expect((await web.read('recordings/b.md')).blob).toBe(
			tipCapture.body.blobs['recordings/b.md'] as string,
		);
		// Capture a is still on main, so its resend is refused.
		const again = await web.write(
			capture('a', { oid: sha256(audio), size: audio.length }),
		);
		expect(again).toMatchObject({ status: 409, body: { error: 'moved' } });
		expect((await web.read('recordings/a.md')).blob).toBe(
			first.blobs['recordings/a.md'] as string,
		);
	}, 120_000);

	test('a commit body past the cap is refused before it is read whole, and nothing moves', async () => {
		const main = (
			await box.ok(box.root, [
				'--git-dir',
				await gitDirOf(),
				'rev-parse',
				'main',
			])
		).trim();
		const huge = await web.write({
			files: [
				{
					path: 'notes/huge.md',
					expect: null,
					text: 'x'.repeat(17 * 1024 * 1024),
				},
			],
		});
		expect(huge.status).toBe(413);
		expect(huge.body.error).toBe('too_large');
		expect(
			(
				await box.ok(box.root, [
					'--git-dir',
					await gitDirOf(),
					'rev-parse',
					'main',
				])
			).trim(),
		).toBe(main);
	}, 60_000);
});

/** The shared folder's bare repository on the server. */
async function gitDirOf() {
	return join(box.root, 'git-store', `${shared}.git`);
}
