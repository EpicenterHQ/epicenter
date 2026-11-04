/**
 * Time the same rounds on a generated folder of N notes, once through the
 * current CLI (`epicenter sync`: system git, git-lfs, the merge driver as a
 * process per note) and once through the sync core addon in this Bun
 * process (settle called back in-process). Each engine gets its own bare
 * `file://` remote, in a sandbox with its own HOME and Git configuration.
 *
 * `bun packages/sync-core/bench/compare.ts [items=10000]`
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { settleNote } from '../index.ts';
import { addon } from '../index.ts';

const N = Number(process.argv[2] ?? 10_000);
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'sync-core-bench-')));
const HOME = join(BOX, 'home');
const BIN = resolve(import.meta.dir, '../../cli/src/bin.ts');
const ENV: Record<string, string> = {
	PATH: process.env.PATH ?? '/usr/bin:/bin',
	HOME,
	TMPDIR: join(BOX, 'tmp'),
	GIT_CONFIG_GLOBAL: join(HOME, '.gitconfig'),
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
	GIT_CEILING_DIRECTORIES: BOX,
	EPICENTER_DATA_DIR: join(BOX, 'data'),
};
mkdirSync(ENV.TMPDIR as string, { recursive: true });
mkdirSync(HOME, { recursive: true });
writeFileSync(ENV.GIT_CONFIG_GLOBAL as string, '[user]\n\tname = bench\n\temail = bench@example.invalid\n[init]\n\tdefaultBranch = main\n');
// libgit2 in this process reads the same sandboxed configuration.
Object.assign(process.env, ENV);

const ATTRIBUTES = `# BEGIN epicenter (managed by Epicenter; edit outside this block)
# Notes merge by Epicenter's rules; every other file except hidden paths is Git LFS.
* filter=lfs diff=lfs merge=lfs -text
*.[mM][dD] !filter !diff merge=epicenter text
.* !filter !diff !merge !text
.*/** !filter !diff !merge !text
**/.*/** !filter !diff !merge !text
# END epicenter
`;

function write(folder: string, path: string, text: string) {
	mkdirSync(dirname(join(folder, path)), { recursive: true });
	writeFileSync(join(folder, path), text);
}
const item = (i: number) => `items/${String(i % 100).padStart(2, '0')}/item-${i}.md`;

function run(cmd: string[], cwd = BOX) {
	const ran = Bun.spawnSync(cmd, { cwd, env: ENV, stdout: 'pipe', stderr: 'pipe' });
	if (ran.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${ran.stderr.toString()}${ran.stdout.toString()}`);
	return ran.stdout.toString();
}

type Engine = {
	name: string;
	prepare(folder: string, remote: string): void;
	sync(folder: string, machine: string): void;
};

const cli: Engine = {
	name: 'CLI (git + git-lfs)',
	prepare(folder, remote) {
		run(['bun', BIN, 'init', folder]);
		run(['git', 'remote', 'add', 'origin', remote], folder);
	},
	sync(folder) {
		const out = run(['bun', BIN, 'sync', folder, '--json']);
		const status = JSON.parse(out.trim().split('\n').at(-1) ?? '{}').sync?.status;
		if (status !== 'synced') throw new Error(`cli sync: ${out}`);
	},
};

const core: Engine = {
	name: 'sync core (napi, in-process)',
	prepare(folder) {
		write(folder, '.gitattributes', ATTRIBUTES);
	},
	sync(folder, machine) {
		const round = addon.syncRound(folder, { machine, remote: { url: `file://${currentRemote}` } }, settleNote);
		if (round.status !== 'synced') throw new Error(`core sync: ${round.message}`);
	},
};
let currentRemote = '';

const results: Record<string, Record<string, number>> = {};
function time(engine: Engine, label: string, work: () => void) {
	const start = performance.now();
	work();
	const ms = performance.now() - start;
	results[label] ??= {};
	(results[label] as Record<string, number>)[engine.name] = ms;
	console.log(`${engine.name.padEnd(30)} ${label.padEnd(48)} ${(ms / 1000).toFixed(2)} s`);
}

for (const engine of [core, cli]) {
	const tag = engine === cli ? 'cli' : 'core';
	const remote = join(BOX, `${tag}-remote.git`);
	currentRemote = remote;
	run(['git', 'init', '-q', '--bare', '-b', 'main', remote]);
	const a = join(HOME, 'Epicenter', `${tag}-a`);
	const b = join(HOME, 'Epicenter', `${tag}-b`);
	for (let i = 0; i < N; i++) write(a, item(i), `---\ntitle: Item ${i}\nn: ${i}\n---\nbody of item ${i}\n`);
	engine.prepare(a, remote);
	time(engine, `first round: commit ${N} notes and push`, () => engine.sync(a, 'A'));
	time(engine, 'unchanged round', () => engine.sync(a, 'A'));
	for (let i = 0; i < 10; i++) write(a, item(i), `---\ntitle: Item ${i} edited\nn: ${i}\n---\nbody of item ${i}\n`);
	time(engine, '10 edits: commit and push', () => engine.sync(a, 'A'));
	mkdirSync(b, { recursive: true });
	engine.prepare(b, remote);
	time(engine, `restore into an empty folder (${N} files)`, () => engine.sync(b, 'B'));
	for (let i = 0; i < 10; i++) {
		write(a, item(100 + i), `---\ntitle: Item ${100 + i} on A\nn: ${100 + i}\n---\nbody\n`);
		write(b, item(200 + i), `---\ntitle: Item ${200 + i} on B\nn: ${200 + i}\n---\nbody\n`);
	}
	// One note both sides change, so the round runs settle once.
	write(a, item(5), `---\ntitle: Five on A\nn: 5\n---\nbody of item 5\n`);
	write(b, item(5), `---\ntitle: Item 5 edited\nn: 5\ntag: b\n---\nbody of item 5\n`);
	engine.sync(a, 'A');
	time(engine, 'three-way: 10 edits here, 10 there, 1 note settled', () => engine.sync(b, 'B'));
}

console.log('\n| Round | CLI (git + git-lfs) | sync core (napi) |\n| --- | --- | --- |');
for (const [label, by] of Object.entries(results))
	console.log(`| ${label} | ${((by[cli.name] ?? 0) / 1000).toFixed(2)} s | ${((by[core.name] ?? 0) / 1000).toFixed(2)} s |`);
rmSync(BOX, { recursive: true, force: true });
