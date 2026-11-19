/**
 * App runner integration tests exercise the real executable's discovery, command
 * grammar, output, and the folder and cache on disk. Broken apps must not block healthy apps.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
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
	roots.push(f.userDir);
	await f.app('reading', reading);
	await f.app('vault', vault);
	return f;
}

test('listing isolates broken imports, invalid apps, folders that cannot name an app, and a link', async () => {
	const f = await setup();
	await f.app('broken', `throw new Error('import exploded');`);
	await f.app('serve', reading);
	await f.app('invalid', `export default () => ({actions:{bad:{input:{}}}});`);
	await f.app(
		'spaced',
		`export default defineApp(() => ({ description: 'The spaced app', actions: { 'week show': defineAction({ description: 'Show', input: {}, run: () => Ok(1) }) } }));`,
	);
	await mkdir(join(f.apps, '.hidden'));
	const result = await f.run('--json');
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
	const value = JSON.parse(result.stdout).data;
	expect(value.epicenter).toBe(f.epicenter);
	expect(value.apps.map((app: { name: string }) => app.name)).toEqual([
		'reading',
		'vault',
	]);
	expect(value.apps[0].actions[0]).toMatchObject({
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
		broken: ['code/epicenter.ts: import exploded'],
		// An object default is checked as defineApp checks it, since defineApp returns its argument.
		invalid: [
			'code/epicenter.ts: An app needs a description',
			"code/epicenter.ts: actions.bad is not an action: each action has one name, such as actions: { 'create-word': createWord }",
		],
		// An action's name is one key: a space cannot join two words of one.
		spaced: [
			'code/epicenter.ts: actions has the key "week show", which is not lowercase letters, digits, and dashes, starting with a letter',
		],
		serve: [
			'its folder\'s name cannot name an app: "serve" is an epicenter command',
		],
	});
	expect(value.problems[2]).toMatchObject({
		entry: 'serve',
	});
	const human = await f.run();
	expect(human.stdout).toContain('Problems:');
	expect(human.stdout).toEndWith(
		'\nNo routines. Add routines/<name>.md with cron and action.\n',
	);
	expect(human.stdout).toContain('import exploded');
	expect(human.stdout).not.toContain('epicenter reading');
	expect((await f.run('reading')).stdout).toContain(
		'epicenter reading week-summary\n    Weekly minutes (read-only)',
	);
});

test('commands write disk data and return one JSON answer without diagnostics', async () => {
	const f = await setup();
	const result = await f.run(
		'reading',
		'log',
		'{"minutes":30,"book":"Dune"}',
		'--json',
	);
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
	expect(JSON.parse(result.stdout)).toEqual({
		data: { minutes: 30, book: 'Dune' },
		error: null,
	});
	expect(
		JSON.parse(
			await readFile(join(f.apps, 'reading/data/records/log.json'), 'utf8'),
		),
	).toEqual({ minutes: 30, book: 'Dune' });
	const human = await f.run('reading', 'log', '{"minutes":15}');
	expect(human.stdout).toContain('minutes: 15');
	expect(human.stderr).toBe('');
	expect(
		(await f.run('vault', 'show-day', '{"day":"2026-11-08"}', '--json')).stdout,
	).toBe('{"data":{"day":"2026-11-08"},"error":null}\n');
});

test('usage errors return exit 2 and exactly one JSON error', async () => {
	const f = await setup();
	const cases: [string[], string][] = [
		[['nope'], 'nope'],
		[['reading', 'nope'], 'reading has no action "nope"; its actions: log,'],
		[
			['reading', 'lgo', '{"minutes":3}'],
			'reading has no action "lgo"; its actions: log, week-summary,',
		],
		[['reading', 'log', '{"minutes":3,"nope":1}'], '"nope" is not a key'],
		[['reading', 'log'], 'minutes is needed'],
		[['reading', 'log', '{"minutes":"oops"}'], 'minutes must be a number'],
		[['reading', 'log', '{"minutes":3}', '{}'], 'one argument'],
		[['reading', 'tag', '{"done":"maybe"}'], 'done must be true or false'],
		[
			['reading', 'log', '{"minutes":3}', '--version'],
			'--version stands alone',
		],
		[['setup'], 'Unknown app "setup"'],
		[['Setup', 'add'], 'Unknown app "Setup"'],
		[['setup', 'add'], 'Unknown app "setup"'],
		// --help answers a mistyped action as a call does.
		[
			['reading', 'lgo', '--help'],
			'reading has no action "lgo"; its actions: log, week-summary,',
		],
		// Not names: sent as they are, they would reach / or the root.
		[['..', 'add'], 'Unknown app ".."'],
		[['.', 'add'], 'Unknown app "."'],
		[['', 'add'], 'Unknown app ""'],
		[['..'], 'Unknown app ".."'],
	];
	for (const [args, message] of cases) {
		const result = await f.run(...args, '--json');
		expect(result.code).toBe(2);
		expect(result.stderr).toBe('');
		expect(result.stdout.trim().split('\n')).toHaveLength(1);
		// An action call and a bare word answer the same way.
		expect(JSON.parse(result.stdout)).toEqual({
			data: null,
			error: {
				name: 'NotStarted',
				message: expect.stringContaining(message),
				next: expect.any(String),
			},
		});
	}
	expect((await f.run('mcp', 'nope')).code).toBe(2);
});

test("every command's --json is one { data, error } answer, and its exit code follows the error's name", async () => {
	const f = await setup();
	const answered: [string[], 0 | 2][] = [
		[[], 0],
		[['reading'], 0],
		[['reading', 'log', '--help'], 0],
		[['--version'], 0],
		[['--help'], 0],
		[['nope'], 2],
		[['check'], 2],
		[['serve'], 2],
	];
	for (const [words, code] of answered) {
		const result = await f.run(...words, '--json');
		const answer = JSON.parse(result.stdout);
		expect({ words, code: result.code, keys: Object.keys(answer) }).toEqual({
			words,
			code,
			keys: ['data', 'error'],
		});
		if (code === 0) expect(answer.error).toBeNull();
		else
			expect({ words, data: answer.data, name: answer.error.name }).toEqual({
				words,
				data: null,
				name: 'NotStarted',
			});
	}
});

test('bare epicenter reports routines after the apps, each checked when serve started, and changes nothing', async () => {
	const f = await setup();
	await f.folder(f.epicenter, {
		'routines/review.md':
			'---\ncron: "0 8 * * *"\naction: "reading log"\ninput: {"minutes": 30, "book": "it\'s here"}\n---\n',
		'routines/broken.md':
			'---\ncron: "61 * * * *"\naction: "reading log"\n---\n',
		'routines/old.md': '---\ncron: "0 8 * * *"\nrun: ["true"]\n---\n',
		'routines/sing.md': '---\ncron: "0 8 * * *"\naction: "reading sing"\n---\n',
		'routines/unfit.md':
			'---\ncron: "0 8 * * *"\naction: "reading log"\ninput: {"minutes": "many"}\n---\n',
	});
	// Every file in the Epicenter outside its install, with its text.
	const state = async () => {
		const files: Record<string, string> = {};
		for (const entry of await readdir(f.epicenter, {
			recursive: true,
			withFileTypes: true,
		})) {
			const path = join(entry.parentPath, entry.name);
			if (entry.isFile() && !path.includes('node_modules'))
				files[path] = await readFile(path, 'utf8');
		}
		return files;
	};
	const before = await state();

	const listed = await f.run('--json');
	expect(listed.code).toBe(0);
	const value = JSON.parse(listed.stdout).data;
	expect(value.apps.map((app: { name: string }) => app.name)).toEqual([
		'reading',
		'vault',
	]);
	expect(value.routines).toEqual([
		{
			name: 'broken',
			problem:
				'cron must be a five-field cron expression such as "0 8 * * *" with a future occurrence',
		},
		{
			name: 'old',
			problem:
				'needs exactly cron: "<minute hour day month weekday>" and action: "<app> <action>", and may have input: {...}',
		},
		{
			name: 'review',
			cron: '0 8 * * *',
			next: expect.any(String),
			app: 'reading',
			action: 'log',
			input: { minutes: 30, book: "it's here" },
		},
		{
			name: 'sing',
			problem:
				'reading has no action "sing"; its actions: log, week-summary, tag, collect, inspect, explode',
		},
		{ name: 'unfit', problem: 'input: minutes must be a number' },
	]);
	// The version the Epicenter has installed, read from its node_modules.
	expect(value.version).toBe(packageJson.version);
	expect(Object.keys(value)).toEqual([
		'epicenter',
		'version',
		'apps',
		'problems',
		'routines',
	]);
	expect(Date.parse(value.routines[2].next)).toBeGreaterThan(Date.now());

	const human = await f.run();
	expect(human.code).toBe(0);
	expect(human.stdout).toStartWith(
		`Epicenter: Epicenter (${f.epicenter})\nVersion: ${packageJson.version}\nreading`,
	);
	expect(human.stdout).toEndWith(
		`
Run: epicenter <app>

Routines:
  broken: ${value.routines[0].problem}
  old: ${value.routines[1].problem}
  review: cron 0 8 * * *, next ${value.routines[2].next}
    reading log {"minutes":30,"book":"it's here"}
  sing: reading has no action "sing"; its actions: log, week-summary, tag, collect, inspect, explode
  unfit: input: minutes must be a number
`,
	);
	expect(await state()).toEqual(before);
});

test('a misused command answers its usage line, with its help as the next step', async () => {
	const f = await setup();
	for (const words of [['reading'], ['--from', './x']]) {
		const result = await f.run('serve', ...words, '--json');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout)).toEqual({
			data: null,
			error: {
				name: 'NotStarted',
				message: 'Usage: epicenter serve',
				next: 'epicenter serve --help',
			},
		});
	}
	expect(JSON.parse((await f.run('serve', '--json')).stdout)).toMatchObject({
		data: null,
		error: { name: 'NotStarted' },
	});
	expect((await f.run('serve', '--help')).stdout).toContain(
		'POST /actions/<app>/<action>',
	);
});

test('a throwing action returns exit 1 with its message', async () => {
	const f = await setup();
	const { code, stdout, stderr } = await f.run('reading', 'explode', '--json');
	expect({ code, stderr }).toEqual({ code: 1, stderr: '' });
	expect(JSON.parse(stdout)).toEqual({
		data: null,
		error: {
			name: 'Threw',
			message: 'action exploded',
		},
	});
});

test('a failed stdout write after the action runs never emits a refusal or retries its effects', async () => {
	const f = await fixture();
	roots.push(f.userDir);
	await f.app(
		'counts',
		`export default defineApp(({ folder }) => ({description:'Counts',actions:{
		increment:defineAction({description:'Increment',input:{}, async run(){
			await folder.edit('local/count', (value = '0') => Ok({ text: String(Number(value) + 1) }));
			return Ok('done');
		}}),
	}}));`,
	);
	const preload = join(f.userDir, 'fail-first-output.ts');
	await writeFile(
		preload,
		`
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = (...args) => {
			process.stdout.write = write;
			throw new Error('simulated output failure');
		};
	`,
	);
	await f.serve();
	const child = Bun.spawn(
		[
			process.execPath,
			'--preload',
			preload,
			f.bin,
			'counts',
			'increment',
			'--json',
		],
		{
			cwd: f.epicenter,
			env: f.env,
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ stdout, stderr, code }).toEqual({
		stdout: '',
		code: 1,
		stderr:
			'serve took the action, but its outcome could not be reported: simulated output failure\n',
	});
	expect(await readFile(join(f.apps, 'counts/local/count'), 'utf8')).toBe('1');
});

test('a run uses its own app folder and local files', async () => {
	const f = await setup();
	const result = await f.run('reading', 'inspect', '--json');
	expect(result.code).toBe(0);
	const value = JSON.parse(result.stdout).data;
	expect(value.folder).toBe(join(f.apps, 'reading'));
	expect(
		await Bun.file(join(f.apps, 'reading', 'local/index.json')).exists(),
	).toBe(true);
});

test('app and action views include locations, schemas, field help and version', async () => {
	const f = await setup();
	const view = JSON.parse((await f.run('reading', '--json')).stdout).data;
	expect(view.name).toBe('reading');
	expect(view).not.toHaveProperty('keychain');
	expect((await f.run('reading')).stdout).toContain('folder:');
	expect((await f.run('reading', 'log', '-h')).stdout).toContain(
		'  minutes  required  a number',
	);
	expect(
		JSON.parse((await f.run('reading', 'log', '--help', '--json')).stdout),
	).toMatchObject({
		data: { name: 'reading_log', inputSchema: { type: 'object' } },
		error: null,
	});
	expect(await f.run('--version', '--json')).toEqual({
		code: 0,
		stdout: `{"data":{"version":"${packageJson.version}"},"error":null}\n`,
		stderr: '',
	});
	expect(await f.run('--version')).toEqual({
		code: 0,
		stdout: `epicenter ${packageJson.version}\n`,
		stderr: '',
	});
	const help = JSON.parse((await f.run('--help', '--json')).stdout);
	expect(help.error).toBeNull();
	expect(help.data).toContain('Exit codes:');
	expect((await f.run('--help')).stdout).toContain('Exit codes:');
});

test('an empty Epicenter says what an app is', async () => {
	const f = await fixture();
	roots.push(f.userDir);
	expect((await f.run()).stdout).toContain(
		'No apps yet. An app is apps/<name>/code/epicenter.ts',
	);
});

test('an app is named by its folder in the Epicenter, whatever its description says', async () => {
	const f = await setup();
	await f.app('other-name', reading);
	const listed = JSON.parse((await f.run('--json')).stdout).data;
	expect(listed.apps.map((app: { name: string }) => app.name)).toContain(
		'other-name',
	);
	const result = await f.run('other-name', 'log', '{"minutes":30}', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).data).toEqual({ minutes: 30 });
});
