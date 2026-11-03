/** Clone naming and joining against local bare repositories, with no network. */
import { expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve(import.meta.dir, '..', 'bin.ts');

type Ran = { code: number; stdout: string; stderr: string; out: string };

function fixture() {
	const box = mkdtempSync(join(tmpdir(), 'epicenter-clone-e2e-'));
	const home = join(box, 'home');
	const library = join(home, 'Epicenter');
	const command = join(home, '.local', 'bin', 'epicenter');
	mkdirSync(join(home, '.local', 'bin'), { recursive: true });
	writeFileSync(
		join(home, '.gitconfig'),
		'[user]\n\tname = sandbox\n\temail = sandbox@example.invalid\n[init]\n\tdefaultBranch = main\n',
	);
	writeFileSync(
		command,
		`#!/bin/sh\nexec '${process.execPath}' '${BIN}' "$@"\n`,
	);
	chmodSync(command, 0o755);
	const env = {
		PATH: process.env.PATH ?? '/usr/bin:/bin',
		HOME: home,
		TMPDIR: box,
		XDG_CONFIG_HOME: join(home, '.config'),
		GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_CEILING_DIRECTORIES: box,
		EPICENTER_DATA_DIR: join(box, 'data'),
	};
	const run = async (cwd: string, cmd: string[]): Promise<Ran> => {
		const proc = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr, out: `${stdout}${stderr}` };
	};
	const git = (cwd: string, ...args: string[]) => run(cwd, ['git', ...args]);
	const cli = (...args: string[]) => run(box, [command, ...args]);
	const write = (dir: string, path: string, text: string) => {
		const file = join(dir, path);
		mkdirSync(resolve(file, '..'), { recursive: true });
		writeFileSync(file, text);
	};
	const remote = async (name: string, note?: string) => {
		const bare = join(box, `${name}.git`);
		const seed = join(box, `${name}-seed`);
		expect(
			(await git(box, 'init', '-q', '--bare', '-b', 'main', bare)).code,
		).toBe(0);
		expect((await git(box, 'clone', '-q', bare, seed)).code).toBe(0);
		if (note !== undefined) write(seed, 'AGENTS.md', note);
		write(seed, 'notes/remote.md', '---\ntitle: Remote\n---\nremote note\n');
		expect(
			(
				await git(
					seed,
					'add',
					...(note === undefined ? [] : ['AGENTS.md']),
					'notes/remote.md',
				)
			).code,
		).toBe(0);
		expect((await git(seed, 'commit', '-qm', 'seed')).code).toBe(0);
		expect((await git(seed, 'push', '-q', 'origin', 'HEAD:main')).code).toBe(0);
		return bare;
	};
	return {
		box,
		home,
		library,
		git,
		cli,
		write,
		remote,
		cleanup: () => rmSync(box, { recursive: true, force: true }),
	};
}

const contract = (site: string) =>
	`---\ncontract: ${site}/contract.json\n---\nThis folder belongs to the app.\n`;
const noTemps = (library: string) =>
	existsSync(library)
		? readdirSync(library).filter((name) => name.startsWith('.clone-'))
		: [];

test('implicit clone names first-party and owner folders from the contract site', async () => {
	const f = fixture();
	try {
		const first = await f.remote(
			'first',
			contract('https://whispering.epicenter.so'),
		);
		const owner = await f.remote(
			'owner',
			contract('https://zhongwen.bradenwong.com'),
		);
		expect((await f.cli('clone', first)).code).toBe(0);
		expect((await f.cli('clone', owner)).code).toBe(0);
		expect(existsSync(join(f.library, 'whispering', 'AGENTS.md'))).toBe(true);
		expect(
			existsSync(join(f.library, 'bradenwong.com', 'zhongwen', 'AGENTS.md')),
		).toBe(true);
		expect(noTemps(f.library)).toEqual([]);
	} finally {
		f.cleanup();
	}
}, 60_000);

test('implicit clone falls back when AGENTS.md or its contract key is missing', async () => {
	const f = fixture();
	try {
		const absent = await f.remote('absent');
		const noKey = await f.remote('no-key', '---\ntitle: Plain\n---\nplain\n');
		const a = await f.cli('clone', absent);
		const b = await f.cli('clone', noKey);
		expect(a.code).toBe(0);
		expect(b.code).toBe(0);
		expect(a.out).toContain('no AGENTS.md');
		expect(b.out).toContain('no contract key');
		expect(existsSync(join(f.library, 'absent', 'notes', 'remote.md'))).toBe(
			true,
		);
		expect(existsSync(join(f.library, 'no-key', 'AGENTS.md'))).toBe(true);
	} finally {
		f.cleanup();
	}
}, 60_000);

test('explicit directory wins over the site-derived folder name', async () => {
	const f = fixture();
	try {
		const source = await f.remote(
			'explicit',
			contract('https://whispering.epicenter.so'),
		);
		const target = join(f.box, 'chosen');
		expect((await f.cli('clone', source, target)).code).toBe(0);
		expect(existsSync(join(target, 'AGENTS.md'))).toBe(true);
		expect(existsSync(join(f.library, 'whispering'))).toBe(false);
	} finally {
		f.cleanup();
	}
}, 60_000);

test('clone joins an app-created folder and merges local and remote notes', async () => {
	const f = fixture();
	try {
		const source = await f.remote(
			'join',
			contract('https://whispering.epicenter.so'),
		);
		const target = join(f.library, 'whispering');
		f.write(target, 'AGENTS.md', contract('https://whispering.epicenter.so'));
		f.write(target, 'notes/local.md', '---\ntitle: Local\n---\nlocal note\n');
		const joined = await f.cli('clone', source);
		expect(joined.code).toBe(0);
		expect(existsSync(join(target, 'notes', 'remote.md'))).toBe(true);
		expect(readFileSync(join(target, 'notes', 'local.md'), 'utf8')).toContain(
			'local note',
		);
		expect(
			(
				await f.git(target, 'config', '--get', 'epicenter.synced')
			).stdout.trim(),
		).toBe('true');
		expect((await f.git(target, 'ls-files', '-u')).stdout.trim()).toBe('');
		expect(noTemps(f.library)).toEqual([]);
	} finally {
		f.cleanup();
	}
}, 60_000);

test('join reports a note conflict and keeps both versions in the note', async () => {
	const f = fixture();
	try {
		const source = await f.remote(
			'conflict',
			contract('https://whispering.epicenter.so'),
		);
		const seed = join(f.box, 'conflict-seed');
		f.write(
			seed,
			'notes/shared.md',
			'---\ntitle: Shared\n---\nremote version\n',
		);
		expect((await f.git(seed, 'add', 'notes/shared.md')).code).toBe(0);
		expect((await f.git(seed, 'commit', '-qm', 'remote note')).code).toBe(0);
		expect((await f.git(seed, 'push', '-q', 'origin', 'HEAD:main')).code).toBe(
			0,
		);
		const target = join(f.library, 'whispering');
		f.write(target, 'AGENTS.md', contract('https://whispering.epicenter.so'));
		f.write(
			target,
			'notes/shared.md',
			'---\ntitle: Shared\n---\nlocal version\n',
		);
		const joined = await f.cli('clone', source);
		expect(joined.code).toBe(0);
		expect(joined.out).toContain('conflict block written');
		const note = readFileSync(join(target, 'notes/shared.md'), 'utf8');
		expect(note).toContain('local version');
		expect(note).toContain('remote version');
		expect((await f.git(target, 'ls-files', '-u')).stdout.trim()).toBe('');
	} finally {
		f.cleanup();
	}
}, 60_000);

test('same remote is already cloned; different remote is refused with both URLs', async () => {
	const f = fixture();
	try {
		const source = await f.remote(
			'same',
			contract('https://whispering.epicenter.so'),
		);
		const other = await f.remote(
			'different',
			contract('https://whispering.epicenter.so'),
		);
		const target = join(f.library, 'whispering');
		expect((await f.cli('clone', source)).code).toBe(0);
		const head = (await f.git(target, 'rev-parse', 'HEAD')).stdout.trim();
		const again = await f.cli('clone', source);
		expect(again.code, again.out).toBe(0);
		expect(again.out).toContain('already cloned');
		expect((await f.git(target, 'rev-parse', 'HEAD')).stdout.trim()).toBe(head);
		const refused = await f.cli('clone', other);
		expect(refused.code).not.toBe(0);
		expect(refused.out).toContain(source);
		expect(refused.out).toContain(other);
		expect(noTemps(f.library)).toEqual([]);
	} finally {
		f.cleanup();
	}
}, 60_000);

test('failed clone removes its temporary checkout and leaves no destination', async () => {
	const f = fixture();
	try {
		const source = await f.remote(
			'invalid',
			contract('http://whispering.epicenter.so'),
		);
		const failed = await f.cli('clone', source);
		expect(failed.code).not.toBe(0);
		expect(existsSync(join(f.library, 'invalid'))).toBe(false);
		expect(noTemps(f.library)).toEqual([]);
		const explicit = join(f.box, 'explicit-failure');
		const missing = await f.cli('clone', join(f.box, 'missing.git'), explicit);
		expect(missing.code).not.toBe(0);
		expect(existsSync(explicit)).toBe(false);
		expect(noTemps(f.box)).toEqual([]);
	} finally {
		f.cleanup();
	}
}, 60_000);
