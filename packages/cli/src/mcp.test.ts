/**
 * MCP tools use the same actions, schema defaults and errors as command runs.
 * Each test runs the real `epicenter serve --stdio` against a temporary HOME.
 */
import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, reading, vault } from './runner.test-support.ts';

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
		const committed = await client.callTool({
			name: 'reading_log',
			arguments: { minutes: 30 },
		});
		expect(committed.content).toEqual([
			{ type: 'text', text: '{"minutes":30}' },
			{
				type: 'text',
				text: expect.stringMatching(/^committed [a-f0-9]+ reading log$/),
			},
		]);
		expect(
			(await client.callTool({ name: 'reading_tag' })).structuredContent,
		).toEqual({ tags: [], done: false });
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
		expect(stderr).toContain('Serving 1 apps over MCP.');
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
