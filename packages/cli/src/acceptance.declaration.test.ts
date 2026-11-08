/**
 * Acceptance, stage 1: the declaration (ADR-0857, ADR-0849, ADR-0853).
 * Black-box runs of the real `epicenter` against a temporary HOME.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	declarationOf,
	fixture,
	gitIn,
	gitignore,
	readingApp,
} from './runner.test-support.ts';

setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const f = await fixture();
	roots.push(f.root);
	return f;
}

const words = {
	path: 'words/{stem}.md',
	fields: {
		type: 'object',
		properties: { stage: { enum: ['new', 'known'] } },
		required: ['stage'],
	},
};

const MCP_DEFAULTS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
};

test.failing(
	'D1 the listing shows declared folders, ignores the rest, and names each problem',
	async () => {
		const f = await setup();
		await f.folder(join(f.home, 'reading'), readingApp);
		await f.folder(join(f.home, 'vocab'), {
			'epicenter.json': declarationOf('vocab', { collections: { words } }),
		});
		const linked = await f.folder(join(f.root, 'elsewhere', 'journal'), {
			'.gitignore': gitignore,
			'epicenter.json': declarationOf('journal'),
		});
		await symlink(linked, join(f.home, 'journal'));
		await f.folder(join(f.home, 'notes'), { 'README.md': 'not an app\n' });
		await f.folder(join(f.home, 'twice'), {
			'.gitignore': gitignore,
			'epicenter.json': declarationOf('twice', { collections: { words } }),
			'epicenter.ts': `import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';
export default defineApp(declaration, {
	collections: { words: { path: 'words/{stem}.md', fields: { stage: field.text() } } },
	actions: {},
});
`,
		});
		await f.folder(join(f.home, 'clash'), {
			'.gitignore': gitignore,
			'epicenter.json': declarationOf('clash', { collections: { words } }),
			'epicenter.ts': `import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';
export default defineApp(declaration, {
	actions: {
		'words save': { description: 'Save a word my way', input: { stem: field.text() }, run: () => null },
	},
});
`,
		});
		await f.folder(join(f.home, 'malformed'), {
			'epicenter.json': JSON.stringify({ name: 3, description: 'Bad' }),
		});

		const result = await f.run('--json');
		expect(result.code).toBe(0);
		const listing = JSON.parse(result.stdout);
		expect(listing.home).toBe(f.home);
		expect(listing.apps.map((app: { name: string }) => app.name)).toEqual([
			'journal',
			'reading',
			'vocab',
		]);
		expect(
			listing.apps.find((app: { name: string }) => app.name === 'journal')
				.link,
		).toBe(linked);
		const problems = Object.fromEntries(
			listing.problems.map(
				(entry: { entry: string; problems: string[] }) => [
					entry.entry,
					entry.problems.join('\n'),
				],
			),
		);
		expect(Object.keys(problems)).toEqual(['clash', 'malformed', 'twice']);
		expect(problems.twice).toContain('"words"');
		expect(problems.twice).toContain('both epicenter.json and epicenter.ts');
		expect(problems.clash).toContain('"words save"');
		expect(problems.clash).toContain('collection "words"');
		expect(problems.malformed).toContain('epicenter.json');
		expect(problems.malformed).toContain('/name');
		expect(JSON.stringify(listing)).not.toContain('notes');

		const human = await f.run();
		expect(human.stdout).toContain('vocab  The vocab app');
		expect(human.stdout).toContain(`-> ${linked}`);
		expect(human.stdout).toContain('Problems:');
	},
);

test.failing(
	'D2 --json prints the merged declaration, each action an MCP tool',
	async () => {
		const f = await setup();
		await f.folder(join(f.home, 'reading'), readingApp);
		await f.folder(join(f.home, 'vocab'), {
			'.gitignore': gitignore,
			'epicenter.json': declarationOf('vocab', { collections: { words } }),
			'epicenter.ts': `import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';
export default defineApp(declaration, {
	collections: { quizzes: { path: 'quizzes/{day}.md', fields: { score: field.number({ optional: true }) } } },
	actions: {},
});
`,
		});
		const listing = JSON.parse((await f.run('--json')).stdout);
		const reading = listing.apps.find(
			(app: { name: string }) => app.name === 'reading',
		);
		expect(reading).toMatchObject({
			name: 'reading',
			description: 'How much I read each week',
			folder: join(f.home, 'reading'),
			collections: {
				books: {
					path: 'books/{slug}.md',
					fields: { properties: { title: { type: 'string' } } },
				},
			},
		});
		expect(reading.actions.map((tool: { name: string }) => tool.name)).toEqual(
			['reading_log', 'reading_between', 'reading_week_show', 'reading_explode'],
		);
		expect(reading.actions[0]).toEqual({
			name: 'reading_log',
			description: 'Record minutes read today',
			inputSchema: {
				type: 'object',
				properties: { minutes: { type: 'number' }, book: { type: 'string' } },
				required: ['minutes'],
				additionalProperties: false,
			},
			annotations: MCP_DEFAULTS,
		});
		expect(reading.actions[2].annotations).toEqual({
			...MCP_DEFAULTS,
			readOnlyHint: true,
			openWorldHint: false,
		});
		expect(JSON.stringify(listing)).not.toContain('positional');
		const vocab = listing.apps.find(
			(app: { name: string }) => app.name === 'vocab',
		);
		expect(vocab.collections).toEqual({
			words,
			quizzes: {
				path: 'quizzes/{day}.md',
				fields: {
					type: 'object',
					properties: { score: { type: 'number' } },
					additionalProperties: false,
				},
			},
		});
		const one = JSON.parse((await f.run('reading', '--json')).stdout);
		expect(one).toMatchObject({
			name: 'reading',
			keychain: 'epicenter.reading',
		});
		expect(one.actions).toEqual(reading.actions);
	},
);

test.failing(
	"D3 positionals come from the action's ordered list; flags always work",
	async () => {
		const f = await setup();
		await f.folder(join(f.home, 'reading'), readingApp);
		const logged = await f.run('reading', 'log', '30', '--book', 'Dune');
		expect(logged.code).toBe(0);
		expect(JSON.parse(logged.stdout)).toEqual({ minutes: 30, book: 'Dune' });
		expect(await readFile(join(f.home, 'reading/2026.csv'), 'utf8')).toBe(
			'minutes,book\n30,Dune\n',
		);
		const both = await f.run('reading', 'between', '2026-11-01', '2026-11-08');
		expect(JSON.parse(both.stdout)).toEqual({
			from: '2026-11-01',
			to: '2026-11-08',
		});
		const flags = await f.run(
			'reading',
			'between',
			'--to',
			'2026-11-08',
			'--from',
			'2026-11-01',
		);
		expect(JSON.parse(flags.stdout)).toEqual({
			from: '2026-11-01',
			to: '2026-11-08',
		});
		const extra = await f.run(
			'reading',
			'between',
			'2026-11-01',
			'2026-11-08',
			'2026-11-09',
		);
		expect(extra.code).toBe(2);
		expect(extra.stderr).toContain('2026-11-09');
		const help = await f.run('help', 'reading', 'between');
		expect(help.stdout).toContain('epicenter reading between <from> <to>');
	},
);

test.failing(
	'D4 epicenter types writes epicenter.d.json.ts, which narrows the import, and loading regenerates it',
	async () => {
		const f = await setup();
		const folder = await f.folder(join(f.home, 'vocab'), {
			'.gitignore': gitignore,
			'epicenter.json': declarationOf('vocab', { collections: { words } }),
			'epicenter.ts': `import declaration from './epicenter.json';
import { defineApp } from '@epicenter/app';
export default defineApp(declaration, { actions: {} });
`,
			'use.ts': `import declaration from './epicenter.json';
type Stage = (typeof declaration.collections.words.fields.properties.stage.enum)[number];
export const known: Stage = 'known';
// @ts-expect-error: 'other' is not one of the stages
export const other: Stage = 'other';
`,
			'tsconfig.json': JSON.stringify({
				compilerOptions: {
					module: 'preserve',
					moduleResolution: 'bundler',
					resolveJsonModule: true,
					allowArbitraryExtensions: true,
					strict: true,
					noEmit: true,
					types: [],
				},
				files: ['use.ts'],
			}),
		});
		const generated = join(folder, 'epicenter.d.json.ts');
		const tsc = Bun.resolveSync('typescript/bin/tsc', import.meta.dir);
		const typecheck = async () => {
			const child = Bun.spawn([process.execPath, tsc, '-p', folder], {
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [stdout, code] = await Promise.all([
				new Response(child.stdout).text(),
				child.exited,
			]);
			return { stdout, code };
		};
		const widened = await typecheck();
		expect(widened.code).not.toBe(0);
		expect(widened.stdout).toContain("Unused '@ts-expect-error'");

		const written = await f.runIn(folder, 'types');
		expect(written.code).toBe(0);
		expect(existsSync(generated)).toBe(true);
		expect(await typecheck()).toEqual({ stdout: '', code: 0 });

		await rm(generated);
		expect((await f.run('vocab')).code).toBe(0);
		expect(existsSync(generated)).toBe(true);
		await writeFile(
			join(folder, 'epicenter.json'),
			declarationOf('vocab', {
				collections: {
					words: {
						...words,
						fields: {
							...words.fields,
							properties: { stage: { enum: ['new', 'known', 'other'] } },
						},
					},
				},
			}),
		);
		await f.run('--json');
		expect(await readFile(generated, 'utf8')).toContain('"other"');
		expect(await gitIn(folder, 'status', '--porcelain')).toBe(
			'M epicenter.json',
		);
	},
);

test.failing(
	'D5 an epicenter.ts importing @epicenter/app loads from a folder with no node_modules',
	async () => {
		const f = await setup();
		const folder = await f.folder(join(f.root, 'away', 'reading'), readingApp);
		expect(existsSync(join(folder, 'node_modules'))).toBe(false);
		const result = await f.runIn(f.root, './away/reading', 'log', '12');
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ minutes: 12, book: null });
		expect(await gitIn(folder, 'log', '-1', '--format=%s')).toBe(
			'reading log',
		);
	},
);

test.failing(
	'D6 serve --stdio answers initialize, lists the same tools as --json, and runs a call that commits',
	async () => {
		const f = await setup();
		const folder = await f.folder(join(f.home, 'reading'), readingApp);
		const listing = JSON.parse((await f.run('--json')).stdout);
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [f.bin, 'serve', '--stdio'],
			cwd: f.root,
			env: f.env as Record<string, string>,
			stderr: 'pipe',
		});
		const client = new Client({ name: 'acceptance', version: '1' });
		try {
			await client.connect(transport);
			expect(client.getServerVersion()?.name).toBe('epicenter');
			const { tools } = await client.listTools();
			expect(tools).toEqual(
				listing.apps.flatMap((app: { actions: unknown[] }) => app.actions),
			);
			const called = await client.callTool({
				name: 'reading_log',
				arguments: { minutes: 30 },
			});
			expect(called.isError).toBeFalsy();
			expect(await gitIn(folder, 'log', '-1', '--format=%s')).toBe(
				'reading log',
			);
			expect(await readFile(join(folder, '2026.csv'), 'utf8')).toBe(
				'minutes,book\n30,\n',
			);
		} finally {
			await client.close();
		}
		expect((await f.run('mcp')).code).toBe(2);
	},
);

test.failing(
	'D7 discovery uses $HOME/Epicenter and ignores EPICENTER_HOME',
	async () => {
		const f = await setup();
		await f.folder(join(f.home, 'reading'), readingApp);
		const decoy = join(f.root, 'decoy-home');
		await f.folder(join(decoy, 'decoy'), {
			'epicenter.json': declarationOf('decoy'),
		});
		f.env.EPICENTER_HOME = decoy;
		const listing = JSON.parse((await f.run('--json')).stdout);
		expect(listing.home).toBe(join(f.root, 'Epicenter'));
		expect(listing.apps.map((app: { name: string }) => app.name)).toEqual([
			'reading',
		]);
		expect((await f.run('--help')).stdout).not.toContain('EPICENTER_HOME');
	},
);
