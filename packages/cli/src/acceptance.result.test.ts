/** Action Results across nested calls, run admission, stored events, the CLI and MCP. */
import { expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '@epicenter/app/client';
import { connectMcp, fixture } from './runner.test-support.ts';

test('a nested action returns the same refusal to HTTP, the CLI and MCP', async () => {
	const f = await fixture();
	try {
		await f.app(
			'notes',
			`
import { defineErrors } from '@epicenter/app';
const NotesError = defineErrors({
	NoRoute: ({ airport }) => ({ message: 'No route from ' + airport, airport }),
});
const lookup = defineAction({
	description: 'Look for a route', input: {},
	run: () => NotesError.NoRoute({ airport: 'LAX' }),
});
const data = defineData({ notes: { fields: {count: field.integer()} } });
const read = defineAction({ description: 'Read a note', input: {}, run: () => data.notes.get('a') });
export default defineApp({description: 'Route notes', data, actions: {
	inspect: defineAction({description: 'Inspect a note', input: {}, run: () => read({})}),
	empty: defineAction({ description: 'No data', input: {}, run: () => Ok(undefined) }),
	check: defineAction({
		description: 'Check a route', input: {},
		async run(_input, update) { update('looking'); return await lookup({}); },
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
		// Every surface answers the action's own error, as the error itself.
		const returned = { data: null, error };
		const cli = await f.run('notes', 'check', '--json');
		expect(cli.code).toBe(1);
		expect(JSON.parse(cli.stdout)).toEqual(returned);
		const empty = await f.run('notes', 'empty', '--json');
		expect(empty.code).toBe(0);
		expect(JSON.parse(empty.stdout)).toEqual({
			data: null,
			error: null,
		});
		const mcp = await connectMcp(f);
		try {
			const misfitCli = await f.run('notes', 'inspect', '--json');
			expect(misfitCli.code).toBe(1);
			const misfitAnswer = JSON.parse(misfitCli.stdout);
			expect(misfitAnswer).toMatchObject({
				data: null,
				error: {
					name: 'Misfit',
					path: 'data/notes/a.md',
					record: { body: 'repair me' },
				},
			});
			const app = connect<{
				actions: {
					check: () => typeof returned;
					inspect: () => typeof returned;
				};
			}>({ app: 'notes', url: mcp.served.base });
			expect(await app.inspect()).toEqual(misfitAnswer);
			const misfitTool = await mcp.client.callTool({
				name: 'notes_inspect',
				arguments: {},
			});
			expect(misfitTool.isError).toBe(true);
			expect(misfitTool.structuredContent).toEqual(misfitAnswer);
			const response = await fetch(`${mcp.served.base}/notes/check`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			});
			expect(response.status).toBe(200);
			expect(
				(await response.text())
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line)),
			).toEqual([{ update: 'looking' }, { answer: returned }]);
			expect(await app.check()).toEqual(returned);
			const tool = await mcp.client.callTool({
				name: 'notes_check',
				arguments: {},
			});
			expect(tool.structuredContent).toEqual(returned);
			expect(tool.isError).toBe(true);
		} finally {
			await mcp.close();
		}
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
}, 30_000);

test('a saved draft answers the app error, and a call that never started answers NotStarted', async () => {
	const f = await fixture();
	try {
		await f.app(
			'drafts',
			`
const review = defineAction({
	description: 'Review a draft title', input: { title: field.text() },
	run: ({ title }) => title.trim() ? Ok(title) : Err({
		name: 'Usage', message: 'title is needed', next: 'epicenter drafts stage --help',
	}),
});
export default defineApp({description: 'Staged drafts', actions: {
	stage: defineAction({
		description: 'Keep the draft, then ask for a review',
		input: { via: field.select(['cli','http','mcp']), title: field.text() },
		run: async ({ via, title }) => {
			await folder.write('data/' + via + '.md', 'Draft awaiting review');
			return review({ title });
		},
	}),
}});`,
		);
		const mcp = await connectMcp(f);
		try {
			// The app's own error and serve's refusal say the same words, and
			// only the name tells a caller whether the action ran.
			const said = {
				message: 'title is needed',
				next: 'epicenter drafts stage --help',
			};
			const refused = {
				data: null,
				error: {
					name: 'NotStarted',
					...said,
					cause: 'usage',
				},
			};
			const returned = { data: null, error: { name: 'Usage', ...said } };
			const draft = (via: string) =>
				join(f.apps, 'drafts', 'data', via + '.md');

			const cli = (input: object) =>
				f.run('drafts', 'stage', JSON.stringify(input), '--json');
			const bad = await cli({ via: 'cli' });
			expect(bad.code).toBe(2);
			expect(JSON.parse(bad.stdout)).toEqual(refused);
			expect(await Bun.file(draft('cli')).exists()).toBe(false);
			const saved = await cli({ via: 'cli', title: ' ' });
			expect(saved.code).toBe(1);
			expect(JSON.parse(saved.stdout)).toEqual(returned);
			expect(await readFile(draft('cli'), 'utf8')).toBe(
				'Draft awaiting review',
			);

			const post = (input: object) =>
				fetch(`${mcp.served.base}/drafts/stage`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(input),
				});
			const turnedAway = await post({ via: 'http' });
			expect(turnedAway.status).toBe(400);
			expect(await turnedAway.json()).toEqual(refused);
			expect(await Bun.file(draft('http')).exists()).toBe(false);
			const stream = await post({ via: 'http', title: ' ' });
			expect(stream.status).toBe(200);
			expect(
				(await stream.text())
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line)),
			).toEqual([{ answer: returned }]);
			expect(await readFile(draft('http'), 'utf8')).toBe(
				'Draft awaiting review',
			);

			const tool = (args: Record<string, string>) =>
				mcp.client.callTool({ name: 'drafts_stage', arguments: args });
			const denied = await tool({ via: 'mcp' });
			expect(denied.isError).toBe(true);
			expect(denied.structuredContent).toEqual(refused);
			expect(await Bun.file(draft('mcp')).exists()).toBe(false);
			const reviewed = await tool({ via: 'mcp', title: ' ' });
			expect(reviewed.isError).toBe(true);
			expect(reviewed.structuredContent).toEqual(returned);
			expect(await readFile(draft('mcp'), 'utf8')).toBe(
				'Draft awaiting review',
			);
		} finally {
			await mcp.close();
		}
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
}, 30_000);
