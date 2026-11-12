/**
 * App runner integration tests exercise the real executable's discovery, command
 * grammar, output, and the folder and cache on disk. Broken apps must not block healthy apps.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { COMMANDS } from './commands.ts';
import { fixture, gitIn, reading, vault } from './runner.test-support.ts';

// Each test runs the real command several times as separate processes.
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
	await f.app('reading', reading);
	await f.app('vault', vault);
	return f;
}

test("listing warns when the data's code commit is absent from the code's history", async () => {
	const f = await setup();
	const app = join(f.apps, 'reading');
	const writtenUnder = await gitIn(app, 'rev-parse', 'HEAD');
	expect((await f.run('reading', 'log', '30')).code).toBe(0);
	const tree = await gitIn(app, 'rev-parse', 'HEAD^{tree}');
	const unrelated = await gitIn(
		app,
		'commit-tree',
		tree,
		'-m',
		'unrelated code',
	);
	await gitIn(app, 'reset', '--soft', unrelated);
	const listed = JSON.parse((await f.run('reading', '--json')).stdout);
	expect(listed.status.data.otherCode).toBe(writtenUnder.slice(0, 12));
	expect((await f.run('reading')).stdout).toContain(
		`data: written under code ${writtenUnder.slice(0, 12)}, which this code's history does not have`,
	);
});

test('listing isolates broken imports, invalid apps and folders that cannot name an app, and shows linked apps', async () => {
	const f = await setup();
	await f.app('broken', `throw new Error('import exploded');`);
	await f.app('sync', reading);
	await f.app('invalid', `export default {actions:{bad:{input:{}}}};`);
	await f.app(
		'spaced',
		`export default defineApp({ description: 'The spaced app', collections: {}, actions: { 'week show': defineAction({ description: 'Show', input: {}, run: () => 1 }) } });`,
	);
	const linked = await f.app(
		'linked',
		`export default defineApp({ description: 'The linked app', collections: {}, actions: {} });`,
		f.root,
	);
	await symlink(linked, join(f.apps, 'linked'));
	await mkdir(join(f.apps, '.hidden'));
	const result = await f.run('--json');
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
	const value = JSON.parse(result.stdout);
	expect(value.epicenter).toBe(f.home);
	expect(value.apps.map((app: { name: string }) => app.name)).toEqual([
		'linked',
		'reading',
		'vault',
	]);
	expect(value.apps[0].link).toBe(linked);
	expect(value.apps[1].actions[0]).toMatchObject({
		name: 'reading_log',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: { minutes: { type: 'number' } },
		},
	});
	expect(JSON.stringify(value.apps)).not.toContain('positional');
	expect(JSON.stringify(value.apps)).not.toContain('~kind');
	expect(
		Object.fromEntries(
			value.problems.map((app: { entry: string; problems: string[] }) => [
				app.entry,
				app.problems,
			]),
		),
	).toEqual({
		broken: ['epicenter.ts: import exploded'],
		// An object default is checked as defineApp checks it, since defineApp returns its argument.
		invalid: [
			'epicenter.ts: An app needs a description',
			'epicenter.ts: An app needs collections: an object of defineCollection(...), {} for none',
		],
		// An action's words are its keys' path: one key holds one word.
		spaced: [
			'epicenter.ts: actions has the key "week show" at actions.week show, which is not lowercase letters, digits, and dashes, starting with a letter',
		],
		sync: [
			'its folder\'s name cannot name an app: "sync" is an epicenter command',
		],
	});
	expect(value.problems[3]).toMatchObject({
		entry: 'sync',
		folder: join(f.apps, 'sync'),
	});
	const human = await f.run();
	expect(human.stdout).toContain('Problems:');
	expect(human.stdout).toContain('import exploded');
	expect(human.stdout).toContain(`-> ${linked}`);
	expect(human.stdout).not.toContain('epicenter reading');
	expect((await f.run('reading')).stdout).toContain(
		'epicenter reading week summary\n    Weekly minutes (read-only)',
	);
});

test('commands write disk data and return one JSON answer without diagnostics', async () => {
	const f = await setup();
	const result = await f.run(
		'reading',
		'log',
		'30',
		'--book',
		'Dune',
		'--json',
	);
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
	expect(JSON.parse(result.stdout)).toEqual({
		returned: { minutes: 30, book: 'Dune' },
	});
	expect(
		JSON.parse(
			await readFile(join(f.apps, 'reading/data/records/log.json'), 'utf8'),
		),
	).toEqual({ minutes: 30, book: 'Dune' });
	const human = await f.run('reading', 'log', '15');
	expect(human.stdout).toContain('minutes: 15');
	expect(human.stderr).toBe('');
	expect(
		(await f.run('vault', 'calendar', 'show', '2026-11-08', '--json')).stdout,
	).toBe('{"returned":{"day":"2026-11-08"}}\n');
});

test('negative numbers work as positional, separate flag and inline flag values', async () => {
	const f = await setup();
	for (const args of [['-3'], ['--minutes', '-3'], ['--minutes=-3']]) {
		const result = await f.run('reading', 'log', ...args, '--json');
		expect(result.code).toBe(0);
		expect(result.stderr).toBe('');
		expect(JSON.parse(result.stdout).returned).toEqual({ minutes: -3 });
	}
});

test('usage errors return exit 2 and exactly one JSON error', async () => {
	const f = await setup();
	const cases: [string[], string][] = [
		[['nope'], 'nope'],
		[['reading', 'nope'], 'reading has no action "nope". Its actions:'],
		[
			['reading', 'lgo', '3'],
			'reading has no action "lgo". Its actions:\nepicenter reading log <minutes> [--flags]\nepicenter reading week summary\n',
		],
		[['reading', 'log', '3', '--nope'], '--nope'],
		[['reading', 'log'], '<minutes> is needed'],
		[['reading', 'log', 'oops'], 'number'],
		[['reading', 'log', '3', '4'], 'positional'],
		[['reading', 'log', '3', '--book', 'a', '--book', 'b'], '--book'],
		[['reading', 'log', '3', '--minutes', '4'], '--minutes'],
		[['reading', 'log', '3', '--book'], 'needs a value'],
		[['reading', 'tag', '--done=maybe'], 'takes no value, or =true or =false'],
		[['reading', 'log', '3', '--version'], '--version'],
		[['setup'], 'Unknown app "setup"'],
	];
	for (const [args, message] of cases) {
		const result = await f.run(...args, '--json');
		expect(result.code).toBe(2);
		expect(result.stderr).toBe('');
		expect(result.stdout.trim().split('\n')).toHaveLength(1);
		expect(JSON.parse(result.stdout).error).toMatchObject({
			name: 'Usage',
			message: expect.stringContaining(message),
		});
	}
	expect((await f.run('mcp', 'nope')).code).toBe(2);
});

test('a misused command answers its usage line, with its help as the next step', async () => {
	const f = await setup();
	const misused = [
		['sync', '-m', 'tidy'],
		['sync', 'reading', '-m'],
		['history'],
		['history', 'reading', '--limit', '0'],
		['undo', 'reading', 'a', 'b'],
		['new'],
		['new', 'garden', '--from'],
		['build', 'reading', 'vault'],
		['install', 'reading', 'vault'],
		['update', '--nope'],
		['init', '--port'],
	] as const;
	for (const [command, ...words] of misused) {
		const result = await f.run(command, ...words, '--json');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error).toEqual({
			name: 'Usage',
			message: `Usage: ${COMMANDS[command].usage}`,
			next: `epicenter ${command} --help`,
		});
	}
	expect(await f.run('serve', '--port', '70000')).toEqual({
		code: 2,
		stdout: '',
		stderr: `--port must be a whole number from 0 to 65535\nUsage: ${COMMANDS.serve.usage}\nRun: epicenter serve --help\n`,
	});
	expect((await f.run('sync', '--help')).stdout).toBe(
		`${COMMANDS.sync.usage}\n${COMMANDS.sync.help}\n`,
	);
});

test('lists repeat, switches default and literal positionals append to flagged values', async () => {
	const f = await setup();
	const answer = async (...args: string[]) =>
		JSON.parse((await f.run(...args, '--json')).stdout).returned;
	expect(await answer('reading', 'tag')).toEqual({ tags: [], done: false });
	expect(await answer('reading', 'tag', '--done=true')).toEqual({
		tags: [],
		done: true,
	});
	expect(await answer('reading', 'tag', '--done=false')).toEqual({
		tags: [],
		done: false,
	});
	expect(
		await answer('reading', 'tag', '--tags', 'a', '--tags=b', '--done'),
	).toEqual({ tags: ['a', 'b'], done: true });
	expect(
		(await f.run('reading', 'collect', '--tags', 'a', 'b', '--', '--literal'))
			.stdout,
	).toBe('tags: ["a","b","--literal"]\n');
});

test('a throwing action returns exit 1 with its message', async () => {
	const f = await setup();
	expect(await f.run('reading', 'explode', '--json')).toEqual({
		code: 1,
		stdout: '{"threw":{"message":"action exploded"}}\n',
		stderr: '',
	});
});

test('runs use the selected Epicenter and their own local files', async () => {
	const f = await setup();
	const result = await f.runIn(
		join(f.apps, 'reading'),
		'reading',
		'inspect',
		'--json',
	);
	expect(result.code).toBe(0);
	const value = JSON.parse(result.stdout).returned;
	expect(value.folder).toBe(join(f.apps, 'reading'));
	expect(
		await Bun.file(join(f.apps, 'reading', 'data/index.local.json')).exists(),
	).toBe(true);
	const target = await f.app(
		'linked',
		`export default defineApp({ description: 'The linked app', collections: {}, actions: {} });`,
		f.root,
	);
	await symlink(target, join(f.apps, 'linked'));
	expect(JSON.parse((await f.run('linked', '--json')).stdout).link).toBe(
		target,
	);
	const homeRun = JSON.parse(
		(await f.run('reading', 'inspect', '--json')).stdout,
	).returned;
	expect(homeRun.folder).toBe(join(f.apps, 'reading'));
	expect(
		await Bun.file(join(f.apps, 'reading/data/index.local.json')).exists(),
	).toBe(true);
});

test('app and action views include locations, schemas, field help and version', async () => {
	const f = await setup();
	const view = JSON.parse((await f.run('reading', '--json')).stdout);
	expect(view.name).toBe('reading');
	expect(view).not.toHaveProperty('keychain');
	expect((await f.run('reading')).stdout).toContain('folder:');
	expect((await f.run('reading', 'log', '-h')).stdout).toContain(
		'<minutes>, --minutes <number>  required.',
	);
	expect(
		JSON.parse((await f.run('reading', 'log', '--help', '--json')).stdout),
	).toMatchObject({ name: 'reading_log', inputSchema: { type: 'object' } });
	expect(JSON.parse((await f.run('--version', '--json')).stdout)).toEqual({
		version: '0.0.1',
	});
	expect((await f.run('--help')).stdout).toContain('Exit codes:');
	expect((await f.run('--help')).stdout).toContain('epicenter install [<app>]');
	expect((await f.run('install', '--help')).stdout).toBe(
		`${COMMANDS.install.usage}\n${COMMANDS.install.help}\n`,
	);
});

test('an empty Epicenter lists its next step and a missing marker suggests init', async () => {
	const f = await fixture();
	roots.push(f.root);
	expect((await f.run()).stdout).toContain(
		'No apps yet. Run: epicenter new <name>',
	);
	await rm(f.home, { recursive: true });
	expect((await f.run('--json')).code).toBe(2);
	expect((await f.run()).stderr).toContain(`epicenter init ${f.home}`);
	const missing = await f.run('reading', '--json');
	expect(missing.code).toBe(2);
	expect(JSON.parse(missing.stdout).error.message).toContain('EPICENTER.md');
	expect(JSON.parse(missing.stdout).error.next).toBe(
		`epicenter init ${f.home}`,
	);
});

test('an app is named by its folder in the home, whatever its description says', async () => {
	const f = await setup();
	await f.app('other-name', reading);
	const listed = JSON.parse((await f.run('--json')).stdout);
	expect(listed.apps.map((app: { name: string }) => app.name)).toContain(
		'other-name',
	);
	const result = await f.run('other-name', 'log', '30', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).returned).toEqual({ minutes: 30 });
});
