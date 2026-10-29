/**
 * Observes how installed editors save a file, without fs_usage or strace.
 *
 * Usage:
 *   bun packages/repository/scripts/folder-editor-trace.ts             # all cases
 *   bun packages/repository/scripts/folder-editor-trace.ts vim-default sed   # named cases
 *
 * For each case it creates a fresh temp dir, writes `note.txt`, starts a
 * recursive `fs.watch` on the dir plus a 1 ms `readdir` poller, drives the
 * editor through one edit and one `:w`, and prints:
 *   - inode before/after (changed = rename-style save, same = in-place write)
 *   - names that appeared only transiently, and new names that persist after exit
 *   - poll samples in which note.txt itself was missing (the save's absent window)
 *   - the fs.watch event sequence relative to the moment `:w` was sent
 *   - save duration: `:w` sent -> editor printed "written", and the event spread
 *
 * Vim and Neovim run interactively on a real pty (a small inline python3
 * `pty.fork` bridge, since `script(1)` refuses a non-tty stdin), so swap files,
 * prompts, and messages behave as they do for a person at a terminal.
 *
 * The `*-conflict` cases open the file, edit, then replace the file underneath
 * the editor (rename it aside, link a new file in its place: an "absent
 * instant"), then send `:w` and print what the editor said and what it wrote.
 *
 * Fixtures live under $FET_ROOT (default: the OS temp dir; see FIXTURE_ROOT
 * for why Linux needs a dir outside /tmp) and are deleted after each case.
 */
import { watch } from 'node:fs';
import {
	existsSync,
	linkSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const VIM = '/usr/bin/vim';
const NVIM = '/opt/homebrew/bin/nvim';
const NVIM_STATE = join(homedir(), '.local/state/nvim');
/**
 * Where fixture dirs go. Vim's default 'backupskip' is "/tmp/*,$TMPDIR/*,..."
 * and Vim skips the backup (and with it the rename-style save and the 4913
 * probe) for matching paths, so fixtures under /tmp or $TMPDIR show an
 * in-place save that real files elsewhere do not get. On macOS the realpath
 * of $TMPDIR (/private/var/folders/...) does not match the pattern, so the
 * default is fine there; on Linux set FET_ROOT to a dir outside /tmp.
 */
const FIXTURE_ROOT = process.env.FET_ROOT ?? tmpdir();

const PTY_BRIDGE = `
import os, pty, sys, select, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
inputs = [fd, 0]
while True:
    try:
        r, _, _ = select.select(inputs, [], [], 0.05)
    except InterruptedError:
        continue
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 4096)
        if not data:
            inputs = [fd]
        else:
            os.write(fd, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const stripAnsi = (s: string) =>
	s
		.replace(/\x1b\][^\x07]*\x07/g, '')
		.replace(/\x1b\[[0-9;?>=]*[a-zA-Z]/g, '')
		.replace(/\x1b[=>()][0-9A-Za-z]?/g, '');

type Ev = { t: number; type: string; name: string | null };

/** A running pty-attached editor. */
function spawnPty(argv: string[], cwd: string) {
	const proc = Bun.spawn(['python3', '-c', PTY_BRIDGE, ...argv], {
		cwd,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, TERM: 'xterm' },
	});
	let out = '';
	(async () => {
		const dec = new TextDecoder();
		const reader = proc.stdout.getReader();
		for (let read = await reader.read(); !read.done; read = await reader.read()) out += dec.decode(read.value);
	})();
	return {
		proc,
		send: (s: string) => {
			proc.stdin.write(s);
			proc.stdin.flush();
		},
		output: () => stripAnsi(out),
		/** Resolves with ms elapsed once `pattern` appears in output after `from` chars. */
		async waitFor(pattern: RegExp, from: number, timeoutMs = 3000) {
			const s = now();
			while (now() - s < timeoutMs) {
				if (pattern.test(stripAnsi(out).slice(from))) return now() - s;
				await sleep(1);
			}
			return null;
		},
	};
}

type Ctx = {
	dir: string;
	file: string;
	mark: (label: string) => void;
	t: () => number;
};

async function trace(
	label: string,
	drive: (ctx: Ctx) => Promise<string[]>,
	opts: { extraDirs?: string[] } = {},
) {
	const dir = realpathSync(mkdtempSync(join(FIXTURE_ROOT, 'fet-')));
	const file = join(dir, 'note.txt');
	writeFileSync(file, 'line1\nline2\n');
	const st0 = statSync(file);
	const before = new Set(readdirSync(dir));
	const extraBefore = new Map(
		(opts.extraDirs ?? []).map((d) => [d, existsSync(d) ? new Set(readdirSync(d)) : new Set<string>()]),
	);
	const events: Ev[] = [];
	const marks: { t: number; label: string }[] = [];
	let t0 = now();
	const w = watch(dir, { recursive: true }, (type, name) =>
		events.push({ t: now() - t0, type, name: name as string | null }),
	);
	const seen = new Map<string, { first: number; last: number }>();
	const seenOutside = new Map<string, { first: number; last: number }>();
	const dirTag = dir.split('/').at(-1)!;
	const absent: number[] = [];
	const record = (m: typeof seen, n: string, t: number) => {
		const s = m.get(n);
		if (s) s.last = t;
		else m.set(n, { first: t, last: t });
	};
	const poll = setInterval(() => {
		const t = now() - t0;
		const names = readdirSync(dir);
		for (const n of names) record(seen, n, t);
		if (!names.includes('note.txt')) absent.push(t);
		for (const d of opts.extraDirs ?? [])
			if (existsSync(d))
				for (const n of readdirSync(d)) if (n.includes(dirTag)) record(seenOutside, `${d}/${n}`, t);
	}, 1);
	await sleep(300);
	events.length = 0;
	t0 = now();
	const ctx: Ctx = {
		dir,
		file,
		mark: (l) => marks.push({ t: now() - t0, label: l }),
		t: () => now() - t0,
	};
	const notes = await drive(ctx);
	await sleep(400);
	clearInterval(poll);
	w.close();
	const after = readdirSync(dir);
	const st1 = existsSync(file) ? statSync(file) : null;
	const content = existsSync(file) ? readFileSync(file, 'utf8') : '<missing>';

	console.log(`\n=== ${label} ===`);
	console.log(
		`  inode ${st0.ino} -> ${st1?.ino ?? 'missing'} (${st1 && st1.ino === st0.ino ? 'SAME: in-place write' : 'CHANGED: new file renamed/linked into place'}); nlink after ${st1?.nlink}; mode ${st0.mode.toString(8)} -> ${st1?.mode.toString(8)}`,
	);
	console.log(`  final content: ${JSON.stringify(content)}`);
	const transient = [...seen.keys()].filter((n) => !before.has(n) && !after.includes(n));
	const eventNames = new Set(events.map((e) => e.name).filter((n): n is string => !!n));
	const transientEventOnly = [...eventNames].filter(
		(n) => !before.has(n) && !after.includes(n) && !seen.has(n),
	);
	console.log(
		`  transient names (poller): ${JSON.stringify(transient.map((n) => `${n} [+${seen.get(n)!.first.toFixed(0)}..+${seen.get(n)!.last.toFixed(0)}ms]`))}`,
	);
	console.log(`  transient names (events only, too brief for poller): ${JSON.stringify(transientEventOnly)}`);
	console.log(
		`  note.txt missing from readdir in ${absent.length} poll samples${absent.length ? ` (+${absent[0]!.toFixed(1)}..+${absent.at(-1)!.toFixed(1)}ms)` : ''}`,
	);
	console.log(`  persisted new names: ${JSON.stringify(after.filter((n) => !before.has(n)))}`);
	for (const [d, b] of extraBefore) {
		const a = existsSync(d) ? readdirSync(d) : [];
		const mine = a.filter((n) => n.includes('note.txt'));
		console.log(
			`  outside dir ${d}: new entries persisted ${JSON.stringify(a.filter((n) => !b.has(n)))}; entries naming note.txt ${JSON.stringify(mine)}`,
		);
	}
	for (const [n, s] of seenOutside)
		console.log(`  outside dir, seen during run: ${n} [+${s.first.toFixed(0)}..+${s.last.toFixed(0)}ms]`);
	for (const n of notes) console.log(`  ${n}`);
	const timeline = [
		...marks.map((m) => ({ t: m.t, line: `-- ${m.label}` })),
		...events.map((e) => ({
			t: e.t,
			line: `${e.type.padEnd(6)} ${e.name === null ? 'null' : JSON.stringify(e.name)}`,
		})),
	].sort((a, b) => a.t - b.t);
	console.log('  timeline (ms since editor spawn):');
	for (const r of timeline) console.log(`    +${r.t.toFixed(1).padStart(7)}  ${r.line}`);
	rmSync(dir, { recursive: true, force: true });
}

/** Open, add a line, `:w`, `:q`. Returns notes with save timing. */
function editAndSave(argv: (file: string) => string[], writtenRe = /written/) {
	return async (ctx: Ctx) => {
		const ed = spawnPty(argv(ctx.file), ctx.dir);
		ctx.mark('spawned');
		await ed.waitFor(/note\.txt/, 0, 3000);
		await sleep(300);
		ctx.mark('opened (edit sent)');
		ed.send('Gox\x1b');
		await sleep(300);
		const from = ed.output().length;
		ctx.mark(':w sent');
		ed.send(':w\r');
		const saveMs = await ed.waitFor(writtenRe, from);
		ctx.mark(`"written" seen (${saveMs?.toFixed(1)}ms)`);
		await sleep(400);
		ctx.mark(':q sent');
		ed.send(':q\r');
		const exited = await Promise.race([ed.proc.exited, sleep(3000).then(() => 'timeout')]);
		if (exited === 'timeout') ed.proc.kill();
		ctx.mark(`exited ${exited}`);
		return [
			`save: ":w" -> "written" message ${saveMs === null ? 'NOT SEEN' : `${saveMs.toFixed(1)}ms`}`,
			`editor said: ${JSON.stringify(ed.output().slice(from).replace(/\s+/g, ' ').trim().slice(0, 200))}`,
		];
	};
}

/** Open, edit, replace file underneath (absent instant), then `:w`, answer prompt `answer`. */
function conflict(argv: (file: string) => string[], answer: string) {
	return async (ctx: Ctx) => {
		const ed = spawnPty(argv(ctx.file), ctx.dir);
		ctx.mark('spawned');
		await ed.waitFor(/note\.txt/, 0, 3000);
		await sleep(300);
		ed.send('Gox\x1b');
		await sleep(300);
		ctx.mark('replace underneath: rename note.txt -> note.txt.aside');
		renameSync(ctx.file, `${ctx.file}.aside`);
		const fresh = join(ctx.dir, 'external.tmp');
		writeFileSync(fresh, 'EXTERNAL\n');
		await sleep(5);
		linkSync(fresh, ctx.file);
		unlinkSync(fresh);
		ctx.mark('replace done: new file linked at note.txt');
		await sleep(1100); // ensure mtime differs at 1s granularity too
		const from = ed.output().length;
		ctx.mark(':w sent');
		ed.send(':w\r');
		await sleep(700);
		const said = ed.output().slice(from);
		const from2 = ed.output().length;
		ctx.mark(`answer ${JSON.stringify(answer)} sent`);
		ed.send(answer);
		await sleep(700);
		const said2 = ed.output().slice(from2);
		ed.send('\x1b:qa!\r');
		const exited = await Promise.race([ed.proc.exited, sleep(3000).then(() => 'timeout')]);
		if (exited === 'timeout') ed.proc.kill();
		ctx.mark(`exited ${exited}`);
		const aside = readFileSync(`${ctx.file}.aside`, 'utf8');
		return [
			`after :w the editor said: ${JSON.stringify(said.replace(/\s+/g, ' ').trim().slice(0, 300))}`,
			`after answer: ${JSON.stringify(said2.replace(/\s+/g, ' ').trim().slice(0, 300))}`,
			`note.txt.aside content: ${JSON.stringify(aside)}`,
		];
	};
}

const vim = (...opts: string[]) => (f: string) => [VIM, '-u', 'DEFAULTS', '-i', 'NONE', ...opts, f];
const nvim = (...opts: string[]) => (f: string) => [NVIM, '--clean', ...opts, f];
const nvimDirs = [join(NVIM_STATE, 'swap'), join(NVIM_STATE, 'backup')];

const cases: Record<string, () => Promise<void>> = {
	'vim-none': () =>
		trace('vim -u NONE (not default; compatible mode)', editAndSave((f) => [VIM, '-u', 'NONE', '-i', 'NONE', f])),
	'vim-default': () => trace('vim -u DEFAULTS', editAndSave(vim())),
	'vim-backupcopy-yes': () => trace('vim -u DEFAULTS, backupcopy=yes', editAndSave(vim('-c', 'set backupcopy=yes'))),
	'vim-backup': () =>
		trace('vim -u DEFAULTS, backup writebackup', editAndSave(vim('-c', 'set backup writebackup'))),
	'vim-backupcopy-no': () => trace('vim -u DEFAULTS, backupcopy=no', editAndSave(vim('-c', 'set backupcopy=no'))),
	'vim-hardlinked': () =>
		trace('vim -u DEFAULTS, file has a 2nd hard link outside the dir', async (ctx) => {
			const other = realpathSync(mkdtempSync(join(FIXTURE_ROOT, 'fet-link-')));
			linkSync(ctx.file, join(other, 'alias.txt'));
			const notes = await editAndSave(vim())(ctx);
			notes.push(`hard link alias content after: ${JSON.stringify(readFileSync(join(other, 'alias.txt'), 'utf8'))}`);
			rmSync(other, { recursive: true, force: true });
			return notes;
		}),
	'nvim-default': () => trace('nvim --clean', editAndSave(nvim()), { extraDirs: nvimDirs }),
	'nvim-backupcopy-yes': () =>
		trace('nvim --clean, backupcopy=yes', editAndSave(nvim('-c', 'set backupcopy=yes')), { extraDirs: nvimDirs }),
	'nvim-backup': () =>
		trace('nvim --clean, backup writebackup', editAndSave(nvim('-c', 'set backup writebackup')), {
			extraDirs: nvimDirs,
		}),
	'nvim-backupcopy-no': () =>
		trace('nvim --clean, backupcopy=no', editAndSave(nvim('-c', 'set backupcopy=no')), { extraDirs: nvimDirs }),
	sed: () =>
		trace("sed -i '' (BSD sed)", async (ctx) => {
			ctx.mark('sed spawned');
			const s = now();
			const p = Bun.spawn(['sed', '-i', '', 's/line1/LINE1/', ctx.file], { cwd: ctx.dir });
			await p.exited;
			ctx.mark(`sed exited ${p.exitCode}`);
			return [`sed run time ${(now() - s).toFixed(1)}ms`];
		}),
	'vim-conflict': () =>
		trace('vim -u DEFAULTS: file replaced underneath, then :w, answer y', conflict(vim(), 'y')),
	'vim-conflict-no': () =>
		trace('vim -u DEFAULTS: file replaced underneath, then :w, answer n', conflict(vim(), 'n')),
	'nvim-conflict': () =>
		trace('nvim --clean: file replaced underneath, then :w, answer y', conflict(nvim(), 'y'), {
			extraDirs: nvimDirs,
		}),
};

const wanted = process.argv.slice(2);
console.log(`bun ${Bun.version} ${process.platform} ${process.arch}`);
for (const [name, run] of Object.entries(cases)) {
	if (wanted.length && !wanted.includes(name)) continue;
	await run();
}
