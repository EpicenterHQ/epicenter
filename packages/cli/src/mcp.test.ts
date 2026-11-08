/**
 * MCP tools use the same actions, schema defaults and errors as command runs.
 * In-memory SDK transports verify the protocol without using stdout.
 */
import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { discoverAll } from './home.ts';
import { createMcpServer } from './mcp.ts';
import { fixture, reading, vault } from './runner.test-support.ts';

test('tools list plain schemas and annotations and return structured answers or action errors', async () => {
	const f = await fixture();
	const previous = {
		home: process.env.EPICENTER_HOME,
		cache: process.env.EPICENTER_CACHE_HOME,
		secrets: process.env.EPICENTER_TEST_SECRETS,
	};
	process.env.EPICENTER_HOME = f.home;
	process.env.EPICENTER_CACHE_HOME = f.cache;
	process.env.EPICENTER_TEST_SECRETS = f.env.EPICENTER_TEST_SECRETS;
	const client = new Client({ name: 'test', version: '1' });
	let server: ReturnType<typeof createMcpServer> | undefined;
	try {
		await f.app('reading', reading);
		await f.app('vault', vault);
		server = createMcpServer((await discoverAll()).apps);
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		const listed = await client.listTools();
		const show = listed.tools.find(
			(tool) => tool.name === 'vault_calendar_show',
		);
		expect(show).toMatchObject({
			annotations: { readOnlyHint: true, destructiveHint: false },
			inputSchema: { type: 'object', properties: { day: { type: 'string' } } },
		});
		expect(
			listed.tools.find((tool) => tool.name === 'vault_calendar_add')
				?.annotations?.destructiveHint,
		).toBe(true);
		expect(JSON.stringify(listed)).not.toContain('positional');
		expect(JSON.stringify(listed)).not.toContain('~kind');
		const answer = await client.callTool({
			name: 'vault_calendar_show',
			arguments: { day: '2026-11-08' },
		});
		expect(answer.structuredContent).toEqual({ day: '2026-11-08' });
		expect(answer.content).toEqual([
			{ type: 'text', text: '{"day":"2026-11-08"}' },
		]);
		expect(
			(
				await client.callTool({
					name: 'vault_calendar_show',
					arguments: { day: 3 },
				})
			).isError,
		).toBe(true);
		const missing = await client.callTool({ name: 'vault_calendar_show' });
		expect(missing.isError).toBe(true);
		expect(missing.content).toEqual([{ type: 'text', text: 'day is needed' }]);
		expect(
			(
				await client.callTool({
					name: 'vault_calendar_show',
					arguments: { day: '2026-11-08', extra: 1 },
				})
			).isError,
		).toBe(true);
		expect(await client.callTool({ name: 'reading_explode' })).toMatchObject({
			isError: true,
			content: [{ type: 'text', text: 'action exploded' }],
		});
		expect((await client.callTool({ name: 'unknown' })).isError).toBe(true);
		expect(
			(await client.callTool({ name: 'reading_tag' })).structuredContent,
		).toEqual({ tags: [], done: false });
	} finally {
		await client.close();
		await server?.close();
		for (const [key, value] of Object.entries({
			EPICENTER_HOME: previous.home,
			EPICENTER_CACHE_HOME: previous.cache,
			EPICENTER_TEST_SECRETS: previous.secrets,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(f.root, { recursive: true, force: true });
	}
});

test('stdio command returns its exit code after the client ends stdin', async () => {
	const f = await fixture();
	try {
		await f.app('vault', vault);
		const source = `import { mcpCommand } from ${JSON.stringify(`${import.meta.dir}/mcp.ts`)}; const code = await mcpCommand([]); process.stderr.write('Returned ' + code + '\\n');`;
		const child = Bun.spawn([process.execPath, '-e', source], {
			env: f.env,
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		child.stdin.end();
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(0);
		expect(stdout).toBe('');
		expect(stderr).toContain('Serving 1 apps over MCP.');
		expect(stderr).toContain('Returned 0');
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
