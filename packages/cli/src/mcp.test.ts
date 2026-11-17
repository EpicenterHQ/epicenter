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
		const shown = { data: { day: '2026-11-08' }, error: null };
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
			structuredContent: {
				data: null,
				error: { kind: 'fault', message: 'action exploded' },
			},
		});
		expect((await client.callTool({ name: 'unknown' })).isError).toBe(true);
		const logged = await client.callTool({
			name: 'reading_log',
			arguments: { minutes: 30 },
		});
		expect(logged.structuredContent).toEqual({
			data: { minutes: 30 },
			error: null,
		});
		expect(
			(await client.callTool({ name: 'reading_tag' })).structuredContent,
		).toEqual({ data: { tags: [], done: false }, error: null });
	} finally {
		await close();
		await rm(f.root, { recursive: true, force: true });
	}
});

test('discovery preserves tilde-prefixed properties', async () => {
	const f = await fixture();
	await f.app(
		'shapes',
		`export default defineApp({ description: 'Shapes', collections: {}, actions: {
  echo: defineAction({ description: 'Echo', input: {
   value: { type: 'object', properties: { '~label': field.text() }, required: ['~label'] },
   note: field.text({ optional: true }),
  }, run: ({ value }) => Ok(value) }),
 } });`,
	);
	const { client, close } = await connectMcp(f);
	try {
		const tool = (await client.listTools()).tools.find(
			(tool) => tool.name === 'shapes_echo',
		);
		expect(tool?.inputSchema).toEqual({
			type: 'object',
			additionalProperties: false,
			properties: {
				value: {
					type: 'object',
					properties: { '~label': { type: 'string' } },
					required: ['~label'],
				},
				note: { type: 'string' },
			},
			required: ['value'],
		});
		const listed = JSON.parse((await f.run('shapes', '--json')).stdout);
		expect(listed.actions[0].inputSchema).toEqual(tool?.inputSchema);
		expect(
			(
				await client.callTool({
					name: 'shapes_echo',
					arguments: { value: { '~label': 'kept' } },
				})
			).structuredContent,
		).toEqual({ data: { '~label': 'kept' }, error: null });
	} finally {
		await close();
		await rm(f.root, { recursive: true, force: true });
	}
});

test('MCP preserves a returned app error and matches the CLI host answer', async () => {
	const f = await fixture();
	await f.app(
		'routes',
		`export default defineApp({description:'Routes',collections:{},actions:{find:defineAction({description:'Find',input:{},run:()=>Err({name:'NoRoute',message:'No route from LAX',airport:'LAX',next:'epicenter routes add'})})}});`,
	);
	const { client, close } = await connectMcp(f);
	try {
		const cli = await f.run('routes', 'find', '--json');
		expect(cli.code).toBe(1);
		const answer = await client.callTool({
			name: 'routes_find',
			arguments: {},
		});
		expect(answer.isError).toBe(true);
		expect(answer.content).toEqual([
			{ type: 'text', text: 'No route from LAX\nRun: epicenter routes add' },
		]);
		expect(answer.structuredContent).toEqual(JSON.parse(cli.stdout));
	} finally {
		await close();
		await rm(f.root, { recursive: true, force: true });
	}
});
