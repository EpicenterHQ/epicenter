/**
 * MCP tools use the same actions, schema defaults and errors as command runs.
 * Each test runs the real `epicenter serve --stdio` against a temporary HOME.
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
	declarationOf,
	fixture,
	reading,
	vault,
} from './runner.test-support.ts';

// Each test runs the real command several times as separate processes.
setDefaultTimeout(30_000);

test('tools list plain schemas and annotations and return structured answers or action errors', async () => {
	const f = await fixture();
	const client = new Client({ name: 'test', version: '1' });
	try {
		await f.app('reading', reading);
		await f.app('vault', vault);
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [f.bin, 'serve', '--stdio'],
				cwd: f.root,
				env: f.env as Record<string, string>,
				stderr: 'pipe',
			}),
		);
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
		const shown = { returned: { day: '2026-11-08' } };
		expect(answer.structuredContent).toEqual(shown);
		expect(answer.content).toEqual([
			{ type: 'text', text: JSON.stringify(shown) },
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
		expect(missing.content).toEqual([
			{
				type: 'text',
				text: 'day is needed\nRun: epicenter vault calendar show --help',
			},
		]);
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
		const logged = await client.callTool({
			name: 'reading_log',
			arguments: { minutes: 30 },
		});
		expect(logged.structuredContent).toEqual({
			returned: { minutes: 30 },
			committed: expect.any(String),
		});
		expect(
			(await client.callTool({ name: 'reading_tag' })).structuredContent,
		).toEqual({ returned: { tags: [], done: false } });
	} finally {
		await client.close();
		await rm(f.root, { recursive: true, force: true });
	}
});

test('serve --stdio exits 0 after the client ends stdin', async () => {
	const f = await fixture();
	try {
		await f.app('vault', vault);
		const child = Bun.spawn([process.execPath, f.bin, 'serve', '--stdio'], {
			cwd: f.root,
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
		expect(stderr).toContain('Serving your apps over MCP.');
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test('the sync tool syncs the home, or one app, and is an error when an app does not sync', async () => {
	const f = await fixture();
	const client = new Client({ name: 'test', version: '1' });
	try {
		await f.app('vault', vault);
		await writeFile(join(f.home, 'vault', 'note.md'), 'note\n');
		await f.folder(
			join(f.home, 'loose'),
			{ 'epicenter.json': declarationOf('loose') },
			{ git: false },
		);
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [f.bin, 'serve', '--stdio'],
				cwd: f.root,
				env: f.env as Record<string, string>,
				stderr: 'pipe',
			}),
		);
		const tool = (await client.listTools()).tools.find(
			(tool) => tool.name === 'sync',
		);
		expect(tool?.inputSchema).toMatchObject({
			properties: { app: { type: 'string' } },
		});
		const one = await client.callTool({
			name: 'sync',
			arguments: { app: 'vault' },
		});
		expect(one.isError).toBeFalsy();
		expect(one.structuredContent).toEqual({
			apps: [
				{
					app: 'vault',
					folder: join(f.home, 'vault'),
					committed: { subject: 'sync: vault (1 file)', files: 1 },
					pushed: false,
					upstream: null,
				},
			],
		});
		const all = await client.callTool({ name: 'sync', arguments: {} });
		expect(all.isError).toBe(true);
		expect(all.content).toEqual([
			{
				type: 'text',
				text: expect.stringContaining('loose: '),
			},
		]);
		for (const app of ['--help', 'nope'])
			expect(
				(await client.callTool({ name: 'sync', arguments: { app } })).isError,
			).toBe(true);
	} finally {
		await client.close();
		await rm(f.root, { recursive: true, force: true });
	}
});
