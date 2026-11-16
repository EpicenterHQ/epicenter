import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '@epicenter/app/client';
import { connectMcp, fixture } from './runner.test-support.ts';

test('a nested action returns the same refusal to HTTP, the CLI and MCP', async () => {
	const f = await fixture();
	try {
		await f.app(
			'notes',
			`
import { defineErrors, Ok } from '@epicenter/app';
const NotesError = defineErrors({
	NoRoute: ({ airport }) => ({ message: 'No route from ' + airport, airport }),
});
const lookup = defineAction({
	description: 'Look for a route', input: {},
	run: () => NotesError.NoRoute({ airport: 'LAX' }),
});
const notes = defineCollection({ path: 'data/notes/{slug}.md', fields: {count: field.integer()} });
const read = defineAction({ description: 'Read a note', input: {}, run: () => notes.get({slug:'a'}) });
export default defineApp({description: 'Route notes', collections: {notes}, actions: {
	inspect: defineAction({description: 'Inspect a note', input: {}, run: () => read({})}),
	empty: defineAction({ description: 'No data', input: {}, run: () => Ok(undefined) }),
	check: defineAction({
		description: 'Check a route', input: {},
		async *run() { yield 'looking'; return await lookup({}); },
	}),
}});`,
		);
		const dir = join(f.apps, 'notes', 'data', 'notes');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'a.md'), '---\ncount: "bad"\n---\nrepair me');
		const error = {
			name: 'NoRoute',
			message: 'No route from LAX',
			airport: 'LAX',
		};
		const result = { data: null, error };
		const cli = await f.run('notes', 'check', '--json');
		expect(cli.code).toBe(1);
		expect(JSON.parse(cli.stdout)).toEqual({ result });
		const empty = await f.run('notes', 'empty', '--json');
		expect(empty.code).toBe(0);
		expect(JSON.parse(empty.stdout)).toEqual({
			result: { data: null, error: null },
		});
		const mcp = await connectMcp(f);
		try {
			const misfitCli = await f.run('notes', 'inspect', '--json');
			expect(misfitCli.code).toBe(1);
			const misfitAnswer = JSON.parse(misfitCli.stdout);
			expect(misfitAnswer).toMatchObject({
				result: {
					data: null,
					error: {
						name: 'Misfit',
						path: 'data/notes/a.md',
						record: { body: 'repair me' },
					},
				},
			});
			const app = connect<{
				actions: { check: () => typeof result; inspect: () => typeof result };
			}>({ app: 'notes', url: mcp.served.base });
			expect(await app.inspect()).toEqual(misfitAnswer.result);
			const misfitTool = await mcp.client.callTool({
				name: 'notes_inspect',
				arguments: {},
			});
			expect(misfitTool.isError).toBe(true);
			expect(misfitTool.structuredContent).toEqual(misfitAnswer);
			const id = crypto.randomUUID();
			const response = await fetch(
				`${mcp.served.base}/.runs/notes/check/${id}`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{}',
				},
			);
			expect(response.status).toBe(200);
			const events = (await response.text())
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			expect(events.at(-1)).toMatchObject({
				type: 'finished',
				answer: { result },
			});
			expect(events.find((event) => event.type === 'yielded')?.value).toBe(
				'looking',
			);
			expect(await app.check()).toEqual(result);
			const tool = await mcp.client.callTool({
				name: 'notes_check',
				arguments: {},
			});
			expect(tool.structuredContent).toEqual({ result });
			expect(tool.isError).toBe(true);
		} finally {
			await mcp.close();
		}
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
}, 30_000);
