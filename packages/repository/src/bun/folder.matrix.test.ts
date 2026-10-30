/**
 * Folder Editor Matrix
 *
 * Each recorded editor save pattern (`scripts/folder-editor-trace.ts`
 * recorded them on macOS, and on Linux with strace), scripted against a
 * real folder, the Bun folder port and a live engine on a repository
 * served in this process; then the installed vim and nvim, driven
 * headless with each setting.
 *
 * Key behaviors (per pattern):
 * - one save is one change on the server, and the engine's own write never comes back as another
 * - the swap file, the write probe, the backup and every temporary name are never sent
 * - a remote change arriving while the file is open reaches the file, and the next save keeps it
 * - the folder converges: each file equals the server's text
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	closeSync,
	copyFileSync,
	existsSync,
	ftruncateSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryGitStore } from '../server/memory-git.js';
import { createServer, type Server } from '../server/server.js';
import { directPush } from '../sim/harness.js';
import { authenticateBearer } from '../wire/wire.js';
import { type Line, sync } from './folder-commands.js';
import { serveRepository } from './serve.js';
import { openBunSqlite } from './sqlite.js';

const note = (body: string) => `---\ntitle: A\n---\n${body}`;
let root: string;
let dir: string;
let server: Server;
let served: ReturnType<typeof serveRepository>;
let stop: () => void = () => {};
let running: Promise<number>;
/** Commits on main whose author is the folder (its device), by the paths they changed. */
const commits: string[][] = [];
const lines: Line[] = [];

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'folder-matrix-'));
	dir = join(root, 'home');
	Bun.spawnSync(['mkdir', '-p', dir]);
	server = createServer({
		store: openBunSqlite(),
		git: createMemoryGitStore(),
		clock: () => Date.now(),
		onCommit: (committed) => {
			if (committed.author.user === 'ada')
				commits.push(committed.files.map((f) => f.path).sort());
		},
	});
	served = serveRepository({
		repository: 'home',
		serverId: 'local',
		server,
		authenticate: authenticateBearer((token) => ({
			user: token,
			role: 'owner',
		})),
		port: 0,
	});
	const base = { dataDir: join(root, 'data'), token: 'ada', quiet: 150 };
	expect(
		await sync(
			{
				...base,
				dir,
				join: { repository: 'me/home', server: served.url },
				once: true,
			},
			(line) => void lines.push(line),
		),
	).toBe(0);
	running = sync(
		{ ...base, dir, stop: new Promise<void>((resolve) => (stop = resolve)) },
		(line) => void lines.push(line),
	);
	await Bun.sleep(800);
});
afterAll(async () => {
	stop();
	await running;
	await served.stop();
	rmSync(root, { recursive: true, force: true });
});

const at = (name: string) => join(dir, name);
/** Wait for the server to hold `text` at `path`, then for the folder to be quiet. */
async function landed(path: string, text: string) {
	for (let i = 0; i < 100 && server.read(path) !== text; i++)
		await Bun.sleep(50);
	expect(server.read(path)).toBe(text);
	await Bun.sleep(600);
}
/** The commits a save made: since `from`. */
const since = (from: number) => commits.slice(from);
const never = (...names: string[]) => {
	for (const name of names)
		expect(
			[...server.snapshot().keys()].some((path) => path.endsWith(name)),
		).toBe(false);
};

/** Each pattern: a save of `text` at `name` as the editor makes it. */
const PATTERNS: Record<string, (name: string, text: string) => Promise<void>> =
	{
		// VS Code's text save: write in place (DiskFileSystemProvider.writeFile without atomic; source, not observed).
		'in place, truncate then write (VS Code, Obsidian unrecorded)': async (
			name,
			text,
		) => {
			const fd = openSync(at(name), 'r+');
			ftruncateSync(fd, 0);
			await Bun.sleep(5);
			writeSync(fd, text, 0);
			closeSync(fd);
		},
		'atomic: temp beside, renamed over': async (name, text) => {
			writeFileSync(at(`.${name}.tmp`), text);
			renameSync(at(`.${name}.tmp`), at(name));
		},
		'vim backupcopy=no (and auto, for a file with one link): probe 4913, name~, new file, backup removed':
			async (name, text) => {
				writeFileSync(at('4913'), '');
				unlinkSync(at('4913'));
				renameSync(at(name), at(`${name}~`));
				writeFileSync(at(name), text);
				unlinkSync(at(`${name}~`));
			},
		'vim backupcopy=yes: name~ copied, written in place, backup removed':
			async (name, text) => {
				copyFileSync(at(name), at(`${name}~`));
				writeFileSync(at(name), text);
				unlinkSync(at(`${name}~`));
			},
		'vim set backup: name~ kept': async (name, text) => {
			writeFileSync(at('4913'), '');
			unlinkSync(at('4913'));
			renameSync(at(name), at(`${name}~`));
			writeFileSync(at(name), text);
		},
		'vim swap file open for the session': async (name, text) => {
			writeFileSync(at(`.${name}.swp`), 'swap');
			writeFileSync(at(name), text);
		},
		'JetBrains safe write': async (name, text) => {
			writeFileSync(at(`${name}___jb_tmp___`), text);
			renameSync(at(name), at(`${name}___jb_old___`));
			renameSync(at(`${name}___jb_tmp___`), at(name));
			unlinkSync(at(`${name}___jb_old___`));
		},
		'BSD sed -i: .!pid!name renamed over': async (name, text) => {
			writeFileSync(at(`.!123!${name}`), text);
			renameSync(at(`.!123!${name}`), at(name));
		},
	};

describe('each recorded save pattern', () => {
	let n = 0;
	for (const [pattern, save] of Object.entries(PATTERNS))
		test(pattern, async () => {
			const name = `m${++n}.md`;
			writeFileSync(at(name), note('one\n'));
			await landed(name, note('one\n'));
			const from = commits.length;
			await save(name, note('one\ntwo\n'));
			await landed(name, note('one\ntwo\n'));
			// One change per save, and no echo of the engine's own record.
			expect(since(from)).toEqual([[name]]);
			never('4913', '~', '.swp', '___jb_tmp___', '___jb_old___', '.tmp');
			// A remote change while the file is open reaches the file; the next save keeps it.
			const remote = server.read(name) ?? '';
			expect(
				server.push(
					directPush(
						server,
						'bo',
						[{ path: name, text: `${remote}remote\n` }],
						{ device: 'laptop', time: new Date().toISOString() },
					),
					{ user: 'bo', role: 'writer' },
				).kind,
			).toBe('applied');
			for (
				let i = 0;
				i < 60 && readFileSync(at(name), 'utf8') !== `${remote}remote\n`;
				i++
			)
				await Bun.sleep(50);
			expect(readFileSync(at(name), 'utf8')).toBe(`${remote}remote\n`);
			await save(name, `${remote}remote\nthree\n`);
			await landed(name, `${remote}remote\nthree\n`);
			expect(readFileSync(at(name), 'utf8')).toBe(server.read(name) ?? '');
			if (existsSync(at(`${name}~`))) unlinkSync(at(`${name}~`));
			if (existsSync(at(`.${name}.swp`))) unlinkSync(at(`.${name}.swp`));
		}, 20_000);
});

/** The installed editor, driven headless: one save of `name` with `settings`. */
function drive(binary: string, name: string, settings: string[]) {
	const args = binary.endsWith('nvim')
		? ['--clean', '--headless']
		: ['-u', 'DEFAULTS', '-i', 'NONE', '-es'];
	return Bun.spawnSync(
		[
			binary,
			...args,
			...settings.flatMap((setting) => ['-c', `set ${setting}`]),
			'-c',
			'normal Goheadless',
			'-c',
			'wq',
			at(name),
		],
		{ stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: 10_000 },
	);
}

describe('the installed editors, headless', () => {
	const editors = ['/usr/bin/vim', '/opt/homebrew/bin/nvim'].filter((binary) =>
		existsSync(binary),
	);
	const SETTINGS: string[][] = [
		[],
		['backupcopy=yes'],
		['backupcopy=no'],
		['backup', 'writebackup'],
	];
	let n = 0;
	for (const binary of editors)
		for (const settings of SETTINGS)
			test(`${binary.split('/').at(-1)} ${settings.join(' ') || '(default)'}`, async () => {
				const name = `v${++n}.md`;
				writeFileSync(at(name), note('one\n'));
				await landed(name, note('one\n'));
				const from = commits.length;
				expect(drive(binary, name, settings).exitCode).toBe(0);
				await landed(name, note('one\nheadless\n'));
				expect(since(from)).toEqual([[name]]);
				never('4913', '~', '.swp', '.swx');
				if (existsSync(at(`${name}~`))) unlinkSync(at(`${name}~`));
			}, 20_000);
});
