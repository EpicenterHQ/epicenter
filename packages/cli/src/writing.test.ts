/**
 * Copy an exported writing app from a committed repository through real CLI and MCP calls. Captures retain sources,
 * search reads bodies, and a stale edit cannot replace a note changed by another caller.
 * Also check that a missing Git identity leaves init retryable in a fresh home.
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connectMcp, fixture } from './runner.test-support.ts';
import { writingSource } from './writing.test-support.ts';

setDefaultTimeout(30_000);

test('an exported writing app copied as journal captures and finds text, sources, and projects', async () => {
	const f = await fixture();
	try {
		expect(
			(
				await f.run(
					'new',
					'journal',
					'--from',
					`file://${await writingSource(f)}#writing`,
				)
			).code,
		).toBe(0);
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
		const note = JSON.parse(added.stdout).returned;
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
				JSON.parse(found.stdout).returned.map(
					(note: { path: string }) => note.path,
				),
			).toEqual([note.path]);
		}
		expect(
			JSON.parse(
				(await f.run('journal', 'search', '{"project":"Other"}', '--json'))
					.stdout,
			).returned,
		).toEqual([]);
		expect((await f.run('journal', 'add', '{"body":"   "}')).code).toBe(2);
		expect((await f.run('build', 'journal')).code).toBe(0);
		expect(
			await readFile(join(f.apps, 'journal/code/SOURCE.md'), 'utf8'),
		).toContain('Source-Commit:');
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test('MCP discovers the writing actions and refuses a stale body edit without losing newer text', async () => {
	const f = await fixture();
	try {
		expect(
			(
				await f.run(
					'new',
					'writing',
					'--from',
					`file://${await writingSource(f)}#writing`,
				)
			).code,
		).toBe(0);
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
			const { path, time } = (
				captured.structuredContent as {
					returned: { path: string; time: string };
				}
			).returned;
			expect(
				(
					await f.run(
						'writing',
						'set',
						JSON.stringify({
							time,
							old: 'The original quote',
							new: 'The corrected quote',
						}),
					)
				).code,
			).toBe(0);
			const stale = await client.callTool({
				name: 'writing_set',
				arguments: {
					time,
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
				returned: [{ path, body: 'The corrected quote' }],
			});
		} finally {
			await close();
		}
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test('an app requiring a newer runtime is refused without leaving a partial app', async () => {
	const f = await fixture();
	try {
		const source = await f.folder(
			join(f.root, 'incompatible'),
			{
				'epicenter.ts': 'export default {};\n',
				'package.json': JSON.stringify({ engines: { epicenter: '>=99.0.0' } }),
			},
			{ git: true },
		);
		const rejected = await f.run('new', 'writing', '--from', source);
		expect(rejected.code).toBe(2);
		expect(rejected.stderr).toContain('update epicenter');
		expect(existsSync(join(f.apps, 'writing'))).toBe(false);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test('init without a Git identity can be retried after configuring one', async () => {
	const f = await fixture();
	const folder = join(f.root, 'Fresh');
	const env = {
		...f.env,
		GIT_AUTHOR_NAME: undefined,
		GIT_AUTHOR_EMAIL: undefined,
		GIT_COMMITTER_NAME: undefined,
		GIT_COMMITTER_EMAIL: undefined,
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'user.useConfigOnly',
		GIT_CONFIG_VALUE_0: 'true',
	};
	const run = async (configured: boolean) => {
		const child = Bun.spawn([process.execPath, f.bin, 'init', folder], {
			cwd: f.root,
			env: {
				...env,
				...(configured
					? {
							GIT_AUTHOR_NAME: 'Developer',
							GIT_AUTHOR_EMAIL: 'developer@example.test',
							GIT_COMMITTER_NAME: 'Developer',
							GIT_COMMITTER_EMAIL: 'developer@example.test',
						}
					: {}),
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return {
			code: await child.exited,
			stderr: await new Response(child.stderr).text(),
		};
	};
	try {
		const failed = await run(false);
		expect(failed.code).toBe(2);
		expect(failed.stderr).toContain('Git needs your name and email');
		expect(existsSync(join(folder, 'EPICENTER.md'))).toBe(false);
		expect((await run(true)).code).toBe(0);
		expect(existsSync(join(folder, 'EPICENTER.md'))).toBe(true);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
