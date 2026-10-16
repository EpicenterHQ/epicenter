/**
 * `epicenter check`, `query`, and `generate` against real directories, through
 * fresh CLI processes: exit codes, compiler-style diagnostics, the projection's
 * columns and values, the one-statement read-only rule, and that nothing in the
 * folder is executed or changed.
 *
 * They run `src/bin.ts` under Bun, or the compiled binary that
 * `EPICENTER_BIN` names, so the binary the desktop app ships passes the same
 * suite:
 *
 *   EPICENTER_BIN=apps/epicenter/src-tauri/binaries/epicenter-cli-<triple> bun test src/epicenter.test.ts
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

const binary = process.env.EPICENTER_BIN;
const command = binary
	? [resolve(binary)]
	: [process.execPath, '--no-install', resolve(import.meta.dir, 'bin.ts')];
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
		const result = Bun.spawnSync([...command, ...args], {
			cwd: folder,
			stdout: 'pipe',
			stderr: 'pipe',
		});
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

	// A declaration missing a section was not generated; say how to make one.
	await write('epicenter.json', JSON.stringify({ tables: {} }));
	const noKv = run('check', folder);
	expect(noKv.exitCode).toBe(2);
	expect(noKv.stderr).toContain(
		"it has no 'kv'; every generated declaration has both, so declare the folder in epicenter.ts and run `epicenter generate`",
	);
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
// The command surface (ADR-0558)
// ============================================================================

test('a command line the grammar refuses exits 2 and says why', async () => {
	const { folder, run } = await setup();
	expect(run('open', folder).stderr).toContain("Unknown command 'open'");
	expect(run('sync', folder, '--onto', 'x').stderr).toContain(
		'epicenter sync does not take --onto',
	);
	expect(run('sync', folder, '--to').stderr).toContain('--to needs');
	expect(run('app').exitCode).toBe(2);
	expect(run('app', 'approve', 'x').stderr).toContain(
		"Unknown command 'epicenter app approve'",
	);
});

test('--help lists every command but send and install-command, and --json describes them', async () => {
	const { run } = await setup();
	const help = run('--help');
	expect(help.exitCode).toBe(0);
	for (const usage of [
		'epicenter query <dir> [<sql>]',
		'epicenter sync <dir> [--to <namespace>/<name>]',
		'epicenter app install <url> [--folder <path>] [--approve]',
		'epicenter auth git-credential get | store | erase',
		'epicenter merge-driver <dir>',
	])
		expect(help.stdout).toContain(usage);
	expect(help.stdout).not.toContain('epicenter send');
	expect(help.stdout).not.toContain('install-command');
	expect(help.stdout).not.toContain('--desktop');
	const described = JSON.parse(run('--help', '--json').stdout).commands;
	expect(described.map((c: { command: string }) => c.command)).toEqual([
		'check',
		'query',
		'generate',
		'status',
		'sync',
		'merge-driver',
		'clone',
		'repos',
		'app list',
		'app install',
		'app update',
		'app remove',
		'auth login',
		'auth logout',
		'auth status',
		'auth token',
		'auth git-credential',
		'auth key',
	]);
	expect(help.stdout).toContain('epicenter auth key set | remove | state <id>');
	expect(
		described.find((c: { command: string }) => c.command === 'sync').output,
	).toBe('ndjson');
	expect(run('auth', '--help').stdout).toContain('epicenter auth login');
	expect(run('check', '--help').stdout).toContain('compiler style');
	expect(JSON.parse(run('--version', '--json').stdout).version).toMatch(
		/^\d+\.\d+\.\d+/,
	);
});

// ============================================================================
// auth, signed out (the sign-ins themselves: auth.postgres.test.ts)
// ============================================================================

test('auth commands on a machine with no sign-in: status says so, and the rest refuse or stay silent', async () => {
	const { folder } = await setup();
	const run = (args: string[], stdin?: string) => {
		const result = Bun.spawnSync([...command, ...args], {
			cwd: folder,
			stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
			stdout: 'pipe',
			stderr: 'pipe',
			// Never the real keychain, machine state, or a real server.
			env: {
				...process.env,
				EPICENTER_TEST_SECRETS: '{}',
				EPICENTER_DATA_DIR: join(folder, '.data'),
				EPICENTER_API_URL: 'http://127.0.0.1:9',
			},
		});
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	};
	const status = run(['auth', 'status', '--json']);
	expect(status.exitCode).toBe(0);
	expect(JSON.parse(status.stdout)).toEqual({
		origin: 'http://127.0.0.1:9',
		grants: [
			{ grant: 'device', client: 'so.epicenter.cli', signedIn: false },
			{ grant: 'desktop', client: 'so.epicenter', signedIn: false },
		],
	});
	expect(run(['auth', 'status']).stdout).toContain(
		'This computer (epicenter auth login): signed out',
	);

	const token = run(['auth', 'token', '--json']);
	expect(token.exitCode).toBe(2);
	expect(JSON.parse(token.stdout).error).toContain('Run: epicenter auth login');
	const desktop = run(['auth', 'token', '--desktop']);
	expect(desktop.exitCode).toBe(2);
	expect(desktop.stderr).toContain("Sign in from Epicenter's Settings");
	expect(
		run(['auth', 'token', '--resource', 'https://example.com']).stderr,
	).toContain('is not a resource of this deployment');

	const logout = run(['auth', 'logout', '--json']);
	expect(logout.exitCode).toBe(0);
	expect(JSON.parse(logout.stdout)).toEqual({
		grant: 'device',
		signedOut: false,
		revoked: false,
	});

	// Git's protocol: another host gets no answer; this deployment's Git, when
	// signed out, an explanation on stderr; store and erase do nothing.
	const other = run(
		['auth', 'git-credential', 'get'],
		'protocol=https\nhost=github.com\n\n',
	);
	expect(other).toEqual({ exitCode: 0, stdout: '', stderr: '' });
	const ours = run(
		['auth', 'git-credential', 'get'],
		'protocol=http\nhost=127.0.0.1:9\npath=git/abc/notes.git\n\n',
	);
	expect(ours.stdout).toBe('');
	expect(ours.stderr).toContain('epicenter auth login');
	for (const action of ['store', 'erase'])
		expect(
			run(['auth', 'git-credential', action], 'protocol=http\n\n').exitCode,
		).toBe(0);
});

test('install-command refuses to link a CLI that runs from source', async () => {
	if (binary) return;
	const { run } = await setup();
	const result = run('install-command', '--json');
	expect(result.exitCode).toBe(2);
	expect(JSON.parse(result.stdout).error).toContain('runs from source');
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
	local: ['drafts/'],
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

test('generate writes the epicenter.json that epicenter.ts declares, local included, and check reads it', async () => {
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
	// What stays on this machine is part of the declaration every host reads.
	expect(declaration.local).toEqual(['drafts/']);
	expect(run('generate', folder).stdout).toBe(
		'unchanged epicenter.json from epicenter.ts\n',
	);

	const checked = run('check', folder);
	expect(checked.exitCode).toBe(0);
	expect(checked.stdout).toBe(
		'1 row conforms; 0 files invalid; 0 unreadable.\n',
	);
	expect(checked.stderr).toContain(
		'epicenter.json is generated from epicenter.ts',
	);
	expect(JSON.parse(run('check', folder, '--json').stdout).source).toBe(
		'epicenter.ts',
	);
	expect(run('generate', folder, '--check').stderr).toContain(
		'epicenter generate does not take --check',
	);
	expect(JSON.parse(run('generate', folder, '--json').stdout)).toEqual({
		written: false,
		path: 'epicenter.json',
		source: 'epicenter.ts',
	});
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
