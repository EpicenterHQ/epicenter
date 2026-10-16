/**
 * The folder MCP server's code in workerd (ADR-0550): the SDK's web-standard
 * transport answers, and isomorphic-git builds and pushes a commit through a
 * `GitHost` in memory, so the Worker can run the same module the Bun entry
 * runs. The store here is a stand-in that speaks just enough smart HTTP; the
 * Artifacts store itself is not exercised.
 */
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import type { Db } from '../src/db/create-db.js';
import { openHostedRepository } from '../src/hosted-repository.js';
import type { GitHost } from '../src/routes/git.js';
import { mountMcpServer } from '../src/routes/mcp.js';
import type { CloudEnv } from '../src/types.js';

const origin = 'https://api.example.test';
const audiences = {
	api: origin,
	git: `${origin}/git`,
	mcp: `${origin}/mcp`,
};

function pkt(line: string) {
	return `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
}

/** An empty repository that accepts one push and keeps what it was sent. */
function emptyRepositoryHost() {
	const pushes: Uint8Array[] = [];
	const zero = '0'.repeat(40);
	const host: GitHost = {
		async create() {},
		async serve(_id, request) {
			if (request.advertisement)
				return new Response(
					`${pkt(`# service=${request.service}\n`)}0000${pkt(`${zero} capabilities^{}\0report-status side-band-64k ofs-delta\n`)}0000`,
					{
						headers: {
							'content-type': `application/x-${request.service}-advertisement`,
						},
					},
				);
			pushes.push(
				new Uint8Array(await new Response(request.body).arrayBuffer()),
			);
			return new Response(
				// isomorphic-git reads the report on side-band channel 1.
				`${pkt(`\u0001${pkt('unpack ok\n')}${pkt('ok refs/heads/main\n')}0000`)}0000`,
				{
					headers: { 'content-type': 'application/x-git-receive-pack-result' },
				},
			);
		},
	};
	return { host, pushes };
}

test('isomorphic-git commits and pushes through a GitHost in workerd', async () => {
	const { host, pushes } = emptyRepositoryHost();
	const repository = await openHostedRepository(host, {
		repositoryId: 'aaaaaaaaaaaaaaaa',
		accountId: 'account',
		signal: new AbortController().signal,
	});
	expect(repository.head).toBeNull();
	const written = await repository.commit({
		base: null,
		message: 'first',
		changes: [{ path: 'notes/a.md', content: 'one\n' }],
		author: { name: 'Ada via Example', email: 'ada@example.test' },
	});
	expect(written.error).toBeNull();
	expect(written.data?.commit).toMatch(/^[0-9a-f]{40}$/);
	expect(pushes).toHaveLength(1);
	// The pushed request names the new commit and carries a pack.
	const sent = new TextDecoder('latin1').decode(pushes[0]);
	expect(sent).toContain(`${written.data?.commit} refs/heads/main`);
	expect(sent).toContain('PACK');
});

test('the MCP endpoint answers 401 with resource metadata, then initialize and tools/list', async () => {
	const { host } = emptyRepositoryHost();
	// One canned row for the account check: a live MCP token with both scopes.
	const db = {
		execute: async () => ({
			rows: [
				{
					account_id: 'account',
					client_id: 'client',
					email: 'ada@example.test',
					target: '*',
					has_audience: true,
					has_scope: true,
				},
			],
		}),
	} as unknown as Db;
	const app = new Hono<CloudEnv>();
	mountMcpServer(app, {
		setup: async (c, next) => {
			c.set('db', db);
			await next();
		},
		resolveAudiences: () => audiences,
		resolveHost: () => host,
	});
	const post = (body: object, token?: string) =>
		app.request(audiences.mcp, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
		});

	const refused = await post({ method: 'tools/list' });
	expect(refused.status).toBe(401);
	expect(refused.headers.get('www-authenticate')).toContain(
		`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
	);

	const initialized = await post(
		{
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'probe', version: '0' },
			},
		},
		'ep_at_probe',
	);
	expect(initialized.status).toBe(200);
	expect(await initialized.json()).toMatchObject({
		result: { serverInfo: { name: 'epicenter-folders' } },
	});
	const listed = await post({ method: 'tools/list' }, 'ep_at_probe');
	const { result } = (await listed.json()) as {
		result: { tools: { name: string }[] };
	};
	expect(result.tools.map((tool) => tool.name)).toContain('write_files');
});
