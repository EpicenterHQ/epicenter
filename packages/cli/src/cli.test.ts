/**
 * App runner integration tests exercise the real executable's discovery, command
 * grammar, output, and the folder and cache on disk. Broken apps must not block healthy apps.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, reading, vault } from './runner.test-support.ts';

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

test('listing isolates broken imports, invalid apps and mismatches and shows linked apps', async () => {
	const f = await setup();
	await f.app('broken', `throw new Error('import exploded');`);
	await f.app('copy', reading, f.home, 'reading');
	await f.app('invalid', `export default {actions:{bad:{input:{}}}};`);
	const linked = await f.app(
		'linked',
		`export default defineApp(declaration, {actions:{}});`,
		f.root,
	);
	await symlink(linked, join(f.home, 'linked'));
	await mkdir(join(f.home, '.hidden'));
	const result = await f.run('--json');
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
	const value = JSON.parse(result.stdout);
	expect(value.home).toBe(f.home);
	expect(value.missing).toBeUndefined();
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
	expect(value.problems.map((app: { entry: string }) => app.entry)).toEqual([
		'broken',
		'copy',
		'invalid',
	]);
	expect(value.problems[1]).toMatchObject({
		entry: 'copy',
		folder: join(f.home, 'copy'),
	});
	expect(value.problems[1].problems).toEqual([
		'declares the name "reading" but its folder is "copy"',
	]);
	const human = await f.run();
	expect(human.stdout).toContain('Problems:');
	expect(human.stdout).toContain('import exploded');
	expect(human.stdout).toContain(`-> ${linked}`);
	expect(human.stdout).toContain('(read-only)');
	expect((await f.run('copy', '--json')).code).toBe(2);
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
			await readFile(join(f.home, 'reading/records/log.json'), 'utf8'),
		),
	).toEqual({ minutes: 30, book: 'Dune' });
	const human = await f.run('reading', 'log', '15');
	expect(human.stdout).toContain('"minutes": 15');
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
		expect(JSON.parse(result.stdout)).toEqual({ returned: { minutes: -3 } });
	}
});

test('usage errors return exit 2 and exactly one JSON error', async () => {
	const f = await setup();
	const cases: [string[], string][] = [
		[['nope'], 'nope'],
		[['reading', 'nope'], 'Unknown action'],
		[['reading', 'log', '3', '--nope'], '--nope'],
		[['reading', 'log'], '<minutes> is needed'],
		[['reading', 'log', 'oops'], 'number'],
		[['reading', 'log', '3', '4'], 'positional'],
		[['reading', 'log', '3', '--book', 'a', '--book', 'b'], '--book'],
		[['reading', 'log', '3', '--minutes', '4'], '--minutes'],
		[['reading', 'log', '3', '--book'], 'needs a value'],
		[['reading', 'tag', '--done=false'], 'takes no value'],
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

test('lists repeat, switches default and literal positionals append to flagged values', async () => {
	const f = await setup();
	const answer = async (...args: string[]) =>
		JSON.parse((await f.run(...args, '--json')).stdout).returned;
	expect(await answer('reading', 'tag')).toEqual({ tags: [], done: false });
	expect(
		await answer('reading', 'tag', '--tags', 'a', '--tags=b', '--done'),
	).toEqual({ tags: ['a', 'b'], done: true });
	expect(
		JSON.parse(
			(await f.run('reading', 'collect', '--tags', 'a', 'b', '--', '--literal'))
				.stdout,
		),
	).toEqual({ tags: ['a', 'b', '--literal'] });
});

test('a throwing action returns exit 1 with its message', async () => {
	const f = await setup();
	expect(await f.run('reading', 'explode', '--json')).toEqual({
		code: 1,
		stdout: '{"threw":{"message":"action exploded"}}\n',
		stderr: '',
	});
});

test('path runs keep declared identity and their own .cache while home aliases are refused', async () => {
	const f = await setup();
	const outside = await f.app('worktree', reading, f.root, 'reading');
	const result = await f.run(outside, 'inspect', '--json');
	expect(result.code).toBe(0);
	const value = JSON.parse(result.stdout).returned;
	expect(value.folder).toBe(outside);
	expect(value.token).toBe('round trip');
	expect(value.seed).toBe('plain seed');
	expect(value.foreign).toBeNull();
	expect(await Bun.file(join(outside, '.cache/index.json')).exists()).toBe(
		true,
	);
	const refused = await f.run(join(f.home, 'reading'), 'log', '30', '--json');
	expect(refused.code).toBe(2);
	expect(JSON.parse(refused.stdout).error.next).toBe(
		'epicenter reading log 30',
	);
	const target = await f.app(
		'linked',
		`export default defineApp(declaration, {actions:{}});`,
		f.root,
	);
	await symlink(target, join(f.home, 'linked'));
	expect(
		JSON.parse((await f.run(target, '--json')).stdout).error.message,
	).toContain('epicenter linked');
	const homeRun = JSON.parse(
		(await f.run('reading', 'inspect', '--json')).stdout,
	).returned;
	expect(homeRun.folder).toBe(join(f.home, 'reading'));
	expect(
		await Bun.file(join(f.home, 'reading/.cache/index.json')).exists(),
	).toBe(true);
});

test('app and action views include locations, schemas, field help and version', async () => {
	const f = await setup();
	const view = JSON.parse((await f.run('reading', '--json')).stdout);
	expect(view).toMatchObject({
		name: 'reading',
		keychain: 'epicenter.reading',
	});
	expect((await f.run('reading')).stdout).toContain('folder:');
	expect((await f.run('reading', 'log', '-h')).stdout).toContain(
		'--minutes (<minutes>): number, required',
	);
	expect(
		JSON.parse((await f.run('reading', 'log', '--help', '--json')).stdout),
	).toMatchObject({ name: 'reading_log', inputSchema: { type: 'object' } });
	expect(JSON.parse((await f.run('--version', '--json')).stdout)).toEqual({
		version: '0.0.1',
	});
	expect((await f.run('--help')).stdout).toContain('Exit codes:');
});

test('missing and empty homes are successful answers and missing apps suggest creating the home', async () => {
	const f = await fixture();
	roots.push(f.root);
	expect((await f.run()).stdout).toContain('There are no apps yet');
	await rm(f.home, { recursive: true });
	expect(JSON.parse((await f.run('--json')).stdout)).toEqual({
		home: f.home,
		apps: [],
		problems: [],
		missing: true,
	});
	expect((await f.run()).stdout).toContain(`mkdir ${f.home}`);
	const missing = await f.run('reading', '--json');
	expect(missing.code).toBe(2);
	expect(JSON.parse(missing.stdout).error.message).toContain('mkdir');
	expect(JSON.parse(missing.stdout).error.next).toBe(`mkdir ${f.home}`);
});

test('a name mismatch is a problem even when no other app declares that name', async () => {
	const f = await setup();
	await f.app('other-name', reading, f.home, 'elsewhere');
	const listed = JSON.parse((await f.run('--json')).stdout);
	expect(listed.problems).toContainEqual({
		entry: 'other-name',
		folder: join(f.home, 'other-name'),
		problems: ['declares the name "elsewhere" but its folder is "other-name"'],
	});
	const result = await f.run('other-name', 'log', '30', '--json');
	expect(result.code).toBe(2);
	expect(JSON.parse(result.stdout).error.message).toContain(
		'declares the name "elsewhere" but its folder is "other-name"',
	);
});
