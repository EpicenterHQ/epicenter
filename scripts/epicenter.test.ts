/**
 * `epicenter check` and `epicenter query` against real directories, through
 * fresh CLI processes: exit codes, compiler-style diagnostics, the projection's
 * columns and values, the one-statement read-only rule, and that nothing in the
 * folder is executed or changed.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const cli = resolve(import.meta.dir, 'epicenter.ts');
const temporaryFolders: string[] = [];

/** A table as `epicenter.json` holds it, every field required. */
const objectSchema = (properties: Record<string, object>) => ({
	type: 'object',
	properties,
	required: Object.keys(properties),
});
const noSettings = { type: 'object', properties: {} };

const declaration = {
	kv: noSettings,
	tables: {
		posts: objectSchema({
			title: { type: 'string' },
			status: {
				enum: ['planned', 'drafting', 'done'],
				'x-field': { kind: 'select' },
			},
			due: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
			order: { type: 'number' },
			pinned: { type: 'boolean' },
			tags: { type: 'array', items: { type: 'string' } },
			account: {
				type: 'string',
				minLength: 1,
				'x-field': { kind: 'reference', target: 'accounts' },
			},
		}),
		accounts: objectSchema({ kind: { const: 'social' } }),
	},
};

afterEach(async () => {
	await Promise.all(
		temporaryFolders
			.splice(0)
			.map((folder) => rm(folder, { recursive: true, force: true })),
	);
});

async function setup() {
	const folder = await mkdtemp(join(tmpdir(), 'epicenter-cli-test-'));
	temporaryFolders.push(folder);
	async function write(path: string, value: string | Uint8Array) {
		await mkdir(dirname(join(folder, path)), { recursive: true });
		await writeFile(join(folder, path), value);
	}
	await write('epicenter.json', JSON.stringify(declaration));
	await write(
		'posts/reel.md',
		'---\ntitle: Reel\nstatus: drafting\ndue: 2026-10-11\norder: 1\npinned: true\ntags: [a, b]\naccount: instagram\n---\nCut done.\n',
	);
	function run(...args: string[]) {
		const result = Bun.spawnSync(
			[process.execPath, '--no-install', cli, ...args],
			{ cwd: folder, stdout: 'pipe', stderr: 'pipe' },
		);
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	}
	return { folder, write, run };
}

// ============================================================================
// check
// ============================================================================

test('check passes a conforming data folder', async () => {
	const { folder, run } = await setup();
	const result = run('check', folder);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe(
		'1 row conforms; 0 files invalid; 0 unreadable.\n',
	);
});

test('check reports invalid rows compiler style and exits 1', async () => {
	const { folder, write, run } = await setup();
	await write(
		'posts/launch.md',
		'---\ntitle: Launch\nstatus: someday\ndue: null\norder: 2\npinned: false\ntags: []\naccount: instagram\n---\n',
	);
	await write('posts/broken.md', 'no fences\n');
	await write(
		'posts/latin1.md',
		new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff]),
	);
	const result = run('check', folder, '--json');
	expect(result.exitCode).toBe(1);
	const report = JSON.parse(result.stdout);
	expect(report.rows).toBe(1);
	expect(report.invalid).toEqual([
		expect.objectContaining({ path: 'posts/broken.md', line: 1 }),
		{ path: 'posts/latin1.md', message: 'The file is not valid UTF-8 text' },
		expect.objectContaining({
			path: 'posts/launch.md',
			line: 3,
			field: 'status',
		}),
	]);
	expect(run('check', folder).stdout).toContain(
		'posts/launch.md:3: status does not conform',
	);
});

test('a closed table reports an undeclared key, and query leaves its file out', async () => {
	const { folder, write, run } = await setup();
	await write(
		'epicenter.json',
		JSON.stringify({
			...declaration,
			tables: {
				...declaration.tables,
				accounts: {
					...declaration.tables.accounts,
					additionalProperties: false,
				},
			},
		}),
	);
	await write('accounts/instagram.md', '---\nkind: social\nhandle: x\n---\n');
	await write('accounts/threads.md', '---\nkind: social\n---\n');

	const result = run('check', folder);
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain(
		'accounts/instagram.md:3: handle is not declared',
	);
	const query = run('query', folder, 'SELECT stem FROM accounts', '--json');
	expect(JSON.parse(query.stdout)).toMatchObject({
		rows: [{ stem: 'threads' }],
		excluded: ['accounts/instagram.md'],
	});
});

test('a missing or unusable epicenter.json is a tool failure with exit 2', async () => {
	const { folder, write, run } = await setup();
	const empty = await mkdtemp(join(tmpdir(), 'epicenter-cli-test-'));
	temporaryFolders.push(empty);
	const missing = run('check', empty);
	expect(missing.exitCode).toBe(2);
	expect(missing.stderr).toContain('has no epicenter.json');
	expect(JSON.parse(run('check', empty, '--json').stdout).error).toContain(
		'has no epicenter.json',
	);

	await write(
		'epicenter.json',
		JSON.stringify({
			kv: noSettings,
			tables: { 'bad name': objectSchema({}) },
		}),
	);
	expect(run('check', folder).exitCode).toBe(2);
});

test('a typo epicenter.json would otherwise ignore is refused, and $schema is allowed', async () => {
	const { folder, write, run } = await setup();
	const declare = (value: object) =>
		write('epicenter.json', JSON.stringify(value));

	await declare({ ...declaration, tabels: {} });
	const extraKey = run('check', folder);
	expect(extraKey.exitCode).toBe(2);
	expect(extraKey.stderr).toContain("unknown top-level key 'tabels'");

	await declare({
		kv: noSettings,
		tables: {
			posts: objectSchema({ due: { type: 'string', format: 'date-tme' } }),
		},
	});
	const format = run('query', folder);
	expect(format.exitCode).toBe(2);
	expect(format.stderr).toContain('posts.due');
	expect(format.stderr).toContain('date-tme');

	await declare({
		$schema: 'https://example.test/epicenter.schema.json',
		...declaration,
	});
	expect(run('check', folder).exitCode).toBe(0);
});

test('query refuses fields it cannot project: case duplicates, stem, and body', async () => {
	const { folder, write, run } = await setup();
	for (const [fields, message] of [
		[
			{ title: { type: 'string' }, Title: { type: 'string' } },
			"'title' and 'Title'",
		],
		[{ body: { type: 'string' } }, "a field 'body'"],
		[{ Stem: { type: 'string' } }, "a field 'Stem'"],
	] as const) {
		await write(
			'epicenter.json',
			JSON.stringify({
				kv: noSettings,
				tables: { posts: objectSchema(fields) },
			}),
		);
		const result = run('query', folder, 'SELECT 1');
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(message);
		expect(run('check', folder).exitCode).not.toBe(2);
	}
});

test('a directory named epicenter.ts is not a declaration source', async () => {
	const { folder, run } = await setup();
	await mkdir(join(folder, 'epicenter.ts'));
	const checked = run('check', folder);
	expect(checked.exitCode).toBe(0);
	expect(checked.stdout).not.toContain('generated from');
	expect(run('generate', folder).stderr).toContain('has no epicenter.ts');
});

test("check and query never run a folder's code", async () => {
	const { folder, write, run } = await setup();
	await write(
		'epicenter.ts',
		`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(folder, 'ran'))}, 'yes');\nexport default {};`,
	);
	expect(run('check', folder).exitCode).toBe(0);
	expect(run('query', folder, 'SELECT 1').exitCode).toBe(0);
	expect(await readdir(folder)).not.toContain('ran');
});

// ============================================================================
// query
// ============================================================================

test('query without a statement describes the declaration, even while rows are broken', async () => {
	const { folder, write, run } = await setup();
	await write('posts/broken.md', 'no fences\n');
	const result = run('query', folder);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe(
		[
			'posts:',
			"  stem: the row's file is posts/<stem>.md",
			'  title: string',
			'  status: planned|drafting|done',
			'  due: date|null',
			'  order: number',
			'  pinned: boolean',
			'  tags: list of string',
			'  account: stem in accounts',
			'  body: Markdown after the frontmatter',
			'accounts:',
			"  stem: the row's file is accounts/<stem>.md",
			'  kind: social',
			'  body: Markdown after the frontmatter',
			'',
		].join('\n'),
	);
	expect(
		JSON.parse(run('query', folder, '--json').stdout).tables[0].columns,
	).toContainEqual({ name: 'status', values: 'planned|drafting|done' });
});

test('query projects rows with quoted keyword columns and SQLite values', async () => {
	const { folder, run } = await setup();
	const result = run(
		'query',
		folder,
		`SELECT stem, "order", pinned, tags, due, body FROM posts WHERE status != 'done'`,
		'--json',
	);
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		columns: ['stem', 'order', 'pinned', 'tags', 'due', 'body'],
		rows: [
			{
				stem: 'reel',
				order: 1,
				pinned: 1,
				tags: '["a","b"]',
				due: '2026-10-11',
				body: 'Cut done.\n',
			},
		],
		excluded: [],
	});
});

test('query prints one line per row, escaping tabs, newlines, and backslashes', async () => {
	const { folder, run } = await setup();
	const result = run('query', folder, `SELECT body, 'a\tb\\c' AS x FROM posts`);
	expect(result.stdout).toBe('body\tx\nCut done.\\n\ta\\tb\\\\c\n');
});

test('query answers from the files that conform and names the ones it left out', async () => {
	const { folder, write, run } = await setup();
	await write('posts/broken.md', 'no fences\n');
	const partial = run('query', folder, 'SELECT count(*) AS n FROM posts');
	expect(partial.exitCode).toBe(0);
	expect(partial.stdout).toBe('n\n1\n');
	expect(partial.stderr).toBe(
		`1 file excluded because it does not conform: posts/broken.md. Run \`epicenter check ${folder}\`\n`,
	);
	const json = run(
		'query',
		folder,
		'SELECT count(*) AS n FROM posts',
		'--json',
	);
	expect(json.stderr).toBe('');
	expect(JSON.parse(json.stdout)).toEqual({
		columns: ['n'],
		rows: [{ n: 1 }],
		excluded: ['posts/broken.md'],
	});

	await write(
		'posts/broken.md',
		'---\ntitle: Fixed\nstatus: done\ndue: null\norder: 3\npinned: false\ntags: []\naccount: instagram\n---\n',
	);
	const whole = run('query', folder, 'SELECT count(*) AS n FROM posts');
	expect(whole.stdout).toBe('n\n2\n');
	expect(whole.stderr).toBe('');
});

test('nothing outside the data folder is read', async () => {
	const { folder, run } = await setup();
	const outside = await mkdtemp(join(tmpdir(), 'epicenter-cli-test-'));
	temporaryFolders.push(outside);
	await writeFile(join(outside, 'secret.md'), '---\ntitle: Secret\n---\n');
	await symlink(join(outside, 'secret.md'), join(folder, 'posts/linked.md'));
	await symlink(outside, join(folder, 'accounts'));

	const result = run('check', folder, '--json');
	const report = JSON.parse(result.stdout);
	expect(result.exitCode).toBe(1);
	expect(report.invalid).toEqual([
		{
			path: 'posts/linked.md',
			message:
				'The path is not usable: the path passes through a symbolic link',
		},
		{
			path: 'accounts',
			message:
				'The path is not usable: the path passes through a symbolic link',
		},
	]);
	expect(result.stdout).not.toContain('Secret');
	const query = run('query', folder, 'SELECT title FROM posts', '--json');
	expect(query.exitCode).toBe(0);
	expect(query.stdout).not.toContain('Secret');
	expect(JSON.parse(query.stdout).excluded).toEqual([
		'posts/linked.md',
		'accounts',
	]);
});

test('a directory named <stem>.md in a table is a file to fix, not skipped', async () => {
	const { folder, run } = await setup();
	await mkdir(join(folder, 'posts/notes.md'));
	const result = run('check', folder);
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe(
		'posts/notes.md: A row must be a file, not a directory\n1 row conforms; 1 file invalid; 0 unreadable.\n',
	);
});

test('query refuses statements that write, attach, or vacuum, and leaves the directory unchanged', async () => {
	const { folder, run } = await setup();
	const before = await readdir(folder, { recursive: true });
	for (const sql of [
		`UPDATE posts SET status = 'done'`,
		`ATTACH 'copy.db' AS copy`,
		`VACUUM INTO 'copy.db'`,
		'PRAGMA query_only = OFF',
	]) {
		const result = run('query', folder, sql);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('query only reads');
	}
	expect(await readdir(folder, { recursive: true })).toEqual(before);
	expect(await readFile(join(folder, 'posts/reel.md'), 'utf8')).toContain(
		'status: drafting',
	);
});

test('query runs exactly one statement and accepts leading and trailing comments', async () => {
	const { folder, run } = await setup();
	const two = run('query', folder, 'SELECT 1; SELECT 2');
	expect(two.exitCode).toBe(2);
	expect(two.stderr).toContain('one statement');
	expect(
		run('query', folder, '-- due today\nSELECT 1 AS n; -- done').stdout,
	).toBe('n\n1\n');
	expect(run('query', folder, '   ').exitCode).toBe(2);
});

test('the CLI rejects missing or extra arguments', async () => {
	const { folder, run } = await setup();
	expect(run('check').exitCode).toBe(2);
	expect(run('check', folder, 'SELECT 1').exitCode).toBe(2);
	expect(run('query', folder, 'SELECT 1', 'extra').exitCode).toBe(2);
	expect(run('validate', folder).exitCode).toBe(2);
	expect(run('--help').stdout).toContain('epicenter check <dir>');
});

// ============================================================================
// generate
// ============================================================================

const source = `import { defineFolder, defineTable, field } from '@epicenter/folder';
import { isOptional } from '@epicenter/definition';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

if (!Compile(Type.String()).Check('x')) throw new Error('typebox did not resolve');

if (!isOptional(field.optional(field.string())))
	throw new Error('imports did not resolve');

export default defineFolder({
	kv: {},
	tables: {
		pages: defineTable({
			fields: {
				title: field.string(),
				queuedAt: field.optional(field.date()),
				meta: field.optional(Type.Object({ words: Type.Integer() })),
			},
		}),
	},
});
`;

test('generate writes the epicenter.json that epicenter.ts declares, and check reads it', async () => {
	const { folder, write, run } = await setup();
	await write('epicenter.ts', source);
	await write('pages/a.md', '---\ntitle: A\n---\n');

	const generated = run('generate', folder);
	expect(generated.exitCode).toBe(0);
	expect(generated.stdout).toBe('wrote epicenter.json from epicenter.ts\n');
	const declaration = JSON.parse(
		await readFile(join(folder, 'epicenter.json'), 'utf8'),
	);
	expect(declaration.tables.pages).toMatchObject({
		type: 'object',
		required: ['title'],
	});
	expect(Object.keys(declaration.tables)).toEqual(['pages']);
	expect(run('generate', folder).stdout).toBe(
		'unchanged epicenter.json from epicenter.ts\n',
	);

	const checked = run('check', folder);
	expect(checked.exitCode).toBe(0);
	expect(checked.stdout).toContain(
		'epicenter.json is generated from epicenter.ts',
	);
	expect(JSON.parse(run('check', folder, '--json').stdout).source).toBe(
		'epicenter.ts',
	);
	expect(run('generate', folder, '--check').stderr).toContain(
		'generate takes only a directory',
	);
	await rm(join(folder, 'epicenter.json'));
	expect(run('check', folder).stderr).toContain('run `epicenter generate');
});

test('generate refuses a folder with no epicenter.ts, no default export, or a declaration that cannot be kept', async () => {
	const { folder, write, run } = await setup();
	expect(run('generate', folder).exitCode).toBe(2);

	await write('epicenter.ts', 'export default null;\n');
	expect(run('generate', folder).stderr).toContain(
		'must `export default defineFolder',
	);
	await write(
		'epicenter.ts',
		'export default { kv: {}, tables: {}, titel: "Typo" };\n',
	);
	expect(run('generate', folder).stderr).toContain("also declares 'titel'");
	await write('epicenter.ts', 'export const nothing = 1;\n');
	const missing = run('generate', folder);
	expect(missing.exitCode).toBe(2);
	expect(missing.stderr).toContain('must `export default defineFolder');

	await write(
		'epicenter.ts',
		`export default { kv: { a: { type: 'string', format: 'date-tme' } }, tables: {} };\n`,
	);
	const refused = run('generate', folder);
	expect(refused.exitCode).toBe(2);
	expect(refused.stderr).toContain('date-tme');
	// Nothing was written over the folder's existing declaration.
	expect(
		JSON.parse(await readFile(join(folder, 'epicenter.json'), 'utf8')),
	).toEqual(declaration);
});
