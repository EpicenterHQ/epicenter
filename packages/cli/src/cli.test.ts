/**
 * App runner integration tests exercise the real executable's discovery, command
 * grammar, output, and the folder and cache on disk. Broken apps must not block healthy apps.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMMANDS } from './commands.ts';
import { VERSION } from './engines.ts';
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

test('listing isolates broken imports, invalid apps and folders that cannot name an app, and lists a linked app like any other', async () => {
	const f = await setup();
	await f.app('broken', `throw new Error('import exploded');`);
	await f.app('serve', reading);
	await f.app('invalid', `export default {actions:{bad:{input:{}}}};`);
	await f.app(
		'spaced',
		`export default defineApp({ description: 'The spaced app', actions: { 'week show': defineAction({ description: 'Show', input: {}, run: () => Ok(1) }) } });`,
	);
	const linked = await f.app(
		'linked',
		`export default defineApp({ description: 'The linked app', actions: {} });`,
		// Inside the home: linked code finds packages from where it really is.
		join(f.home, 'shelf'),
	);
	await symlink(linked, join(f.apps, 'linked'));
	await mkdir(join(f.apps, '.hidden'));
	const result = await f.run('--json');
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
	const value = JSON.parse(result.stdout).data;
	expect(value.epicenter).toBe(f.home);
	expect(value.apps.map((app: { name: string }) => app.name)).toEqual([
		'linked',
		'reading',
		'vault',
	]);
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
		broken: ['code/epicenter.ts: import exploded'],
		// An object default is checked as defineApp checks it, since defineApp returns its argument.
		invalid: ['code/epicenter.ts: An app needs a description'],
		// An action's words are its keys' path: one key holds one word.
		spaced: [
			'code/epicenter.ts: actions has the key "week show" at actions.week show, which is not lowercase letters, digits, and dashes, starting with a letter',
		],
		serve: [
			'its folder\'s name cannot name an app: "serve" is an epicenter command',
		],
	});
	expect(value.problems[2]).toMatchObject({
		entry: 'serve',
		folder: join(f.apps, 'serve'),
	});
	const human = await f.run();
	expect(human.stdout).toContain('Problems:');
	expect(human.stdout).toEndWith(
		`\nNo routines. Add routines/<name>.md with cron and run.\n\nGit: ${f.home} is not a Git repository; run: git init\n`,
	);
	expect(human.stdout).toContain('import exploded');
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
		(await f.run('vault', 'calendar', 'show', '{"day":"2026-11-08"}', '--json'))
			.stdout,
	).toBe('{"data":{"day":"2026-11-08"},"error":null}\n');
});

test('usage errors return exit 2 and exactly one JSON error', async () => {
	const f = await setup();
	const cases: [string[], string][] = [
		[['nope'], 'nope'],
		[['reading', 'nope'], 'reading has no action "nope". Its actions:'],
		[
			['reading', 'lgo', '{"minutes":3}'],
			'reading has no action "lgo". Its actions:\nepicenter reading log <input>\nepicenter reading week summary\n',
		],
		[['reading', 'log', '{"minutes":3,"nope":1}'], '"nope" is not a key'],
		[['reading', 'log'], 'minutes is needed'],
		[['reading', 'log', '{"minutes":"oops"}'], 'minutes must be a number'],
		[['reading', 'log', '{"minutes":3}', '{}'], 'one argument'],
		[['reading', 'tag', '{"done":"maybe"}'], 'done must be true or false'],
		[['reading', 'log', '{"minutes":3}', '--version'], 'one argument'],
		[['setup'], 'Unknown app "setup"'],
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
				cause: 'usage',
				next: expect.any(String),
				namespace: 'epicenter/action-error',
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
		[['check', '--help'], 0],
		[['check'], 0],
		[['new', 'garden'], 0],
		[['init', join(f.root, 'other'), '--no-install'], 0],
		[['nope'], 2],
		[['check', 'nope'], 2],
		[['new'], 2],
		[['init', f.home], 2],
		[['export', 'reading'], 2],
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
	// Text prints a command's own text as it is.
	expect(await f.run('new', 'notes')).toEqual({
		code: 0,
		stdout: `${join(f.apps, 'notes')}\n`,
		stderr: `Run: cd ${f.home} && bun install && bun run build\n`,
	});
});

test('bare epicenter reports routines and the repository after the apps, and changes nothing', async () => {
	const f = await setup();
	await gitIn(f.home, 'init', '-q');
	await gitIn(f.home, 'add', '-A');
	await gitIn(f.home, 'commit', '-qm', 'start');
	await f.folder(f.home, {
		'routines/review.md':
			'---\ncron: "0 8 * * *"\nrun: ["epicenter", "reading", "week", "summary", {"note": "it\'s here"}, "two words"]\n---\n',
		'routines/broken.md': '---\ncron: "61 * * * *"\nrun: ["true"]\n---\n',
	});
	const vendor = 'apps/reading/code/vendor';
	await f.folder(join(f.home, vendor), { 'lib.ts': '' }, { git: true });
	const state = async () => [
		await gitIn(f.home, 'rev-parse', 'HEAD'),
		await gitIn(f.home, 'status', '--porcelain', '--untracked-files=all'),
	];
	const before = await state();
	// Two routine files and the nested repository, which Git shows as one path.
	expect(before[1]?.split('\n')).toHaveLength(3);

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
				'broken.md cron must be a five-field cron expression such as "0 8 * * *" with a future occurrence',
		},
		{
			name: 'review',
			cron: '0 8 * * *',
			next: expect.any(String),
			command: `epicenter reading week summary '{"note":"it'\\''s here"}' 'two words'`,
		},
	]);
	// The version the home has installed, read from its node_modules.
	expect(value.version).toBe(VERSION);
	expect(value.repository).toEqual({
		lastCommit: expect.any(String),
		uncommitted: 3,
		origin: null,
		nested: [vendor],
	});
	expect(Date.parse(value.routines[1].next)).toBeGreaterThan(Date.now());

	const human = await f.run();
	expect(human.code).toBe(0);
	expect(human.stdout).toStartWith(
		`Epicenter: Epicenter (${f.home})\nVersion: ${VERSION}\nreading`,
	);
	expect(human.stdout).toEndWith(
		`
Run: epicenter <app>

Routines:
  broken: ${value.routines[0].problem}
  review: cron 0 8 * * *, next ${value.routines[1].next}
    ${value.routines[1].command}

Git: last commit less than a minute ago; 3 files uncommitted; no origin; ${vendor} is a nested Git repository: backups hold only a pointer
`,
	);
	expect(await state()).toEqual(before);

	// With an origin, the count is of commits it does not hold yet.
	const origin = join(f.root, 'origin.git');
	await gitIn(f.root, 'init', '-q', '--bare', origin);
	await gitIn(f.home, 'remote', 'add', 'origin', origin);
	expect((await f.run()).stdout).toContain('; main is not on origin yet; ');
	await gitIn(f.home, 'push', '-q', 'origin', 'main');
	await gitIn(f.home, 'add', 'routines');
	await gitIn(f.home, 'commit', '-qm', 'routines');
	expect((await f.run()).stdout).toContain(
		'; 1 file uncommitted; 1 commit not on origin; ',
	);
});

test('a misused command answers its usage line, with its help as the next step', async () => {
	const f = await setup();
	const misused = [
		['new'],
		['new', 'garden', '--from'],
		['check', 'reading', 'vault'],
		['init', '--port'],
	] as const;
	for (const [command, ...words] of misused) {
		const result = await f.run(command, ...words, '--json');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout)).toEqual({
			data: null,
			error: {
				name: 'NotStarted',
				cause: 'usage',
				message: `Usage: ${COMMANDS[command].usage}`,
				next: `epicenter ${command} --help`,
				namespace: 'epicenter/action-error',
			},
		});
	}
	// A reason the usage line does not show is its own sentence.
	expect(await f.run('init', '--port', '0')).toEqual({
		code: 2,
		stdout: '',
		stderr:
			'--port must be a whole number from 1 to 65535\nRun: epicenter init --help\n',
	});
	expect(JSON.parse((await f.run('serve', '--json')).stdout)).toMatchObject({
		data: null,
		error: { name: 'NotStarted', cause: 'usage' },
	});
	for (const flag of ['--port', '--host'])
		expect(await f.run('serve', flag, '0')).toEqual({
			code: 2,
			stdout: '',
			stderr: `Usage: ${COMMANDS.serve.usage}\nRun: epicenter serve --help\n`,
		});
	expect((await f.run('serve', '--help')).stdout).toContain(
		'POST /<app>/<action>',
	);
	expect((await f.run('check', '--help')).stdout).toBe(
		`${COMMANDS.check.usage}\n${COMMANDS.check.help}\n`,
	);
});

test('an absent switch is false and an absent list is empty', async () => {
	const f = await setup();
	const answer = async (...args: string[]) =>
		JSON.parse((await f.run(...args, '--json')).stdout).data;
	expect(await answer('reading', 'tag')).toEqual({ tags: [], done: false });
	expect(await answer('reading', 'tag', '{"done":true}')).toEqual({
		tags: [],
		done: true,
	});
	expect(
		await answer('reading', 'tag', '{"tags":["a","--b"],"done":true}'),
	).toEqual({ tags: ['a', '--b'], done: true });
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
			namespace: 'epicenter/action-error',
		},
	});
});

test('a failed stdout write after the action runs never emits a refusal or retries its effects', async () => {
	const f = await fixture();
	roots.push(f.root);
	await f.app(
		'counts',
		`export default defineApp({description:'Counts',actions:{
		increment:defineAction({description:'Increment',input:{}, async run(){
			await folder.update('local/count', (value = '0') => String(Number(value) + 1));
			return Ok('done');
		}}),
	}});`,
	);
	const preload = join(f.root, 'fail-first-output.ts');
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
			cwd: f.root,
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
			'Epicenter invoked the action but could not report its outcome: simulated output failure\n',
	});
	expect(await readFile(join(f.apps, 'counts/local/count'), 'utf8')).toBe('1');
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
	const value = JSON.parse(result.stdout).data;
	expect(value.folder).toBe(join(f.apps, 'reading'));
	expect(
		await Bun.file(join(f.apps, 'reading', 'local/index.json')).exists(),
	).toBe(true);
	const target = await f.app(
		'linked',
		`export default defineApp({ description: 'The linked app', actions: {} });`,
		// Inside the home: linked code finds packages from where it really is.
		join(f.home, 'shelf'),
	);
	await symlink(target, join(f.apps, 'linked'));
	// A link is a folder: the app runs from where it really is.
	expect((await f.run('linked', '--json')).code).toBe(0);
	const homeRun = JSON.parse(
		(await f.run('reading', 'inspect', '--json')).stdout,
	).data;
	expect(homeRun.folder).toBe(join(f.apps, 'reading'));
	expect(
		await Bun.file(join(f.apps, 'reading/local/index.json')).exists(),
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
		stdout: `{"data":{"version":"${VERSION}"},"error":null}\n`,
		stderr: '',
	});
	expect(await f.run('--version')).toEqual({
		code: 0,
		stdout: `epicenter ${VERSION}\n`,
		stderr: '',
	});
	const help = JSON.parse((await f.run('--help', '--json')).stdout);
	expect(help.error).toBeNull();
	expect(help.data).toContain('Exit codes:');
	expect((await f.run('--help')).stdout).toContain('Exit codes:');
	expect((await f.run('--help')).stdout).not.toContain('epicenter install');
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
	const listed = JSON.parse((await f.run('--json')).stdout).data;
	expect(listed.apps.map((app: { name: string }) => app.name)).toContain(
		'other-name',
	);
	const result = await f.run('other-name', 'log', '{"minutes":30}', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).data).toEqual({ minutes: 30 });
});
