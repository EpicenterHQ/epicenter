/**
 * The folder MCP server (ADR-0550) end to end on Bun: the real routes behind
 * the real authorization server on a disposable Postgres cluster, a real
 * `Bun.serve` listener, the disk store, the MCP SDK's own client, and the
 * system `git` to put folders in place and to see what a write committed.
 * Requires initdb, pg_ctl, and git on PATH; never connects to a configured
 * database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
	OAuthClientInformationMixed,
	OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import { registerFirstPartyClients } from '../auth/oauth-registrations.js';
import { createCloudContextMiddleware } from '../create-cloud-context-middleware.js';
import { createDb, type Db } from '../db/create-db.js';
import { createDiskGitHost } from '../git-disk-store.js';
import { createServerApp } from '../server-app.js';
import { startDisposablePostgres } from '../test-helpers/disposable-postgres.js';
import {
	OAuthTestClient,
	type Person,
	pkce,
} from '../test-helpers/oauth-client.js';
import type { CloudEnv } from '../types.js';
import { mountAuthRoutes } from './auth.js';
import { mountGitHost } from './git.js';
import { mountMcpServer } from './mcp.js';

const secret = 'mcp-postgres-secret-0123456789abcdefghij';
const todos = {
	clientId: 'so.epicenter.todos',
	redirectUri: 'https://todos.example.test/auth/callback',
};
/** A first-party test client that reaches MCP and skips consent, so its target is `*`. */
const agent = {
	clientId: 'test.mcp-agent',
	redirectUri: 'http://127.0.0.1:53444/callback',
};

// A third-party client identified by its metadata document, served locally:
// the real transports refuse loopback addresses, so this one maps a
// public-looking host to the local server.
const CIMD_CLIENT_ID = 'https://cimd.example.test/client.json';
const CIMD_REDIRECT = 'http://127.0.0.1:53999/callback';
const cimdServer = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	fetch(request) {
		if (new URL(request.url).pathname !== '/client.json')
			return new Response('not found', { status: 404 });
		return Response.json({
			client_id: CIMD_CLIENT_ID,
			client_name: 'Example MCP Client',
			client_uri: 'https://cimd.example.test',
			redirect_uris: [CIMD_REDIRECT],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			scope: 'openid offline_access folders:read folders:write',
		});
	},
});
const testMetadataFetch: ClientMetadataResourceFetch = (input, init) => {
	const url = new URL(
		typeof input === 'string' || input instanceof URL ? input : input.url,
	);
	if (url.host !== 'cimd.example.test')
		throw new Error(`metadata host not allowed: ${url.host}`);
	return fetch(new URL(url.pathname, cimdServer.url), {
		...init,
		redirect: 'manual',
	});
};

let origin = '';
let audiences = { api: '', git: '', mcp: '' };
let scratch: string;
let stopPostgres: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let sql: Client;
let db: Db;
let client: OAuthTestClient;

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), 'epicenter-mcp-test-'));
	const cluster = await startDisposablePostgres();
	stopPostgres = cluster.stop;
	sql = cluster.clients[0];
	db = createDb(sql);
	await migrate(db, {
		migrationsFolder: fileURLToPath(
			new URL('../../../../apps/api/drizzle/', import.meta.url),
		),
	});
	const app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => [origin],
	});
	server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch: (request) => app.fetch(request),
		idleTimeout: 30,
	});
	origin = `http://127.0.0.1:${server.port}`;
	audiences = { api: origin, git: `${origin}/git`, mcp: `${origin}/mcp` };
	await registerFirstPartyClients(db, {
		audiences,
		clients: [
			{
				clientId: todos.clientId,
				name: 'Todos',
				redirectUris: [todos.redirectUri],
				grantTypes: ['authorization_code'],
				scopes: ['openid', 'profile', 'folders:read', 'folders:write'],
				resources: [audiences.api, audiences.git],
				skipConsent: true,
				applicationType: 'web',
			},
			{
				clientId: agent.clientId,
				name: 'Test Agent',
				redirectUris: [agent.redirectUri],
				grantTypes: ['authorization_code'],
				scopes: ['openid', 'folders:read', 'folders:write'],
				resources: [audiences.mcp],
				skipConsent: true,
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
			resolveOAuthServer: () => ({
				audiences,
				clientMetadataFetch: testMetadataFetch,
			}),
		}),
		serveAuthUiShell: (c) => c.html('<html>shell</html>'),
		resolveAudiences: () => audiences,
	});
	const host = createDiskGitHost({ root: join(scratch, 'store') });
	const setup = createCloudContextMiddleware(context);
	mountGitHost(app, {
		setup,
		resolveAudiences: () => audiences,
		resolveHost: () => host,
	});
	mountMcpServer(app, {
		setup,
		resolveAudiences: () => audiences,
		resolveHost: () => host,
	});
	client = new OAuthTestClient(origin, sql, secret, async (url, init) =>
		app.fetch(new Request(url, init)),
	);
}, 60_000);

afterAll(async () => {
	server?.stop(true);
	cimdServer.stop(true);
	await stopPostgres?.();
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** An access token for `person` from a first-party client that skips consent. */
async function tokenFor(
	person: Person,
	{
		resource = audiences.mcp,
		scope = 'openid folders:read folders:write',
	}: { resource?: string; scope?: string } = {},
) {
	const app = resource === audiences.mcp ? agent : todos;
	const tokens = await client.codeGrant({
		...app,
		cookie: person.cookie,
		resource: [resource],
		scope,
	});
	return tokens.access_token;
}

type Run = { code: number; stdout: string; stderr: string };

/** The system `git`, in a clean environment, sending `token` as a Bearer header. */
async function git(
	cwd: string,
	token: string | null,
	...args: string[]
): Promise<Run> {
	const child = Bun.spawn(
		[
			'git',
			'-c',
			'core.hooksPath=/dev/null',
			...(token === null
				? []
				: ['-c', `http.extraHeader=Authorization: Bearer ${token}`]),
			...args,
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: scratch,
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_TERMINAL_PROMPT: '0',
				GIT_AUTHOR_NAME: 'Device',
				GIT_AUTHOR_EMAIL: 'device@example.test',
				GIT_COMMITTER_NAME: 'Device',
				GIT_COMMITTER_EMAIL: 'device@example.test',
			},
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
}

const remote = (namespace: string, name: string) =>
	`${audiences.git}/${namespace}/${name}.git`;

/** Push a folder holding `files` to `<namespace>/<name>`, as a device would. */
async function pushFolder(
	person: Person,
	namespace: string,
	name: string,
	files: Record<string, string | Uint8Array>,
) {
	const dir = join(scratch, `${name}-${crypto.randomUUID().slice(0, 8)}`);
	await mkdir(dir, { recursive: true });
	await git(dir, null, 'init', '--quiet', '--initial-branch=main');
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(dir, path, '..'), { recursive: true });
		await writeFile(join(dir, path), content);
	}
	await git(dir, null, 'add', '--all');
	expect((await git(dir, null, 'commit', '--quiet', '-m', 'first')).code).toBe(
		0,
	);
	const token = await tokenFor(person, { resource: audiences.git });
	const pushed = await git(
		dir,
		token,
		'push',
		remote(namespace, name),
		'HEAD:main',
	);
	expect(pushed.code).toBe(0);
	return (await git(dir, null, 'rev-parse', 'HEAD')).stdout.trim();
}

/** One raw JSON-RPC POST to the MCP endpoint. */
function post(token: string | null, message: object) {
	return fetch(audiences.mcp, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }),
	});
}

const initialize = {
	method: 'initialize',
	params: {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'probe', version: '0' },
	},
};

/** An MCP SDK client holding `token` as a static Bearer header. */
async function connect(token: string) {
	const mcp = new McpClient({ name: 'test', version: '0' });
	await mcp.connect(
		new StreamableHTTPClientTransport(new URL(audiences.mcp), {
			requestInit: { headers: { authorization: `Bearer ${token}` } },
		}),
	);
	return mcp;
}

/** Call `name` and answer its structured content, or its text when it refused. */
async function call(
	mcp: McpClient,
	name: string,
	args: Record<string, unknown> = {},
) {
	const result = (await mcp.callTool({
		name,
		arguments: args,
	})) as CallToolResult;
	const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
	return result.isError
		? { error: text }
		: (result.structuredContent as Record<string, unknown>);
}

describe('authorization', () => {
	test('no token is 401 with the resource metadata, which names the authorization server', async () => {
		const refused = await post(null, initialize);
		expect(refused.status).toBe(401);
		const challenge = refused.headers.get('www-authenticate') ?? '';
		expect(challenge).toContain(
			`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
		);
		const metadata = await fetch(
			`${origin}/.well-known/oauth-protected-resource/mcp`,
		);
		expect((await metadata.json()) as object).toEqual({
			resource: audiences.mcp,
			authorization_servers: [`${origin}/auth`],
			scopes_supported: ['folders:read', 'folders:write'],
			bearer_methods_supported: ['header'],
		});
		expect((await fetch(audiences.mcp)).status).toBe(405);
	});

	test("another audience's token is 401", async () => {
		const person = await client.person('wrong-audience');
		const gitToken = await tokenFor(person, { resource: audiences.git });
		const refused = await post(gitToken, initialize);
		expect(refused.status).toBe(401);
		expect(await refused.json()).toMatchObject({ error: 'invalid_token' });
	});

	test('a read-only token reads, and writing is 403 naming both scopes', async () => {
		const person = await client.person('reader');
		const head = await pushFolder(person, person.personal, 'notes', {
			'a.md': 'one\n',
		});
		const token = await tokenFor(person, { scope: 'openid folders:read' });
		const mcp = await connect(token);
		expect(
			await call(mcp, 'read_files', {
				namespace: person.personal,
				name: 'notes',
				paths: ['a.md'],
			}),
		).toMatchObject({
			commit: head,
			files: [{ path: 'a.md', content: 'one\n' }],
		});
		await mcp.close();

		const refused = await post(token, {
			method: 'tools/call',
			params: {
				name: 'write_files',
				arguments: {
					namespace: person.personal,
					name: 'notes',
					base: head,
					message: 'nope',
					changes: [{ path: 'a.md', content: 'two\n' }],
				},
			},
		});
		expect(refused.status).toBe(403);
		expect(refused.headers.get('www-authenticate')).toBe(
			`Bearer error="insufficient_scope", scope="folders:read folders:write", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
		);
	});

	test("a namespace outside the grant's target is the tool's refusal, and is not listed", async () => {
		const person = await client.person('target');
		const group = await client.group(person, 'Family', 'owner');
		await pushFolder(person, person.personal, 'mine', { 'a.md': 'mine\n' });
		await pushFolder(person, group, 'shared', { 'b.md': 'shared\n' });
		const tokens = await consentedTokens(person, `ns:${person.personal}`);
		const mcp = await connect(tokens.access_token);
		expect(await call(mcp, 'list_folders')).toEqual({
			groups: [
				{
					title: 'Personal',
					namespace: person.personal,
					role: 'owner',
					folders: [
						{
							namespace: person.personal,
							name: 'mine',
							url: remote(person.personal, 'mine'),
						},
					],
				},
			],
		});
		expect(
			await call(mcp, 'describe_folder', { namespace: group, name: 'shared' }),
		).toEqual({ error: "That namespace is outside this grant's folders." });
		await mcp.close();
	});
});

/** Consent for the metadata-document client, with `target`, then its tokens. */
async function consentedTokens(person: Person, target: string) {
	const { verifier, challenge } = await pkce();
	const authorized = await client.authorize({
		clientId: CIMD_CLIENT_ID,
		redirectUri: CIMD_REDIRECT,
		cookie: person.cookie,
		challenge,
		resource: [audiences.mcp],
		scope: 'offline_access folders:read folders:write',
	});
	const consentPage = new URL(authorized.location, origin);
	expect(consentPage.pathname).toBe('/consent');
	await client.selectTarget(person.cookie, target, {
		clientId: CIMD_CLIENT_ID,
	});
	const consented = await client.consent(
		person.cookie,
		consentPage.search.slice(1),
	);
	const code = new URL(consented.body.url ?? '').searchParams.get('code');
	if (code === null) throw new Error('consent gave no code');
	return client.exchange({
		clientId: CIMD_CLIENT_ID,
		redirectUri: CIMD_REDIRECT,
		code,
		verifier,
		resource: [audiences.mcp],
	});
}

describe('tools', () => {
	test('describe, list, read, history, and a write that must name the head', async () => {
		const person = await client.person('tools');
		const lfs =
			'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n';
		const head = await pushFolder(person, person.personal, 'books', {
			'epicenter.json': '{ "tables": { "books": {} } }\n',
			'books/dune.md': '---\ntitle: Dune\n---\n',
			'books/emma.md': '---\ntitle: Emma\n---\n',
			'covers/dune.jpg': lfs,
			'raw.bin': new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
		});
		const mcp = await connect(await tokenFor(person));
		const folder = { namespace: person.personal, name: 'books' };

		expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual([
			'list_folders',
			'describe_folder',
			'list_files',
			'read_files',
			'write_files',
			'history',
		]);
		expect(await call(mcp, 'describe_folder', folder)).toEqual({
			...folder,
			commit: head,
			branch: 'main',
			fileCount: 5,
			declaration: { tables: { books: {} } },
		});
		expect(
			await call(mcp, 'list_files', { ...folder, prefix: 'books' }),
		).toEqual({
			...folder,
			commit: head,
			paths: ['books/dune.md', 'books/emma.md'],
		});
		expect(
			await call(mcp, 'read_files', {
				...folder,
				paths: ['books/dune.md', 'covers/dune.jpg', 'raw.bin', 'missing.md'],
			}),
		).toEqual({
			...folder,
			commit: head,
			files: [
				{ path: 'books/dune.md', content: '---\ntitle: Dune\n---\n' },
				{
					path: 'covers/dune.jpg',
					lfs: {
						oid: 'sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393',
						size: 12345,
					},
					pointer: lfs,
				},
				{ path: 'raw.bin', binary: true, size: 4 },
				{ path: 'missing.md', missing: true },
			],
		});

		const written = await call(mcp, 'write_files', {
			...folder,
			base: head,
			message: 'Add Middlemarch, drop Emma',
			changes: [
				{
					path: 'books/middlemarch.md',
					content: '---\ntitle: Middlemarch\n---\n',
				},
				{ path: 'books/emma.md', delete: true },
			],
		});
		expect(written).toMatchObject(folder);
		const next = written.commit as string;
		expect(next).toMatch(/^[0-9a-f]{40}$/);

		// The old base is refused, naming the head it must write on.
		expect(
			await call(mcp, 'write_files', {
				...folder,
				base: head,
				message: 'stale',
				changes: [{ path: 'x.md', content: 'x\n' }],
			}),
		).toEqual({
			error: `The base ${head} is not the current head ${next}. Read again, then write again.`,
		});
		// A path outside the folder is refused.
		expect(
			await call(mcp, 'write_files', {
				...folder,
				base: next,
				message: 'escape',
				changes: [{ path: '../x.md', content: 'x\n' }],
			}),
		).toMatchObject({ error: expect.stringContaining('is not a file path') });

		const history = await call(mcp, 'history', {
			...folder,
			path: 'books/emma.md',
		});
		expect(
			(history.commits as { commit: string; message: string }[]).map(
				({ commit, message }) => [commit, message],
			),
		).toEqual([
			[next, 'Add Middlemarch, drop Emma'],
			[head, 'first'],
		]);
		expect(
			await call(mcp, 'list_files', {
				...folder,
				prefix: 'books',
				commit: head,
			}),
		).toMatchObject({
			commit: head,
			paths: ['books/dune.md', 'books/emma.md'],
		});
		expect(
			await call(mcp, 'describe_folder', {
				namespace: person.personal,
				name: 'absent',
			}),
		).toEqual({ error: `No folder is named ${person.personal}/absent.` });
		await mcp.close();
	}, 60_000);
});

/**
 * An `OAuthClientProvider` for the metadata-document client, as Claude or
 * ChatGPT would hold one, whose browser is the test: it signs in as `person`,
 * picks `target` on the consent page, and approves.
 */
function consentingProvider(person: Person, target: string) {
	let tokens: OAuthTokens | undefined;
	let information: OAuthClientInformationMixed | undefined;
	let verifier = '';
	const state = { code: null as string | null };
	const provider: OAuthClientProvider = {
		redirectUrl: CIMD_REDIRECT,
		clientMetadataUrl: CIMD_CLIENT_ID,
		clientMetadata: {
			redirect_uris: [CIMD_REDIRECT],
			client_name: 'Example MCP Client',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		},
		clientInformation: () => information,
		saveClientInformation: (saved) => {
			information = saved;
		},
		tokens: () => tokens,
		saveTokens: (saved) => {
			tokens = saved;
		},
		saveCodeVerifier: (saved) => {
			verifier = saved;
		},
		codeVerifier: () => verifier,
		async redirectToAuthorization(url) {
			const opened = await client.request(`${url.pathname}${url.search}`, {
				cookie: person.cookie,
			});
			const consentPage = new URL(opened.headers.get('location') ?? '', origin);
			expect(consentPage.pathname).toBe('/consent');
			await client.selectTarget(person.cookie, target, {
				clientId: CIMD_CLIENT_ID,
			});
			const consented = await client.consent(
				person.cookie,
				consentPage.search.slice(1),
			);
			state.code = new URL(consented.body.url ?? '').searchParams.get('code');
		},
	};
	return { provider, state };
}

describe('an MCP client end to end', () => {
	test('discovers, consents, lists, reads, and writes; a plain git clone shows the write', async () => {
		const person = await client.person('Ada');
		const head = await pushFolder(person, person.personal, 'journal', {
			'epicenter.json': '{}\n',
			'entries/monday.md': 'Rain.\n',
		});
		const { provider, state } = consentingProvider(
			person,
			`ns:${person.personal}`,
		);

		// The first connect meets the 401, follows `resource_metadata` to the
		// authorization server, and sends the person to consent.
		const first = new StreamableHTTPClientTransport(new URL(audiences.mcp), {
			authProvider: provider,
		});
		await expect(
			new McpClient({ name: 'example', version: '0' }).connect(first),
		).rejects.toThrow();
		expect(state.code).toBeString();
		await first.finishAuth(state.code as string);

		const mcp = new McpClient({ name: 'example', version: '0' });
		await mcp.connect(
			new StreamableHTTPClientTransport(new URL(audiences.mcp), {
				authProvider: provider,
			}),
		);
		const listed = await call(mcp, 'list_folders');
		expect(listed.groups).toEqual([
			expect.objectContaining({
				title: 'Personal',
				folders: [expect.objectContaining({ name: 'journal' })],
			}),
		]);
		const folder = { namespace: person.personal, name: 'journal' };
		const described = await call(mcp, 'describe_folder', folder);
		expect(described.commit).toBe(head);
		expect(
			await call(mcp, 'read_files', {
				...folder,
				paths: ['entries/monday.md'],
			}),
		).toMatchObject({ files: [{ content: 'Rain.\n' }] });
		const written = await call(mcp, 'write_files', {
			...folder,
			base: head,
			message: 'Add Tuesday',
			changes: [{ path: 'entries/tuesday.md', content: 'Sun.\n' }],
		});
		await mcp.close();

		const clone = join(scratch, `journal-${crypto.randomUUID().slice(0, 8)}`);
		const gitToken = await tokenFor(person, { resource: audiences.git });
		expect(
			(
				await git(
					scratch,
					gitToken,
					'clone',
					remote(person.personal, 'journal'),
					clone,
				)
			).code,
		).toBe(0);
		expect(await Bun.file(join(clone, 'entries/tuesday.md')).text()).toBe(
			'Sun.\n',
		);
		const logged = await git(
			clone,
			null,
			'log',
			'-1',
			'--format=%H%n%an <%ae>%n%s%n%P',
		);
		expect(logged.stdout.trim().split('\n')).toEqual([
			written.commit as string,
			`Ada via Example MCP Client <${person.email}>`,
			'Add Tuesday',
			head,
		]);
	}, 60_000);
});
