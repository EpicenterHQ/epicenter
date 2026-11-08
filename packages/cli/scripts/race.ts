#!/usr/bin/env bun
/**
 * The commit rule under contention (ADR-0850, acceptance C7). `--runs` actions
 * of one app, `--concurrency` at a time, each writing its own file, race an
 * agent that, in the same folder, keeps committing files of its own with plain
 * `git add` and `git commit` and editing a tracked file it never commits.
 *
 * Afterwards every run's file and every file the agent committed must be at
 * HEAD with the bytes its writer wrote (`lost` counts those that are not), and
 * every commit must hold only its own writer's paths (`misfiled` counts those
 * that do not). Prints one JSON object; exits 1 when anything was lost or
 * misfiled. Everything happens under a temporary HOME.
 *
 *   bun packages/cli/scripts/race.ts --runs 1000 --concurrency 4
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
	options: {
		runs: { type: 'string', default: '1000' },
		concurrency: { type: 'string', default: '4' },
		keep: { type: 'boolean', default: false },
	},
});
const runs = Number(values.runs);
const concurrency = Number(values.concurrency);
const bin = resolve(import.meta.dir, '../src/bin.ts');

const root = await realpath(await mkdtemp(join(tmpdir(), 'epicenter-race-')));
const folder = join(root, 'Epicenter', 'race');
const env = {
	...process.env,
	HOME: root,
	GIT_AUTHOR_NAME: 'Race',
	GIT_AUTHOR_EMAIL: 'race@example.com',
	GIT_COMMITTER_NAME: 'Race',
	GIT_COMMITTER_EMAIL: 'race@example.com',
};

async function run(cmd: string[], cwd = folder) {
	const child = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}
const git = (...args: string[]) => run(['git', ...args]);

await mkdir(folder, { recursive: true });
await writeFile(
	join(folder, '.gitignore'),
	'node_modules/\n.cache/\nepicenter.d.json.ts\n',
);
await writeFile(join(folder, 'notes.md'), 'agent notes\n');
await writeFile(
	join(folder, 'epicenter.json'),
	JSON.stringify({ name: 'race', description: 'Race the commit rule' }),
);
await writeFile(
	join(folder, 'epicenter.ts'),
	`import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';
export default defineApp(declaration, { actions: {
	bump: {
		description: 'Write one run file',
		input: { id: field.text() },
		positional: ['id'],
		run: async ({ id }, { folder }) => { await folder.write('runs/' + id + '.txt', 'run ' + id + '\\n'); },
	},
}});
`,
);
await git('init', '-q');
await git('add', '-A');
await git('commit', '-q', '-m', 'initial');

const started = performance.now();
let done = false;
let failed = 0;
const failures: string[] = [];

async function actions() {
	let next = 0;
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (next < runs) {
				const id = String(next++);
				const result = await run(
					[process.execPath, bin, 'race', 'bump', id],
					root,
				);
				if (result.code !== 0) {
					failed++;
					if (failures.length < 5) failures.push(`${id}: ${result.stderr}`);
				}
			}
		}),
	);
	done = true;
}

/** The agent's own commits: each a new file, committed with porcelain Git, retried while the index is locked. */
const agentCommitted: string[] = [];
async function agent() {
	let k = 0;
	while (!done) {
		const path = `agent/${k}.txt`;
		await mkdir(join(folder, 'agent'), { recursive: true });
		await writeFile(join(folder, path), `agent ${k}\n`);
		await writeFile(join(folder, 'notes.md'), `agent notes, edit ${k}\n`);
		for (let attempt = 0; attempt < 200; attempt++) {
			const added = await git('add', '--', path);
			const committed =
				added.code === 0
					? await git('commit', '-q', '-m', `agent ${k}`, '--', path)
					: added;
			if (committed.code === 0) {
				agentCommitted.push(path);
				break;
			}
			await Bun.sleep(5);
		}
		k++;
		await Bun.sleep(3);
	}
}

await Promise.all([actions(), agent()]);
const seconds = (performance.now() - started) / 1000;

let lost = 0;
for (let id = 0; id < runs; id++) {
	const shown = await git('show', `HEAD:runs/${id}.txt`);
	if (shown.code !== 0 || shown.stdout !== `run ${id}`) lost++;
}
for (const path of agentCommitted) {
	const k = path.slice('agent/'.length, -'.txt'.length);
	const shown = await git('show', `HEAD:${path}`);
	if (shown.code !== 0 || shown.stdout !== `agent ${k}`) lost++;
}

let misfiled = 0;
const log = await git('log', '--format=%H%x00%s', 'HEAD');
for (const line of log.stdout.split('\n')) {
	const [sha = '', subject = ''] = line.split('\0');
	if (subject === 'initial') continue;
	const paths = (
		await git('diff-tree', '--no-commit-id', '--name-only', '-r', sha)
	).stdout
		.split('\n')
		.filter(Boolean);
	const own =
		subject === 'race bump'
			? paths.length === 1 && /^runs\/\d+\.txt$/.test(paths[0] ?? '')
			: /^agent \d+$/.test(subject) &&
				paths.length === 1 &&
				paths[0] === `agent/${subject.slice('agent '.length)}.txt`;
	if (!own) misfiled++;
}

const status = (await git('status', '--porcelain')).stdout;
const report = {
	runs,
	concurrency,
	seconds: Math.round(seconds * 10) / 10,
	agentCommits: agentCommitted.length,
	failed,
	lost,
	misfiled,
	uncommittedAfter: status.split('\n').filter(Boolean),
	...(failures.length ? { failures } : {}),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!values.keep) await rm(root, { recursive: true, force: true });
process.exitCode = lost || misfiled || failed ? 1 : 0;
