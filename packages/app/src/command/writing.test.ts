/**
 * Copy the writing app into an Epicenter and use it through real CLI and MCP calls. Captures retain sources,
 * search reads bodies, and a stale edit cannot replace a note changed by another caller.
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectMcp, fixture } from './runner.test-support.ts';
import { writingSource } from './writing.test-support.ts';

setDefaultTimeout(30_000);

/**
 * Take the writing app as `name`: its folder copied into apps/<name>/code,
 * and its package named for the app.
 */
async function take(f: Awaited<ReturnType<typeof fixture>>, name: string) {
	const code = join(f.apps, name, 'code');
	await cp(join(await writingSource(f), 'writing'), code, {
		recursive: true,
		verbatimSymlinks: true,
	});
	const file = join(code, 'package.json');
	await writeFile(
		file,
		`${JSON.stringify({ ...(await Bun.file(file).json()), name }, null, 2)}\n`,
	);
}

test('the writing app copied as journal captures and finds text, sources, and projects', async () => {
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
