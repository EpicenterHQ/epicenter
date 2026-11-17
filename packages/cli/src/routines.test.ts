/**
 * Home routine acceptance tests.
 *
 * Exercise real CLI commands, local state, and serve startup. Catch-up
 * coalesces missed occurrences; a run that did not succeed stays visible until
 * the schedule's next occurrence, and drafts survive reruns.
 */
import { afterEach, expect, test } from 'bun:test';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRoutines } from './routines.ts';
import { fixture, startServe } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function setup(
	run = [process.execPath, '-e', 'console.log("review ready")'],
	extra = '',
) {
	const f = await fixture();
	// Bun's test runner can use UTC while a fresh CLI uses the host's zone.
	f.env.TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
	roots.push(f.root);
	const directory = join(f.home, 'routines');
	await mkdir(directory);
	await writeFile(
		join(directory, 'review.md'),
		`---\ncron: "0 8 * * *"\nrun: ${JSON.stringify(run)}\n${extra}---\nA daily review.\n`,
	);
	const routines = createRoutines({ folder: f.home });
	const state = () =>
		readFile(join(directory, 'review.local/state.json'), 'utf8').then(
			JSON.parse,
		);
	return { ...f, directory, routines, state };
}

async function eventually(check: () => Promise<boolean>) {
	const deadline = Date.now() + 8000;
	while (!(await check())) {
		if (Date.now() > deadline)
			throw new Error('The expected routine outcome did not arrive');
		await Bun.sleep(20);
	}
}

test('serve catches up once, runs an app action in isolation, and keeps completion across restarts', async () => {
	const f = await setup(['epicenter', 'counter', 'add']);
	const app = await f.app(
		'counter',
		`export default defineApp({ description: 'Counter', collections: {}, actions: {
    add: defineAction({ description: 'Count', input: {}, run: async () => {
      const count = Number(await folder.read('data/count.txt') ?? 0) + 1;
      await folder.write('data/count.txt', String(count)); return Ok(count);
    } })
  } });`,
	);
	await mkdir(join(f.directory, 'review.local'));
	await writeFile(
		join(f.directory, 'review.local/state.json'),
		'{"started":"2000-01-01T08:00:00.000Z","finished":"2000-01-01T08:00:01.000Z","exitCode":0}\n',
	);
	const served = await startServe(f);
	try {
		await eventually(
			async () => (await f.routines.list())[0]?.status === 'succeeded',
		);
		expect(await readFile(join(app, 'data/count.txt'), 'utf8')).toBe('1');
		expect((await f.state()).started).not.toStartWith('2000');
		expect((await fetch(served.base)).status).toBe(200);
	} finally {
		await served.stop();
	}
	const restarted = await startServe(f);
	try {
		await Bun.sleep(150);
		expect(await readFile(join(app, 'data/count.txt'), 'utf8')).toBe('1');
		expect((await f.run('routines', '--json')).stdout).toContain('succeeded');
	} finally {
		await restarted.stop();
	}
}, 30_000);

test('a failed command waits for the next occurrence and an explicit run can repair it', async () => {
	const f = await setup([
		process.execPath,
		'-e',
		'console.error("offline"); process.exit(7)',
	]);
	await f.routines.check();
	await eventually(
		async () => (await f.routines.list())[0]?.status === 'failed',
	);
	const failed = await f.state();
	expect(failed.exitCode).toBe(7);
	await f.routines.check();
	expect(await f.state()).toEqual(failed);
	const restarted = createRoutines({ folder: f.home });
	await restarted.check();
	expect(await f.state()).toEqual(failed);
	await writeFile(
		join(f.directory, 'review.md'),
		'---\ncron: "0 8 * * *"\nrun: ["bun", "-e", "console.log(123)"]\n---\n',
	);
	const result = await f.run('routines', 'run', 'review', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).exitCode).toBe(0);
	const log = await readFile(
		join(f.directory, 'review.local/output.log'),
		'utf8',
	);
	// The log holds the latest run only.
	expect(log).not.toContain('offline');
	expect(log).toContain('123');
});

test('a routine action exiting its process cannot stop the HTTP server', async () => {
	const f = await setup(['epicenter', 'crash', 'now']);
	await f.app(
		'crash',
		`export default defineApp({ description: 'Crash', collections: {}, actions: {
    now: defineAction({ description: 'Exit', input: {}, run: () => process.exit(9) })
  } });`,
	);
	const served = await startServe(f);
	try {
		await eventually(
			async () => (await f.routines.list())[0]?.status === 'failed',
		);
		expect((await f.state()).exitCode).toBe(9);
		expect((await fetch(served.base)).status).toBe(200);
	} finally {
		await served.stop();
	}
}, 30_000);

test('invalid definitions and corrupted state block execution without stopping valid routines', async () => {
	const f = await setup();
	await writeFile(
		join(f.directory, 'invalid.md'),
		'---\ncron: "61 * * * *"\nrun: ["bun", "--version"]\n---\n',
	);
	// A line that is not JSON is not read as absent here: timeout: 1s must not run.
	await writeFile(
		join(f.directory, 'bare.md'),
		'---\ncron: "0 8 * * *"\nrun: ["bun", "--version"]\ntimeout: 1s\n---\n',
	);
	await mkdir(join(f.directory, 'review.local'));
	await writeFile(
		join(f.directory, 'review.local/state.json'),
		'{"completed":"yesterday"}',
	);
	await writeFile(
		join(f.directory, 'working.md'),
		'---\ncron: "0 8 * * *"\nrun: ["bun", "--version"]\n---\n',
	);
	await f.routines.check();
	await eventually(async () =>
		(await f.routines.list()).some(
			(row) => row.name === 'working' && row.status === 'succeeded',
		),
	);
	const rows = await f.routines.list();
	expect(
		rows.filter((row) => row.status === 'invalid').map((row) => row.name),
	).toEqual(['bare', 'invalid', 'review']);
	expect(
		await readFile(join(f.directory, 'review.local/state.json'), 'utf8'),
	).toBe('{"completed":"yesterday"}');
});

test('arguments are passed without a shell', async () => {
	const literal = '$(echo accidental-shell)';
	const f = await setup([
		process.execPath,
		'-e',
		'console.log(process.argv.at(-1))',
		literal,
	]);
	await f.routines.run('review');
	const log = await readFile(
		join(f.directory, 'review.local/output.log'),
		'utf8',
	);
	expect(log.split('\n').filter((line) => line === literal)).toHaveLength(1);
});

test('the daily task review writes a draft, excludes completed tasks, and preserves edits on rerun', async () => {
	const f = await setup(['bun', 'scripts/daily-task-review.ts']);
	await mkdir(join(f.home, 'scripts'));
	await copyFile(
		join(import.meta.dir, '../examples/daily-task-review.ts'),
		join(f.home, 'scripts/daily-task-review.ts'),
	);
	await f.app(
		'tasks',
		`export default defineApp({ description: 'Tasks', collections: {}, actions: {
    list: defineAction({ description: 'Tasks', input: {}, run: () => Ok([
      Ok({ path: 'data/tasks/one.md', title: 'An overdue task', done: false, due: '2000-01-01' }),
      Ok({ path: 'data/tasks/two.md', title: 'Already completed', done: true }),
      Ok({ path: 'data/tasks/three.md', title: 'Undated task', done: false })
    ]) })
  } });`,
	);
	const result = await f.run('routines', 'run', 'review', '--json');
	expect(result.code).toBe(0);
	const today = new Date();
	const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
	const draft = join(f.home, 'drafts', `task-review-${day}.md`);
	const text = await readFile(draft, 'utf8');
	expect(text).toContain('status: "draft"');
	expect(text).toContain('An overdue task');
	expect(text).toContain('../apps/tasks/data/tasks/one.md');
	expect(text).not.toContain('Already completed');
	expect(text).toContain('2 open tasks.');
	await writeFile(draft, 'My edited draft\n');
	expect((await f.run('routines', 'run', 'review')).code).toBe(0);
	expect(await readFile(draft, 'utf8')).toBe('My edited draft\n');
});

test('the next occurrence follows local calendar days and daylight-saving gaps', async () => {
	const f = await setup();
	const modulePath = join(import.meta.dir, 'routines.ts');
	// Run once, then read the status just before and just after the next occurrence.
	const statuses = async (started: string, before: string, after: string) => {
		const child = Bun.spawn(
			[
				process.execPath,
				'-e',
				`
    import { createRoutines } from ${JSON.stringify(modulePath)};
    const routines = createRoutines({ folder: ${JSON.stringify(f.home)} });
    await routines.run('review', new Date(${JSON.stringify(started)}));
    const at = async (when) => (await routines.list(new Date(when)))[0].status;
    console.log(JSON.stringify([await at(${JSON.stringify(before)}), await at(${JSON.stringify(after)})]));
  `,
			],
			{
				env: { ...process.env, TZ: 'America/Los_Angeles' },
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
		return JSON.parse(stdout);
	};
	// 08:00 local is 16:00Z before the change and 15:00Z after it.
	expect(
		await statuses(
			'2026-03-07T16:01:00Z',
			'2026-03-08T14:59:00Z',
			'2026-03-08T15:01:00Z',
		),
	).toEqual(['succeeded', 'due']);
	// 02:30 does not exist on 2026-03-08; the occurrence moves forward to 03:30 PDT.
	await writeFile(
		join(f.directory, 'review.md'),
		'---\ncron: "30 2 * * *"\nrun: ["bun", "--version"]\n---\n',
	);
	await rm(join(f.directory, 'review.local'), { recursive: true });
	expect(
		await statuses(
			'2026-03-07T10:31:00Z',
			'2026-03-08T10:29:00Z',
			'2026-03-08T10:31:00Z',
		),
	).toEqual(['succeeded', 'due']);
});

test('a failed manual run stays visible until the next occurrence', async () => {
	const f = await setup();
	await f.routines.run('review');
	await writeFile(
		join(f.directory, 'review.md'),
		'---\ncron: "0 8 * * *"\nrun: ["bun", "-e", "process.exit(4)"]\n---\n',
	);
	await f.routines.run('review');
	const failed = await f.state();
	expect((await f.routines.list())[0]?.status).toBe('failed');
	await f.routines.check();
	expect(await f.state()).toEqual(failed);
	const nextDay = new Date();
	nextDay.setDate(nextDay.getDate() + 1);
	const restarted = createRoutines({ folder: f.home });
	expect((await restarted.list(nextDay))[0]?.status).toBe('due');
	await restarted.check(nextDay);
	await eventually(async () => (await f.state()).started !== failed.started);
});

test('invalid saved fields block execution without rewriting the state', async () => {
	const f = await setup();
	const local = join(f.directory, 'review.local');
	await mkdir(local);
	for (const state of [
		// Earlier state shapes are refused, not guessed at.
		{ completed: '2026-11-14T08:00:00.000Z' },
		{ attempt: { started: '2026-11-14T08:01:00.000Z', outcome: 'failed' } },
		{ started: '2026-13-14T08:01:00.000Z' },
		{ started: '2026-11-14T08:01:00Z' },
		{ started: '2026-11-14T08:01:00.000Z', exitCode: 'done' },
	]) {
		const raw = JSON.stringify(state);
		await writeFile(join(local, 'state.json'), raw);
		const runner = createRoutines({ folder: f.home });
		expect((await runner.list())[0]?.status).toBe('invalid');
		await expect(runner.run('review')).rejects.toThrow('state.json');
		expect(await readFile(join(local, 'state.json'), 'utf8')).toBe(raw);
	}
});

test('a last start later than now is due, so a corrected clock cannot stall a routine', async () => {
	const f = await setup();
	await mkdir(join(f.directory, 'review.local'));
	await writeFile(
		join(f.directory, 'review.local/state.json'),
		JSON.stringify({
			started: '2099-01-01T08:00:00.000Z',
			finished: '2099-01-01T08:00:01.000Z',
			exitCode: 0,
		}),
	);
	expect((await f.routines.list())[0]?.status).toBe('due');
});

test('one runner does not start a routine that is still running', async () => {
	const f = await setup([process.execPath, '-e', 'await Bun.sleep(400)']);
	const first = f.routines.run('review');
	await eventually(async () => !!(await f.state().catch(() => undefined)));
	await expect(f.routines.run('review')).rejects.toThrow('already running');
	// A due check started before the run finishes leaves it alone.
	const started = (await f.state()).started;
	await f.routines.check(new Date(Date.now() + 2 * 86_400_000));
	expect((await first)?.exitCode).toBe(0);
	expect((await f.state()).started).toBe(started);
});

test('a start without a finish shows running until the next occurrence makes it due', async () => {
	const f = await setup();
	await mkdir(join(f.directory, 'review.local'));
	await writeFile(
		join(f.directory, 'review.local/state.json'),
		JSON.stringify({ started: new Date(Date.now() - 1000).toISOString() }),
	);
	const tomorrow = new Date(Date.now() + 86_400_000);
	expect((await f.routines.list())[0]?.status).toBe('running');
	expect((await f.routines.list(tomorrow))[0]?.status).toBe('due');
});
