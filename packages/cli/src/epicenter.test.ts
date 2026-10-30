/**
 * `epicenter query` against real legacy data folders, and the command
 * surface, through fresh CLI processes: exit codes, the projection's columns
 * and values, the one-statement read-only rule, and that nothing in the
 * folder is executed or changed. `check` and `format`, which take a contract,
 * are in `contract-commands.test.ts`.
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

const declaration = {
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
// epicenter.json, as query reads it
// ============================================================================

test('query reads tables despite malformed or future unrelated metadata', async () => {
	const { folder, write, run } = await setup();
	for (const metadata of [
		{ views: { broken: null }, title: false },
		{ views: { calendar: { type: 'calendar', title: 'Future view' } } },
	]) {
		const source = JSON.stringify({ ...declaration, ...metadata });
		await write('epicenter.json', source);
		const query = run('query', folder, 'SELECT stem FROM posts', '--json');
		expect(query.exitCode).toBe(0);
		expect(JSON.parse(query.stdout).rows).toEqual([{ stem: 'reel' }]);
		expect(await readFile(join(folder, 'epicenter.json'), 'utf8')).toBe(source);
	}
});

test('query leaves out a file with a key a closed table does not declare', async () => {
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
	const missing = run('query', empty);
	expect(missing.exitCode).toBe(2);
	expect(missing.stderr).toContain('has no epicenter.json');
	expect(JSON.parse(run('query', empty, '--json').stdout).error).toContain(
		'has no epicenter.json',
	);

	await write(
		'epicenter.json',
		JSON.stringify({
			tables: { 'bad name': objectSchema({}) },
		}),
	);
	expect(run('query', folder).exitCode).toBe(2);

	await write('epicenter.json', JSON.stringify({ title: 'No tables' }));
	const noTables = run('query', folder);
	expect(noTables.exitCode).toBe(2);
	expect(noTables.stderr).toContain(
		"it has no 'tables'; query requires declared table schemas",
	);
});

test('a typo epicenter.json would otherwise ignore is refused, and $schema is allowed', async () => {
	const { folder, write, run } = await setup();
	const declare = (value: object) =>
		write('epicenter.json', JSON.stringify(value));

	await declare({ ...declaration, tabels: {} });
	const extraKey = run('query', folder);
	expect(extraKey.exitCode).toBe(2);
	expect(extraKey.stderr).toContain("unknown top-level key 'tabels'");

	await declare({
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
	expect(run('query', folder).exitCode).toBe(0);
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
				tables: { posts: objectSchema(fields) },
			}),
		);
		const result = run('query', folder, 'SELECT 1');
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(message);
	}
});

test("query never runs a folder's code", async () => {
	const { folder, write, run } = await setup();
	await write(
		'epicenter.ts',
		`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(folder, 'ran'))}, 'yes');\nexport default {};`,
	);
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
		'1 file excluded because it does not conform: posts/broken.md\n',
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
	const result = run('query', folder, 'SELECT stem FROM posts', '--json');
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout).excluded).toEqual(['posts/notes.md']);
});

test('query refuses statements that write, attach, or vacuum, and leaves the directory unchanged', async () => {
	const { folder, run } = await setup();
	// Sorted: a recursive listing's order differs between file systems.
	const before = (await readdir(folder, { recursive: true })).sort();
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
	expect((await readdir(folder, { recursive: true })).sort()).toEqual(before);
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
	expect(run('check', 'contract.json', folder, 'extra').exitCode).toBe(2);
	expect(run('query', folder, 'SELECT 1', 'extra').exitCode).toBe(2);
	expect(run('validate', folder).exitCode).toBe(2);
	expect(run('--help').stdout).toContain('epicenter check <contract> [<dir>]');
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
	expect(run('sync', folder, '--interval').stderr).toContain(
		'--interval needs',
	);
	expect(run('auth').exitCode).toBe(2);
	expect(run('auth', 'approve', 'x').stderr).toContain(
		"Unknown command 'epicenter auth approve'",
	);
	// The source installer is gone, with no alias.
	for (const verb of ['list', 'install', 'update', 'remove'])
		expect(run('app', verb, 'x').stderr).toContain("Unknown command 'app'");
});

test('--help lists every command but send and install-command, and --json describes them', async () => {
	const { run } = await setup();
	const help = run('--help');
	expect(help.exitCode).toBe(0);
	for (const usage of [
		'epicenter query <dir> [<sql>]',
		'epicenter sync [<dir>] [--watch]',
		'epicenter auth git-credential get | store | erase',
	])
		expect(help.stdout).toContain(usage);
	expect(help.stdout).not.toContain('epicenter app');
	expect(help.stdout).not.toContain('epicenter send');
	expect(help.stdout).not.toContain('install-command');
	expect(help.stdout).not.toContain('--desktop');
	const described = JSON.parse(run('--help', '--json').stdout).commands;
	expect(described.map((c: { command: string }) => c.command)).toEqual([
		'schema export',
		'schema import',
		'folders pin',
		'folders unpin',
		'folders list',
		'folders remove-recent',
		'check',
		'format',
		'query',
		'init',
		'sync',
		'status',
		'clone',
		'forget',
		'repos',
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
