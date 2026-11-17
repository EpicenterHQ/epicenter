/**
 * Home routine acceptance tests.
 *
 * Exercise real CLI commands, process groups, local state, and serve startup.
 * Catch-up coalesces missed days; failed or interrupted attempts remain visible.
 * Manual runs share exclusion with scheduled runs, and drafts survive reruns.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
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
		`---\ndaily: "08:00"\nrun: ${JSON.stringify(run)}\n${extra}---\nA daily review.\n`,
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
		'{"completed":"2000-01-01T08:00:00.000Z"}\n',
	);
	const served = await startServe(f);
	try {
		await eventually(
			async () => (await f.routines.list())[0]?.status === 'succeeded',
		);
		expect(await readFile(join(app, 'data/count.txt'), 'utf8')).toBe('1');
		expect((await f.state()).completed).not.toStartWith('2000');
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

test('a failed command is not retried by checks and an explicit run can repair it', async () => {
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
	expect(failed.attempt.exitCode).toBe(7);
	await f.routines.check();
	await f.routines.stop();
	expect(await f.state()).toEqual(failed);
	const restarted = createRoutines({ folder: f.home });
	await restarted.check();
	await restarted.stop();
	expect(await f.state()).toEqual(failed);
	await writeFile(
		join(f.directory, 'review.md'),
		'---\ndaily: "08:00"\nrun: ["bun", "-e", "console.log(123)"]\n---\n',
	);
	const result = await f.run('routines', 'run', 'review', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).attempt.outcome).toBe('succeeded');
	const log = await readFile(
		join(f.directory, 'review.local/output.log'),
		'utf8',
	);
	expect(log).toContain('offline');
	expect(log).toContain('123');
});

test('manual and scheduled attempts exclude one another and cancellation records interruption', async () => {
	const f = await setup(
		[
			process.execPath,
			'-e',
			'process.on("SIGTERM", () => {}); console.log("started"); setInterval(() => {}, 1000)',
		],
		'timeout: "1s"\n',
	);
	await f.routines.check();
	await eventually(
		async () => (await f.state().catch(() => undefined))?.attempt?.pid > 0,
	);
	const result = await f.run('routines', 'run', 'review');
	expect(result.code).toBe(2);
	expect(result.stderr).toContain('already running');
	// Shutdown starts first; a timeout during the termination grace cannot rename it.
	await f.routines.stop();
	expect((await f.state()).attempt.outcome).toBe('interrupted');
	const restarted = createRoutines({ folder: f.home });
	await restarted.check(new Date(2030, 0, 1, 10));
	await restarted.stop();
	expect((await f.state()).attempt.outcome).toBe('interrupted');
});

test('a killed supervisor leaves a visible unknown outcome and cannot overlap its surviving command', async () => {
	const f = await setup([
		process.execPath,
		'-e',
		'setInterval(() => {}, 1000)',
	]);
	const supervisor = Bun.spawn(
		[process.execPath, f.bin, 'routines', 'run', 'review'],
		{
			cwd: f.home,
			env: f.env,
			stdout: 'ignore',
			stderr: 'ignore',
		},
	);
	let pid: number | undefined;
	try {
		await eventually(async () => {
			pid = (await f.state().catch(() => undefined))?.attempt?.pid;
			return pid !== undefined;
		});
		supervisor.kill('SIGKILL');
		await supervisor.exited;
		await f.routines.check();
		await eventually(
			async () => (await f.routines.list())[0]?.status === 'running',
		);
		const refused = await f.run('routines', 'run', 'review');
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain('already running');
		if (pid === undefined)
			throw new Error('The command did not record its process ID');
		process.kill(-pid, 'SIGKILL');
		await eventually(async () => {
			await f.routines.check();
			return (await f.state()).attempt.outcome === 'interrupted';
		});
	} finally {
		supervisor.kill('SIGKILL');
		if (pid !== undefined) {
			try {
				process.kill(-pid, 'SIGKILL');
			} catch {}
		}
		await f.routines.stop();
	}
});

test('timeouts terminate the command group, including a grandchild ignoring SIGTERM', async () => {
	const f = await setup(
		[
			process.execPath,
			'-e',
			`
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    const child = Bun.spawn([process.execPath, '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)']);
    writeFileSync('grandchild.local', String(child.pid));
    setInterval(() => {}, 1000);
  `,
		],
		'timeout: "1s"\n',
	);
	try {
		await f.routines.check();
		await eventually(
			async () => (await f.routines.list())[0]?.status === 'failed',
		);
		const state = await f.state();
		expect(state.attempt.message).toContain('timeout');
		await eventually(async () => {
			try {
				process.kill(-state.attempt.pid, 0);
				return false;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === 'ESRCH';
			}
		});
	} finally {
		await f.routines.stop();
	}
}, 15_000);

test('invalid definitions and corrupted state block execution without stopping valid routines', async () => {
	const f = await setup();
	await writeFile(
		join(f.directory, 'invalid.md'),
		'---\ndaily: "25:00"\nrun: ["bun", "--version"]\n---\n',
	);
	// A line that is not JSON is not read as absent here: paused: yes must not run.
	await writeFile(
		join(f.directory, 'bare.md'),
		'---\ndaily: "08:00"\nrun: ["bun", "--version"]\npaused: yes\n---\n',
	);
	await mkdir(join(f.directory, 'review.local'));
	await writeFile(
		join(f.directory, 'review.local/state.json'),
		'{"completed":"yesterday"}',
	);
	await writeFile(
		join(f.directory, 'working.md'),
		'---\ndaily: "08:00"\nrun: ["bun", "--version"]\n---\n',
	);
	await f.routines.check();
	await eventually(async () =>
		(await f.routines.list()).some(
			(row) => row.name === 'working' && row.status === 'succeeded',
		),
	);
	await f.routines.stop();
	const rows = await f.routines.list();
	expect(
		rows.filter((row) => row.status === 'invalid').map((row) => row.name),
	).toEqual(['bare', 'invalid', 'review']);
	expect(
		await readFile(join(f.directory, 'review.local/state.json'), 'utf8'),
	).toBe('{"completed":"yesterday"}');
});

test('the daily occurrence uses calendar dates and arguments are passed without a shell', async () => {
	const literal = '$(echo accidental-shell)';
	const f = await setup([
		process.execPath,
		'-e',
		'console.log(process.argv.at(-1))',
		literal,
	]);
	const now = new Date(2026, 10, 14, 7, 59);
	const result = await f.routines.run('review', now);
	expect(result?.attempt?.slot).toBe(new Date(2026, 10, 13, 8).toISOString());
	const log = await readFile(
		join(f.directory, 'review.local/output.log'),
		'utf8',
	);
	expect(log.split('\n').filter((line) => line === literal)).toHaveLength(1);
	await f.routines.stop();
});

test('paused routines do not run on checks but can be run explicitly', async () => {
	const f = await setup(undefined, 'paused: true\n');
	await f.routines.check();
	expect((await f.routines.list())[0]?.status).toBe('paused');
	// A check launches asynchronously. Let it release its lock before the
	// foreground runner attempts the explicit invocation, as a later CLI does.
	await f.routines.stop();
	const foreground = createRoutines({ folder: f.home });
	try {
		const ran = await foreground.run('review');
		expect(ran?.attempt?.outcome).toBe('succeeded');
		expect((await foreground.list())[0]?.status).toBe('paused');
	} finally {
		await foreground.stop();
	}
});

test('the daily task review writes a draft, excludes completed tasks, and preserves edits on rerun', async () => {
	// Paused, so the serve that answers the script's `tasks list` does not
	// also run the review as it starts.
	const f = await setup(
		['bun', 'scripts/daily-task-review.ts'],
		'paused: true\n',
	);
	await f.serve();
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

test('daily catch-up respects daylight-saving gaps and calendar days', async () => {
	const f = await setup();
	const modulePath = join(import.meta.dir, 'routines.ts');
	const child = Bun.spawn(
		[
			process.execPath,
			'-e',
			`
    import { createRoutines } from ${JSON.stringify(modulePath)};
    const routines = createRoutines({ folder: ${JSON.stringify(f.home)} });
    const before = await routines.run('review', new Date('2026-03-08T14:59:00Z'));
    const after = await routines.run('review', new Date('2026-03-08T15:01:00Z'));
    console.log(JSON.stringify([before.attempt.slot, after.attempt.slot]));
    await routines.stop();
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
	expect(JSON.parse(stdout)).toEqual([
		'2026-03-07T16:00:00.000Z',
		'2026-03-08T15:00:00.000Z',
	]);
	await writeFile(
		join(f.directory, 'review.md'),
		'---\ndaily: "02:30"\nrun: ["bun", "--version"]\n---\n',
	);
	const gap = Bun.spawn(
		[
			process.execPath,
			'-e',
			`
    import { createRoutines } from ${JSON.stringify(modulePath)};
    const routines = createRoutines({ folder: ${JSON.stringify(f.home)} });
    const before = await routines.run('review', new Date('2026-03-08T10:00:00Z'));
    const after = await routines.run('review', new Date('2026-03-08T10:31:00Z'));
    console.log(JSON.stringify([before.attempt.slot, after.attempt.slot]));
    await routines.stop();
  `,
		],
		{
			env: { ...process.env, TZ: 'America/Los_Angeles' },
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const result = JSON.parse(await new Response(gap.stdout).text());
	expect(await gap.exited).toBe(0);
	expect(result).toEqual([
		'2026-03-07T10:30:00.000Z',
		'2026-03-08T10:30:00.000Z',
	]);
});

test('the kernel lock excludes simultaneous attempts in the same runner', async () => {
	const f = await setup([
		process.execPath,
		'-e',
		'setInterval(() => {}, 1000)',
	]);
	const attempts = Promise.allSettled([
		f.routines.run('review'),
		f.routines.run('review'),
	]);
	try {
		await eventually(
			async () => (await f.state().catch(() => undefined))?.attempt?.pid > 0,
		);
	} finally {
		await f.routines.stop();
	}
	const results = await attempts;
	expect(
		results.filter((result) => result.status === 'fulfilled'),
	).toHaveLength(1);
	const refused = results.find((result) => result.status === 'rejected');
	expect(refused?.status === 'rejected' && refused.reason.message).toContain(
		'already running',
	);
	expect((await f.state()).attempt.outcome).toBe('interrupted');
});

test('one shutdown signal stops all owned routine groups', async () => {
	const f = await setup([
		process.execPath,
		'-e',
		'setInterval(() => {}, 1000)',
	]);
	await copyFile(
		join(f.directory, 'review.md'),
		join(f.directory, 'second.md'),
	);
	await f.routines.check();
	try {
		await eventually(async () => {
			const rows = await f.routines.list();
			return (
				rows.length === 2 &&
				rows.every((row) => 'attempt' in row && row.attempt?.pid !== undefined)
			);
		});
	} finally {
		await f.routines.stop();
	}
	const rows = await f.routines.list();
	expect(rows.map((row) => row.status)).toEqual(['interrupted', 'interrupted']);
	expect(
		rows.every(
			(row) => 'attempt' in row && row.attempt?.outcome === 'interrupted',
		),
	).toBe(true);
});

test('a failed manual rerun stays visible after a success for the same slot', async () => {
	const f = await setup();
	await f.routines.run('review');
	await writeFile(
		join(f.directory, 'review.md'),
		'---\ndaily: "08:00"\nrun: ["bun", "-e", "process.exit(4)"]\n---\n',
	);
	await f.routines.run('review');
	const failed = await f.state();
	expect((await f.routines.list())[0]?.status).toBe('failed');
	await f.routines.check();
	await f.routines.stop();
	expect(await f.state()).toEqual(failed);
	const nextDay = new Date();
	nextDay.setDate(nextDay.getDate() + 1);
	const restarted = createRoutines({ folder: f.home });
	expect((await restarted.list(nextDay))[0]?.status).toBe('due');
	await restarted.check(nextDay);
	await eventually(
		async () => (await f.state()).attempt.slot !== failed.attempt.slot,
	);
	await restarted.stop();
});

test('invalid saved fields block execution without rewriting the state', async () => {
	const f = await setup();
	const local = join(f.directory, 'review.local');
	await mkdir(local);
	for (const state of [
		{ completde: '2026-11-14T08:00:00.000Z' },
		{ completed: '2026-13-14T08:00:00.000Z' },
		{ completed: '2026-11-14T08:00:00Z' },
		{
			attempt: {
				slot: '2026-11-14T08:00:00.000Z',
				started: '2026-11-14T08:01:00.000Z',
				outcome: 'done',
			},
		},
		{
			attempt: {
				slot: '2026-11-14T08:00:00.000Z',
				started: '2026-11-14T08:01:00.000Z',
				outcome: 'running',
				pid: -1,
			},
		},
	]) {
		const raw = JSON.stringify(state);
		await writeFile(join(local, 'state.json'), raw);
		const runner = createRoutines({ folder: f.home });
		expect((await runner.list())[0]?.status).toBe('invalid');
		await expect(runner.run('review')).rejects.toThrow('state.json');
		await runner.stop();
		expect(await readFile(join(local, 'state.json'), 'utf8')).toBe(raw);
	}
});

test('inspection reports an abandoned attempt coherently without rewriting its record', async () => {
	const f = await setup();
	const local = join(f.directory, 'review.local');
	await mkdir(local);
	const raw = JSON.stringify({
		attempt: {
			slot: '2026-11-14T08:00:00.000Z',
			started: '2026-11-14T08:01:00.000Z',
			outcome: 'running',
		},
	});
	await writeFile(join(local, 'state.json'), raw);
	const [row] = await f.routines.list();
	expect(row?.status).toBe('interrupted');
	expect(row && 'attempt' in row && row.attempt?.outcome).toBe('interrupted');
	expect(await readFile(join(local, 'state.json'), 'utf8')).toBe(raw);
	expect((await f.routines.run('review'))?.attempt?.outcome).toBe('succeeded');
	await f.routines.stop();
});

test('unconfirmed descendant cleanup remains inspectable and never advances completion', async () => {
	const f = await setup();
	const kill = process.kill.bind(process);
	const signalling = spyOn(process, 'kill').mockImplementation(
		(pid, signal) => {
			if (pid < 0 && signal === 'SIGKILL')
				throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
			return kill(pid, signal);
		},
	);
	try {
		const state = await f.routines.run('review');
		expect(state?.attempt?.outcome).toBe('interrupted');
		expect(state?.completed).toBeUndefined();
		expect((await f.state()).attempt.message).toContain('EPERM');
		expect(
			await readFile(join(f.directory, 'review.local/output.log'), 'utf8'),
		).toContain('cleanup is unconfirmed');
	} finally {
		signalling.mockRestore();
		await f.routines.stop();
	}
});
