/**
 * Home routine tests. A check starts each routine whose schedule had an
 * occurrence since the previous check, never waits for it, and records
 * nothing. Commands run as argv with no shell, a JSON value in `run` is one
 * word of JSON text, and files the runner refuses do not stop the others.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createRoutines } from './routines.ts';
import { fixture } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

const DAY = 86_400_000;
/** A command that leaves one file per run in `ran/`. */
const mark = [
	process.execPath,
	'-e',
	"require('fs').mkdirSync('ran',{recursive:true});require('fs').writeFileSync('ran/'+crypto.randomUUID(),'')",
];

async function setup(run: unknown[] = mark, cron = '0 8 * * *') {
	const f = await fixture();
	roots.push(f.root);
	const directory = join(f.home, 'routines');
	await mkdir(directory);
	await writeFile(
		join(directory, 'review.md'),
		`---\ncron: "${cron}"\nrun: ${JSON.stringify(run)}\n---\nA daily review.\n`,
	);
	const runs = () =>
		readdir(join(f.home, 'ran')).then(
			(names) => names.length,
			() => 0,
		);
	return {
		...f,
		directory,
		routines: createRoutines({ folder: f.home }),
		runs,
	};
}

async function eventually(check: () => Promise<boolean>) {
	const deadline = Date.now() + 8000;
	while (!(await check())) {
		if (Date.now() > deadline)
			throw new Error('The expected routine outcome did not arrive');
		await Bun.sleep(20);
	}
}

test('a routine starts once per check that passes an occurrence, and missed occurrences collapse', async () => {
	const f = await setup();
	// The first check starts from the runner's creation, so nothing has passed.
	await f.routines.check();
	await Bun.sleep(300);
	expect(await f.runs()).toBe(0);
	// Three days pass between checks: one run, not three.
	const later = new Date(Date.now() + 3 * DAY);
	await f.routines.check(later);
	await eventually(async () => (await f.runs()) === 1);
	await f.routines.check(later);
	await Bun.sleep(300);
	expect(await f.runs()).toBe(1);
	expect(await readdir(f.directory)).toEqual(['review.md']);
});

test('a routine runs an app action', async () => {
	const f = await setup(['epicenter', 'counter', 'add']);
	const app = await f.app(
		'counter',
		`export default defineApp({ description: 'Counter', actions: {
    add: defineAction({ description: 'Count', input: {}, run: async () => {
      const count = Number(await folder.read('data/count.txt') ?? 0) + 1;
      await folder.write('data/count.txt', String(count)); return Ok(count);
    } })
  } });`,
	);
	// The routine's command sends its action to the home's serve.
	await f.serve();
	await f.routines.check(new Date(Date.now() + DAY));
	await eventually(async () =>
		readFile(join(app, 'data/count.txt'), 'utf8').then(
			(t) => t === '1',
			() => false,
		),
	);
}, 30_000);

test('refused files are listed with their problem and do not stop valid routines', async () => {
	const f = await setup();
	await writeFile(
		join(f.directory, 'invalid.md'),
		'---\ncron: "61 * * * *"\nrun: ["bun", "--version"]\n---\n',
	);
	await writeFile(
		join(f.directory, 'extra.md'),
		'---\ncron: "0 8 * * *"\nrun: ["bun", "--version"]\ntimeout: "1m"\n---\n',
	);
	await writeFile(
		join(f.directory, 'unnamed.md'),
		'---\ncron: "0 8 * * *"\nrun: [{"program": "bun"}, "--version"]\n---\n',
	);
	await f.routines.check(new Date(Date.now() + DAY));
	await eventually(async () => (await f.runs()) === 1);
	const rows = await f.routines.list();
	expect(rows.filter((row) => 'problem' in row).map((row) => row.name)).toEqual(
		['extra', 'invalid', 'unnamed'],
	);
	expect(rows.find((row) => row.name === 'unnamed')).toMatchObject({
		problem: expect.stringContaining('the program is text'),
	});
	expect(rows.find((row) => row.name === 'review')).toMatchObject({
		cron: '0 8 * * *',
	});
});

test('arguments are passed without a shell', async () => {
	const literal = '$(echo accidental-shell)';
	const f = await setup([
		process.execPath,
		'-e',
		"require('fs').writeFileSync('argument', process.argv.at(-1))",
		literal,
	]);
	await f.routines.check(new Date(Date.now() + DAY));
	await eventually(async () =>
		readFile(join(f.home, 'argument'), 'utf8').then(
			(t) => t === literal,
			() => false,
		),
	);
});

test('a JSON value in run reaches the command as one word of JSON text', async () => {
	const f = await setup([
		process.execPath,
		'-e',
		"require('fs').writeFileSync('arguments', JSON.stringify(process.argv.slice(-3)))",
		{ recheck: false, tags: ['a b'] },
		7,
		null,
	]);
	await f.routines.check(new Date(Date.now() + DAY));
	await eventually(async () =>
		readFile(join(f.home, 'arguments'), 'utf8').then(
			(t) =>
				t === '["{\\"recheck\\":false,\\"tags\\":[\\"a b\\"]}","7","null"]',
			() => false,
		),
	);
});

test('the daily task review writes a draft and excludes completed tasks', async () => {
	const f = await setup(['bun', 'scripts/daily-task-review.ts']);
	await mkdir(join(f.home, 'scripts'));
	await copyFile(
		join(import.meta.dir, '../examples/daily-task-review.ts'),
		join(f.home, 'scripts/daily-task-review.ts'),
	);
	await f.app(
		'tasks',
		`export default defineApp({ description: 'Tasks', actions: {
    list: defineAction({ description: 'Tasks', input: {}, run: () => Ok([
      Ok({ path: 'data/tasks/one.md', title: 'An overdue task', done: false, due: '2000-01-01' }),
      Ok({ path: 'data/tasks/two.md', title: 'Already completed', done: true }),
      Ok({ path: 'data/tasks/three.md', title: 'Undated task', done: false })
    ]) })
  } });`,
	);
	// The script reads tasks through the command line, which asks serve.
	await f.serve();
	await f.routines.check(new Date(Date.now() + DAY));
	// The script dates its draft in the machine's time zone, while `bun test`
	// runs this process in UTC, so the test reads whichever draft appears.
	const drafts = join(f.home, 'drafts');
	const draftText = async () => {
		const names = await readdir(drafts).catch(() => []);
		const name = names.find((n) =>
			/^task-review-\d{4}-\d{2}-\d{2}\.md$/.test(n),
		);
		return name ? readFile(join(drafts, name), 'utf8') : '';
	};
	await eventually(async () => (await draftText()).includes('2 open tasks.'));
	const text = await draftText();
	expect(text).toContain('An overdue task');
	expect(text).not.toContain('Already completed');
}, 30_000);

test('occurrences follow local calendar days and daylight-saving gaps', async () => {
	const f = await setup([process.execPath, '--version'], '30 2 * * *');
	const modulePath = join(import.meta.dir, 'routines.ts');
	const child = Bun.spawn(
		[
			process.execPath,
			'-e',
			`
    import { createRoutines } from ${JSON.stringify(modulePath)};
    const routines = createRoutines({ folder: ${JSON.stringify(f.home)} });
    console.log((await routines.list(new Date('2026-03-07T10:31:00Z')))[0].next);
  `,
		],
		{ env: { ...process.env, TZ: 'America/Los_Angeles' }, stdout: 'pipe' },
	);
	// 02:30 does not exist on 2026-03-08 in Los Angeles; it moves to 03:30 PDT.
	expect((await new Response(child.stdout).text()).trim()).toBe(
		'2026-03-08T10:30:00.000Z',
	);
});
