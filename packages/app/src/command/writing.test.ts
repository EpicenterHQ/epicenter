/**
 * Put a small writing app into an Epicenter and use it through real CLI and MCP calls. Captures retain sources,
 * search reads bodies, and a stale edit cannot replace a note changed by another caller.
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connectMcp, fixture } from './runner.test-support.ts';

setDefaultTimeout(30_000);

/** A writing inbox: notes with a kind, a source and a project, and a search across them. */
const writingApp = `import { defineAction, defineApp, defineData, field, Ok, timeId } from '@epicenter/app';

const kinds = ['thought', 'quote', 'link'] as const;

export default defineApp(({ folder }) => {
	const data = defineData(folder, {
		notes: {
			description: 'writing note',
			fields: {
				kind: field.select(kinds),
				source: field.text({ optional: true }),
				project: field.text({ optional: true }),
			},
		},
	});
	const add = defineAction({
		description: 'Save a thought, quote, or link',
		input: {
			body: field.text({ pattern: '\\\\S', description: 'not blank' }),
			kind: field.select(kinds, { optional: true }),
			source: field.text({ optional: true }),
			project: field.text({ optional: true }),
		},
		run: ({ body, kind = 'thought', source, project }) =>
			data.notes.create(timeId(), { body, kind, source, project }),
	});
	const search = defineAction({
		description: 'Find notes by their text, source, or project',
		input: {
			query: field.text({ optional: true }),
			project: field.text({ optional: true }),
		},
		annotations: { readOnlyHint: true },
		run: async ({ query = '', project }) => {
			const notes = (await data.notes.list()).flatMap((row) => (row.data ? [row.data] : []));
			return Ok(
				notes.filter(
					(note) =>
						(project === undefined || note.project === project) &&
						[note.body, note.source, note.project]
							.join('\\n')
							.toLowerCase()
							.includes(query.toLowerCase()),
				),
			);
		},
	});
	return {
		description: 'A writing inbox',
		data,
		actions: { ...data.notes.actions('edit'), add, search },
	};
});
`;

/** Put the writing app in the Epicenter as `name`, with a page its own build makes. */
async function take(f: Awaited<ReturnType<typeof fixture>>, name: string) {
	await f.folder(join(f.apps, name, 'code'), {
		'epicenter.ts': writingApp,
		'package.json': `${JSON.stringify(
			{
				name,
				private: true,
				type: 'module',
				scripts: { build: 'bun build ui/index.html --outdir ui/dist' },
			},
			null,
			2,
		)}\n`,
		'ui/index.html':
			'<!doctype html>\n<title>Writing</title>\n<p>Writing</p>\n',
	});
}

test('the writing app as journal captures and finds text, sources, and projects', async () => {
	const f = await fixture();
	try {
		await take(f, 'journal');
		const added = await f.run(
			'journal',
			'add',
			JSON.stringify({
				body: 'An observation about attention',
				source: 'My notebook',
				project: 'Essay',
			}),
			'--json',
		);
		expect(added.code).toBe(0);
		const note = JSON.parse(added.stdout).data;
		expect(note).toMatchObject({
			kind: 'thought',
			body: 'An observation about attention',
			source: 'My notebook',
			project: 'Essay',
		});
		expect(
			await readFile(join(f.apps, 'journal', note.path), 'utf8'),
		).toContain('An observation about attention');
		for (const query of ['ATTENTION', 'notebook', 'essay']) {
			const found = await f.run(
				'journal',
				'search',
				JSON.stringify({ query }),
				'--json',
			);
			expect(
				JSON.parse(found.stdout).data.map(
					(note: { path: string }) => note.path,
				),
			).toEqual([note.path]);
		}
		expect(
			JSON.parse(
				(await f.run('journal', 'search', '{"project":"Other"}', '--json'))
					.stdout,
			).data,
		).toEqual([]);
		expect((await f.run('journal', 'add', '{"body":"   "}')).code).toBe(2);
		// Its own build makes the page serve answers with.
		const code = join(f.apps, 'journal/code');
		const build = Bun.spawn([process.execPath, 'run', 'build'], {
			cwd: code,
			stdout: 'ignore',
			stderr: 'ignore',
		});
		expect(await build.exited).toBe(0);
		expect(existsSync(join(code, 'ui/dist/index.html'))).toBe(true);
	} finally {
		await rm(f.userDir, { recursive: true, force: true });
	}
});

test('MCP discovers the writing actions and refuses a stale body edit without losing newer text', async () => {
	const f = await fixture();
	try {
		await take(f, 'writing');
		const { client, close } = await connectMcp(f);
		try {
			expect(
				(await client.listTools()).tools.map((tool) => tool.name),
			).toContain('writing_search');
			const captured = await client.callTool({
				name: 'writing_add',
				arguments: {
					body: 'The original quote',
					kind: 'quote',
					source: 'Book, page 12',
				},
			});
			const { path, id } = (
				captured.structuredContent as {
					data: { path: string; id: string };
					error: null;
				}
			).data;
			expect(
				(
					await f.run(
						'writing',
						'edit',
						JSON.stringify({
							id,
							old: 'The original quote',
							new: 'The corrected quote',
						}),
					)
				).code,
			).toBe(0);
			const stale = await client.callTool({
				name: 'writing_edit',
				arguments: {
					id,
					old: 'The original quote',
					new: 'A stale replacement',
				},
			});
			expect(stale.isError).toBe(true);
			expect(await readFile(join(f.apps, 'writing', path), 'utf8')).toContain(
				'The corrected quote',
			);
			const found = await client.callTool({
				name: 'writing_search',
				arguments: { query: 'corrected' },
			});
			expect(found.structuredContent).toMatchObject({
				data: [{ path, body: 'The corrected quote' }],
				error: null,
			});
		} finally {
			await close();
		}
	} finally {
		await rm(f.userDir, { recursive: true, force: true });
	}
});
