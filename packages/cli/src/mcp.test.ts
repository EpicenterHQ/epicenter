/**
 * MCP tools use the same actions, schema defaults and errors as command runs.
 * Each test runs the real `epicenter serve` against a temporary HOME and
 * connects to it as an agent does.
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectMcp, fixture, reading, vault } from './runner.test-support.ts';

// Each test runs the real command several times as separate processes.
setDefaultTimeout(30_000);

test('tools list plain schemas and annotations and return structured answers or action errors', async () => {
	const f = await fixture();
	await f.app('reading', reading);
	await f.app('vault', vault);
	await writeFile(join(f.home, 'AGENTS.md'), 'Use the app actions.\n');
	const { client, close } = await connectMcp(f);
	try {
		expect(client.getInstructions()).toBe('Use the app actions.\n');
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
		});
		expect(
			(await client.callTool({ name: 'reading_tag' })).structuredContent,
		).toEqual({ returned: { tags: [], done: false } });
	} finally {
		await close();
		await rm(f.root, { recursive: true, force: true });
	}
});
