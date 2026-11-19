/**
 * Routine tests. Serve reads `routines/` once, when it starts, and checks
 * each file against the apps it loaded, so an unknown action or an input
 * that does not fit is a problem from the start. A check runs each routine
 * whose schedule had an occurrence since the previous check, through the
 * same `runAction` a call uses, never waits for it, and records nothing of
 * its own.
 */
import { afterEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { loadApps } from './apps.ts';
import { readRoutines, startRoutines } from './routines.ts';
import { checkCall, findAction, runAction } from './run.ts';
import { fixture, startServe } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

const DAY = 86_400_000;

/** An app whose `add` counts its runs in `data/count.txt`. */
const counter = `export default defineApp(({ folder }) => ({ description: 'Counter', actions: {
	add: defineAction({ description: 'Count', input: { by: field.number({ optional: true }) }, run: async ({ by = 1 }) => {
		const file = Bun.file(folder.path + '/data/count.txt');
		const count = Number((await file.exists()) ? await file.text() : 0) + by;
		await folder.write('data/count.txt', String(count));
		return Ok(count);
	} }),
} }));`;

/** An Epicenter with the counter app and `routines`, each file's text by name. */
async function setup(routines: Record<string, string>) {
	const f = await fixture();
	roots.push(f.userDir);
	const app = await f.app('counter', counter);
	await f.folder(
		join(f.epicenter, 'routines'),
		Object.fromEntries(
			Object.entries(routines).map(([name, text]) => [`${name}.md`, text]),
		),
	);
	const apps = await loadApps({ folder: f.epicenter });
	const read = await readRoutines({ folder: f.epicenter }, apps);
	const count = () =>
		readFile(join(app, 'data/count.txt'), 'utf8').then(Number, () => 0);
	return { ...f, loaded: apps, read, count };
}

const routine = (action: string, input?: object, cron = '0 8 * * *') =>
	`---\ncron: "${cron}"\naction: "${action}"\n${input ? `input: ${JSON.stringify(input)}\n` : ''}---\nCount.\n`;

async function eventually(check: () => Promise<boolean>) {
	const deadline = Date.now() + 8000;
	while (!(await check())) {
		if (Date.now() > deadline)
			throw new Error('The expected routine outcome did not arrive');
		await Bun.sleep(20);
	}
}

const recorder = () => {
	const { sink, events } = memorySink();
	return { log: createLogger('cli/run', sink), events };
};

test('a due routine runs its action through runAction, leaving the same record as a call', async () => {
	const f = await setup({ count: routine('counter add', { by: 2 }) });
	const routines = recorder();
	const clock = startRoutines(f.read, { log: routines.log });
	try {
		// The first check starts from when the clock started, so nothing has passed.
		clock.check();
		await Bun.sleep(100);
		expect(await f.count()).toBe(0);
		clock.check(new Date(Date.now() + DAY));
		await eventually(async () => (await f.count()) === 2);
	} finally {
		clock.stop();
	}
	const calls = recorder();
	const { data: found } = findAction(f.loaded, 'counter', 'add');
	const { data: call } = checkCall(found as never, { value: { by: 2 } });
	await runAction(call as never, { log: calls.log });
	const record = ({ data }: (typeof calls.events)[number]) => ({
		...(data as object),
		durationMs: 0,
	});
	expect(routines.events.map(record)).toEqual(calls.events.map(record));
	expect(routines.events[0]?.data).toMatchObject({
		app: 'counter',
		action: 'add',
		outcome: 'ok',
	});
});

test('missed occurrences collapse into one run', async () => {
	const f = await setup({ count: routine('counter add') });
	const clock = startRoutines(f.read, { log: recorder().log });
	try {
		// Three days pass between checks: one run, not three.
		const later = new Date(Date.now() + 3 * DAY);
		clock.check(later);
		await eventually(async () => (await f.count()) === 1);
		clock.check(later);
		await Bun.sleep(200);
		expect(await f.count()).toBe(1);
	} finally {
		clock.stop();
	}
});

test('a routine naming an unknown action, or an input that does not fit, is refused at start and the others run', async () => {
	const f = await setup({
		count: routine('counter add'),
		sing: routine('counter sing'),
		elsewhere: routine('nowhere add'),
		unfit: routine('counter add', { by: 'two' }),
		extra: routine('counter add').replace(
			'---\nCount',
			'timeout: "1m"\n---\nCount',
		),
	});
	expect(f.read.map((each) => ('problem' in each ? each : each.name))).toEqual([
		'count',
		{ name: 'elsewhere', problem: 'Unknown app "nowhere"' },
		{
			name: 'extra',
			problem:
				'needs exactly cron: "<minute hour day month weekday>" and action: "<app> <action>", and may have input: {...}',
		},
		{ name: 'sing', problem: 'counter has no action "sing"; its actions: add' },
		{ name: 'unfit', problem: 'input: by must be a number' },
	]);
	const clock = startRoutines(f.read, { log: recorder().log });
	try {
		clock.check(new Date(Date.now() + DAY));
		await eventually(async () => (await f.count()) === 1);
	} finally {
		clock.stop();
	}
	// Serve says so once, when it starts, beside the address it serves.
	const served = await startServe(f);
	try {
		expect(served.stderr()).toContain(
			'\nroutines/sing.md: counter has no action "sing"; its actions: add\n',
		);
	} finally {
		await served.stop();
	}
});

test('occurrences follow local calendar days and daylight-saving gaps', async () => {
	const modulePath = join(import.meta.dir, 'routines.ts');
	const child = Bun.spawn(
		[
			process.execPath,
			'-e',
			`
    import { routineRows } from ${JSON.stringify(modulePath)};
    const call = { app: 'a', action: 'b', run: () => {}, input: {} };
    console.log(routineRows([{ name: 'r', cron: '30 2 * * *', call }], new Date('2026-03-07T10:31:00Z'))[0].next);
  `,
		],
		{ env: { ...process.env, TZ: 'America/Los_Angeles' }, stdout: 'pipe' },
	);
	// 02:30 does not exist on 2026-03-08 in Los Angeles; it moves to 03:30 PDT.
	expect((await new Response(child.stdout).text()).trim()).toBe(
		'2026-03-08T10:30:00.000Z',
	);
});
