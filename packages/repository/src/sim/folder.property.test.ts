/**
 * Folder Property Test
 *
 * A folder kept by the folder engine (`folder/engine.ts`) in the memory
 * world: one person's folder (`ada`) over a memory file system whose events
 * are delayed, coalesced, dropped silently or lost to an overflow, another
 * person's device (`bo`) writing the same notes and blobs (sometimes as a
 * batch, as an agent does), on virtual time, through seeded random steps:
 *
 * - editors saving in each recorded style: in place (truncate, then the
 *   bytes, a gap between), atomic (a dot temp renamed over), vim-like
 *   (`name~` and a new file), vim `backupcopy=yes` (a copy, then in place),
 *   JetBrains-like (`___jb_tmp___`, `___jb_old___`); a guarded editor
 *   reloads before each edit, and a stale buffer saved late overwrites
 *   knowingly; a blind writer overwrites a file it never read;
 * - create, delete, `mv` of a file and of a directory, a copy, `touch`,
 *   identical bytes, writes into dot folders and to ignored names, a slow
 *   writer growing a file across quiet windows, a case twin of a path, a
 *   note that is not UTF-8, frontmatter that does not parse;
 * - blobs written, replaced, deleted and renamed here and on bo's device,
 *   with uploads completing, failing, refused or late;
 * - the engine live or stopped, and a stopped folder's `commit -m`;
 * - crashes at any step boundary (the engine's calls in progress never finish).
 *
 * Every step is a word token (`t<n>z`) on a line of its own. A token is
 * owed once a writer's save put it in a file or a replica, until a write
 * that did not carry it forward (a deliberate removal, counted at the
 * instant of the write, for exactly the tokens the file held then).
 *
 * Key behaviors (after every step, and at quiescence):
 * - No save lost: every owed token is in the folder (scratch included), an editor's write in progress, a replica, or the server; at quiescence, in the server's text or in a held file
 * - None applied twice: at quiescence no token appears twice in a server text or a file outside its conflict blocks, nor twice in any one side of a block (read the same way); a base section is never counted
 * - A commit is one group: no push first sent after a commit, without its message, lands the text that commit read at one of its paths before the commit lands (unless a writer made the path hold that text again since: a copy, a delete, a blob moved back), and each message lands in at most one commit
 * - Own writes never echo: once quiet, a further idle period and a scan send nothing
 * - Convergence: at quiescence every file equals the replica's `mine` and `mine` equals the server's, except held files; every file the repository cannot take is held
 * - Ignored stays ignored: the server never holds a dot path or a dropping, and the engine never writes or removes one
 * - The engine never drops a capture it has not read, and never writes a file whose path folds to another file's in the folder (the memory port checks both)
 *
 * F_SEED=n replays one sequence, F_RUNS=n runs n seeds from F_FROM
 * (default 1), F_STEPS=n sets the steps per seed, F_TWINS=0 turns case
 * twins off. To read a failing seed: F_TRACE=1 logs each push and commit,
 * F_WATCH=<path> a file's replica rows after each step, F_TOKEN=<token>
 * where a token is, and F_LOG=n how many steps are shown.
 */
import { expect, test } from 'bun:test';
import { parsePointer, writePointer } from '../core/markdown.js';
import { findConflicts } from '../core/conflict.js';
import { fold } from '../core/door.js';
import { ignored, TWIN } from '../folder/engine.js';
import { createWorld, type Device } from './harness.js';
import { createRandom, type Random } from './net.js';
import { createFolderDevice, type FolderDevice, type Lfs, oidOf, runFor, until, uploadBlob } from './folder.test-support.js';

const env = (name: string) => process.env[`F_${name}`];
const SEED = env('SEED');
const RUNS = Number(env('RUNS') ?? 30);
const FROM = Number(env('FROM') ?? 1);
const STEPS = Number(env('STEPS') ?? 80);
const QUIET = 150;
/** Case twins on (a case-sensitive folder holding two spellings of one path): F_TWINS=0 turns the step off. */
const TWINS = env('TWINS') !== '0';

const NOTES = ['n/a.md', 'n/b.md', 'd/c.md', 'd/e/f.md'];
const BLOBS = ['m/x.png', 'm/y.webm'];
const TOKEN = /t\d+z/g;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const tokensIn = (text: string | null) => new Set(text === null ? [] : (text.match(TOKEN) ?? []));
const note = (lines: string[]) => `---\ntitle: N\n---\n${lines.map((line) => `${line}\n`).join('')}`;
const appended = (text: string | null, token: string) => (text === null || text === '' ? note([token]) : `${text.endsWith('\n') ? text : `${text}\n`}${token}\n`);

/**
 * The texts in which no token may appear twice: a file's text outside its
 * conflict blocks, and each side of each block, read the same way (a side
 * may hold blocks of its own, escaped). A block's base section repeats the
 * base by design and is not counted; nor are two sides counted together, or
 * a side with the text around it: the core merge keeps an existing block
 * whole beside a new one, and keeps both bodies of two creates, so a block's
 * side repeats lines the text around it has (both by design, `core/merge.ts`).
 */
function versionsOf(text: string, where = 'outside blocks'): [string, string][] {
	const blocks = findConflicts(text);
	let outside = '';
	let at = 0;
	for (const block of blocks) {
		outside += text.slice(at, block.from);
		at = block.to;
	}
	outside += text.slice(at);
	return [
		[where, outside],
		...blocks.flatMap((block) => [...versionsOf(block.current, `block at line ${block.line}, current`), ...versionsOf(block.incoming, `block at line ${block.line}, incoming`)]),
	];
}

async function run(seed: number, steps: number) {
	const random = createRandom(seed * 7919 + 17);
	const world = createWorld({ seed, latency: { min: 2, max: 30 }, loss: { up: 0.03, down: 0.03 }, streamLoss: 0.02, stall: { chance: 0.02, ms: 2_500 } });
	const lfs: Lfs = new Map();
	const faults = {
		delay: () => (random.chance(0.2) ? random.int(0, 400) : random.int(0, 20)),
		drop: () => random.chance(0.02),
		overflow: () => random.chance(0.01),
	};
	const folder: FolderDevice = createFolderDevice(world, 'ada', { lfs, faults, quiet: QUIET, scanEvery: 30_000, step: () => (random.chance(0.3) ? random.int(1, 4) : 0) });
	const bo: Device = world.device('bo');
	const log: string[] = [];
	const violations: string[] = [];
	let n = 0;
	const token = () => `t${++n}z`;
	/** Each atomic save's own temporary name, as an editor makes one (a pid, a counter): two saves never share one. */
	let temps = 0;

	/** Tokens a writer saved, not removed on purpose since. */
	const owed = new Set<string>();
	/** Bytes an editor is in the middle of writing (a two-part in-place save), by path: they count as somewhere. */
	const writing = new Map<string, string>();
	/** A stale buffer an editor loaded earlier, saved later over whatever is there. */
	const stale = new Map<string, string>();
	const staleTokens = new Map<string, string>();
	/** Paths of each message's group, until its commit lands. */
	/** Each message's group, until its commit lands: the text the replica took for each path (what the commit says), and when. */
	const groups = new Map<string, { paths: Set<string>; texts: Map<string, string | null>; at: number }>();
	const landedMessages = new Map<string, Set<string>>();
	/** What writers in the folder made each path hold, and when: a delete is null, a blob its pointer. A later push of the same text there may be that writer's save, not a group's. */
	const made = new Map<string, { at: number; text: string | null }[]>();
	const contentOf = (p: string, bytes: Uint8Array | null) => (bytes === null ? null : p.endsWith('.md') ? decoder.decode(bytes) : writePointer(oidOf(bytes)));
	const make = (p: string, bytes: Uint8Array | null) => {
		const list = made.get(fold(p)) ?? [];
		list.push({ at: world.net.now(), text: contentOf(p, bytes) });
		made.set(fold(p), list);
	};
	const madeSince = (p: string, text: string | null, at: number) => (made.get(p) ?? []).some((m) => m.at >= at && m.text === text);
	{
		const disk = folder.disk;
		const [write, unlink, rename, writeInode] = [disk.write, disk.unlink, disk.rename, disk.writeInode];
		disk.write = (p, bytes) => {
			const done = write(p, bytes);
			if (done) make(p, bytes);
			return done;
		};
		disk.unlink = (p) => {
			const done = unlink(p);
			if (done) make(p, null);
			return done;
		};
		disk.rename = (from, to) => {
			const moving = disk.paths().filter((p) => p === from || p.startsWith(`${from}/`));
			const done = rename(from, to);
			if (done) for (const p of moving) {
				make(p, null);
				const there = `${to}${p.slice(from.length)}`;
				make(there, disk.bytes(there));
			}
			return done;
		};
		disk.writeInode = (ino, bytes) => {
			const at = disk.paths().filter((p) => disk.inodeOf(p) === ino);
			const done = writeInode(ino, bytes);
			for (const p of at) make(p, bytes);
			return done;
		};
	}
	let live = true;

	// ------------------------------------------------------------------------
	// Writing a file as an editor does, with the removals it makes counted
	// ------------------------------------------------------------------------

	/** Count what a write to `path` removes: tokens the file held then that `next` does not carry. */
	function removing(path: string, next: string | null) {
		const before = tokensIn(folder.disk.text(path));
		const after = tokensIn(next);
		for (const t of before) if (!after.has(t)) owed.delete(t);
	}
	/** Tokens a writer wrote again on purpose (a stale buffer, a copy, a repair): they may appear more than once. */
	const retyped = new Set<string>();
	const retype = (text: string | null) => {
		for (const t of tokensIn(text)) retyped.add(t);
	};
	/** A writer's new tokens are owed once its write is done; a copy or a move carries tokens already owed (or already removed). */
	function owe(fresh: string[]) {
		for (const t of fresh) owed.add(t);
	}
	function put(path: string, text: string, fresh: string[] = []) {
		removing(path, text);
		if (folder.disk.write(path, encoder.encode(text))) owe(fresh);
	}
	const later = (ms: number, run: () => void) => world.net.after(ms, run);

	type Style = 'in-place' | 'atomic' | 'vim' | 'vim-backupcopy' | 'jetbrains';
	const STYLES: Style[] = ['in-place', 'atomic', 'vim', 'vim-backupcopy', 'jetbrains'];
	const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
	const dir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
	const beside = (path: string, file: string) => (dir(path) === '' ? file : `${dir(path)}/${file}`);

	/** Save `text` at `path` in `style`, its steps spread over virtual time shorter than a quiet window. */
	function save(path: string, text: string, style: Style, fresh: string[] = []) {
		switch (style) {
			case 'in-place': {
				const ino = folder.disk.inodeOf(path);
				if (ino === null) return put(path, text, fresh);
				// Truncate, then the bytes after a gap: a reader between sees the empty file.
				writing.set(path, text);
				const before = folder.disk.text(path);
				for (const t of tokensIn(before)) if (!tokensIn(text).has(t)) owed.delete(t);
				folder.disk.writeInode(ino, new Uint8Array());
				later(random.int(1, QUIET / 3), () => {
					writing.delete(path);
					// What another writer put in the file since the truncate is overwritten too.
					for (const t of tokensIn(folder.disk.inodeText(ino))) if (!tokensIn(text).has(t)) owed.delete(t);
					// Through the descriptor: wherever the inode is now, at the path or captured.
					if (folder.disk.writeInode(ino, encoder.encode(text))) owe(fresh);
				});
				return;
			}
			case 'atomic': {
				const temp = beside(path, `.${name(path)}.tmp${++temps}`);
				folder.disk.write(temp, encoder.encode(text));
				writing.set(path, text);
				later(random.int(0, 10), () => {
					writing.delete(path);
					// The model's own check: an editor's temporary is its own until it is renamed.
					if (folder.disk.text(temp) !== text) violations.push(`the test model: ${temp} was written by another save`);
					removing(path, text);
					if (folder.disk.rename(temp, path)) owe(fresh);
				});
				return;
			}
			case 'vim': {
				const backup = beside(path, `${name(path)}~`);
				const had = folder.disk.text(path) !== null;
				writing.set(path, text);
				if (had) folder.disk.rename(path, backup);
				later(random.int(0, 10), () => {
					writing.delete(path);
					removing(backup, text);
					removing(path, text);
					if (folder.disk.write(path, encoder.encode(text))) owe(fresh);
					folder.disk.unlink(backup);
				});
				return;
			}
			case 'vim-backupcopy': {
				const backup = beside(path, `${name(path)}~`);
				const before = folder.disk.text(path);
				if (before !== null) folder.disk.write(backup, encoder.encode(before));
				save(path, text, 'in-place', fresh);
				// `set backup` keeps the copy; otherwise it goes.
				if (random.chance(0.5)) later(QUIET / 2, () => folder.disk.unlink(backup));
				return;
			}
			case 'jetbrains': {
				const temp = beside(path, `${name(path)}___jb_tmp___`);
				const old = beside(path, `${name(path)}___jb_old___`);
				folder.disk.write(temp, encoder.encode(text));
				writing.set(path, text);
				later(random.int(0, 5), () => {
					const had = folder.disk.text(path) !== null;
					if (had) folder.disk.rename(path, old);
					later(random.int(0, 5), () => {
						writing.delete(path);
						removing(old, text);
						removing(path, text);
						if (folder.disk.rename(temp, path)) owe(fresh);
						folder.disk.unlink(old);
					});
				});
				return;
			}
		}
	}

	// ------------------------------------------------------------------------
	// Steps
	// ------------------------------------------------------------------------

	const path = () => random.pick(NOTES);
	const blobPath = () => random.pick(BLOBS);
	const bytes = () => encoder.encode(`bytes ${random.int(0, 3)} ${random.int(0, 1_000_000)}`);
	const busy = (p: string) => writing.has(p);
	/** What bo's device shows at `p` under whichever spelling it keeps (`read` is exact): bo writes over what it read. */
	const boRead = (p: string) => {
		for (const [q, f] of bo.replica.files()) if (fold(q) === fold(p)) return f.mine;
		return null;
	};

	const STEP_TABLE: [number, () => string | null | Promise<string | null>][] = [
		// A guarded editor: loads what is there, adds a token, saves in a recorded style.
		[
			20,
			() => {
				const p = path();
				if (busy(p)) return null;
				const style = random.pick(STYLES);
				const t = token();
				save(p, appended(folder.disk.text(p), t), style, [t]);
				return `ada edits ${p} (${style}) +${t}`;
			},
		],
		// An editor loads a buffer now and saves it much later, knowingly over whatever is there then.
		[
			2,
			() => {
				const p = path();
				const text = folder.disk.text(p);
				if (text === null) return null;
				const t = token();
				stale.set(p, appended(text, t));
				staleTokens.set(p, t);
				return `ada loads ${p} into a buffer it will save late`;
			},
		],
		[
			2,
			() => {
				const [p, text] = [...stale][0] ?? [];
				if (p === undefined || text === undefined || busy(p)) return null;
				stale.delete(p);
				retype(text);
				save(p, text, random.pick(STYLES), [staleTokens.get(p) ?? '']);
				return `ada saves a stale buffer over ${p}`;
			},
		],
		// A remote change arrives while ada's editor saves the same note again and again, at gaps around the quiet window: some saves land between the engine's last look and its write.
		[
			4,
			() => {
				const p = path();
				if (busy(p) || folder.disk.text(p) === null) return null;
				const t = token();
				bo.replica.edit(p, (text) => appended(text, t));
				owe([t]);
				let at = 0;
				for (let k = 0; k < 8; k++) {
					at += random.int(QUIET - 20, QUIET + 60);
					later(at, () => {
						if (busy(p)) return;
						const mine = token();
						save(p, appended(folder.disk.text(p), mine), random.pick(['in-place', 'atomic'] as const), [mine]);
					});
				}
				return `bo edits ${p} +${t} while ada's editor keeps saving it`;
			},
		],
		// A blind writer overwrites a file it never read.
		[
			2,
			() => {
				const p = path();
				if (busy(p)) return null;
				const t = token();
				put(p, note([t]), [t]);
				return `a blind writer overwrites ${p}`;
			},
		],
		[
			3,
			() => {
				const p = path();
				if (busy(p) || folder.disk.text(p) === null) return null;
				removing(p, null);
				folder.disk.unlink(p);
				return `ada deletes ${p}`;
			},
		],
		[
			3,
			() => {
				const [from, to] = [path(), path()];
				if (from === to || busy(from) || busy(to) || folder.disk.text(from) === null) return null;
				removing(to, folder.disk.text(from));
				folder.disk.rename(from, to);
				return `ada moves ${from} to ${to}`;
			},
		],
		[
			1,
			() => {
				const [from, to] = random.chance(0.5) ? ['d', 'moved'] : ['moved', 'd'];
				if (NOTES.some(busy)) return null;
				return folder.disk.rename(from, to) ? `ada moves the directory ${from} to ${to}` : null;
			},
		],
		[
			2,
			() => {
				const [from, to] = [path(), path()];
				const text = folder.disk.text(from);
				if (from === to || text === null || busy(to)) return null;
				retype(text);
				put(to, text);
				return `ada copies ${from} to ${to}`;
			},
		],
		[2, () => (folder.disk.touch(path()) ? 'ada touches a note' : null)],
		[
			2,
			() => {
				const p = path();
				const text = folder.disk.text(p);
				if (text === null || busy(p)) return null;
				folder.disk.write(p, encoder.encode(text));
				return `ada writes ${p}'s bytes again`;
			},
		],
		[
			2,
			() => {
				const p = random.pick(['.obsidian/workspace.json', 'n/.a.md.swp', '.DS_Store', '4913', 'n/a.md~', 'n/#a.md#', '.git/HEAD']);
				folder.disk.write(p, encoder.encode(`${token()}\n`));
				return `ada's editor drops ${p}`;
			},
		],
		// A slow writer grows a file across several quiet windows.
		[
			1,
			() => {
				const p = path();
				if (busy(p)) return null;
				const lines = [token(), token(), token()];
				let text = folder.disk.text(p) ?? note([]);
				removing(p, text);
				lines.forEach((line, i) =>
					later((i + 1) * QUIET * 1.5, () => {
						text = appended(folder.disk.text(p) ?? text, line);
						put(p, text, [line]);
					}),
				);
				return `a slow writer grows ${p}`;
			},
		],
		// A case twin of an existing path.
		[
			TWINS ? 1 : 0,
			() => {
				const p = path();
				const twin = p.replace(/[a-z](?=\.md$)/, (c) => c.toUpperCase());
				if (twin === p || folder.disk.text(p) === null || folder.disk.text(twin) !== null) return null;
				const t = token();
				put(twin, note([t]), [t]);
				return `ada makes ${twin}, a case twin of ${p}`;
			},
		],
		[
			1,
			() => {
				const p = path();
				if (busy(p)) return null;
				removing(p, null);
				folder.disk.write(p, new Uint8Array([0xff, 0xfe, 0x41]));
				return `ada saves ${p} as bytes that are not UTF-8`;
			},
		],
		[
			1,
			() => {
				const p = path();
				if (busy(p)) return null;
				const t = token();
				removing(p, `---\ntitle: [\n---\n${t}\n`);
				put(p, `---\ntitle: [\n---\n${t}\n`, [t]);
				return `ada breaks ${p}'s frontmatter +${t}`;
			},
		],
		// Blobs here.
		[
			3,
			() => {
				const p = blobPath();
				folder.disk.write(p, bytes());
				return `ada writes the blob ${p}`;
			},
		],
		[1, () => (folder.disk.unlink(blobPath()) ? 'ada deletes a blob' : null)],
		[1, () => (folder.disk.rename('m/x.png', 'm/z.png') || folder.disk.rename('m/z.png', 'm/x.png') ? 'ada renames a blob' : null)],
		[
			3,
			async () => {
				await until(world, folder.upload());
				return 'the upload track sends what ada owes';
			},
		],
		[
			1,
			() => {
				const owedBytes = folder.replica.owed()[0];
				if (owedBytes === undefined) return null;
				folder.replica.refused(owedBytes.oid, 'the file is larger than this repository allows');
				return `ada's upload of ${owedBytes.oid.slice(0, 6)} is refused`;
			},
		],
		// Bo, elsewhere.
		[
			8,
			() => {
				const p = path();
				const t = token();
				bo.replica.edit(p, (text) => appended(text, t));
				owe([t]);
				return `bo edits ${p} +${t}`;
			},
		],
		[
			2,
			() => {
				const [p, q] = [path(), path()];
				if (p === q) return null;
				const [t, u] = [token(), token()];
				bo.replica.change([
					{ kind: 'write', path: p, text: appended(boRead(p), t) },
					{ kind: 'write', path: q, text: appended(boRead(q), u) },
				]);
				owe([t, u]);
				return `bo saves ${p} and ${q} as one batch +${t} +${u}`;
			},
		],
		[
			1,
			() => {
				const p = path();
				const text = boRead(p);
				if (text === null) return null;
				for (const t of tokensIn(text)) owed.delete(t);
				bo.replica.write(p, null);
				return `bo deletes ${p}`;
			},
		],
		[
			2,
			() => {
				const p = blobPath();
				const pointer = uploadBlob(world, lfs, bytes());
				const sealed = parsePointer(pointer);
				bo.replica.write(p, pointer);
				if (sealed !== null && random.chance(0.8)) bo.replica.present(sealed.oid, sealed.size);
				return `bo writes the blob ${p}`;
			},
		],
		// Timing.
		[
			2,
			async () => {
				if (!live) return null;
				live = false;
				folder.engine.kill();
				folder.device.setOnline(false);
				return 'ada stops syncing';
			},
		],
		[
			3,
			async () => {
				if (live) return null;
				live = true;
				folder.device.setOnline(true);
				await folder.crash({ watch: true });
				return 'ada syncs again';
			},
		],
		[
			3,
			async () => {
				if (live) return null;
				const message = `Commit ${token()}`;
				await folder.crash({ watch: false });
				// What this device has in flight at each path: a save equal to it settles into that commit (the replica's rule), so it is not this commit's work.
				const inFlight = new Map<string, string | null>();
				for (const { commit } of folder.replica.query<{ commit: string }>('SELECT commit_json AS "commit" FROM "epicenter/inflight"', []))
					for (const file of (JSON.parse(commit) as { files: { path: string; text: string | null }[] }).files) inFlight.set(file.path, file.text);
				const saved = await until(world, folder.engine.commit(message));
				if (process.env.F_TRACE) log.push(`   (commit at ${world.net.now()}: ${saved.join(', ')}; held ${JSON.stringify(folder.replica.held())}; unsent ${folder.replica.unsent().join(', ')})`);
				// Only files with work of this commit's own: a save that changed nothing beyond what is in flight here, or else the file as the server has it, says nothing.
				const files = folder.replica.files();
				const working = saved.filter((p) => files.get(p)?.mine !== (inFlight.has(p) ? inFlight.get(p) : files.get(p)?.base));
				if (working.length > 0) groups.set(message, { paths: new Set(working.map((p) => fold(p))), texts: new Map(working.map((p) => [fold(p), folder.replica.read(p)])), at: world.net.now() });
				folder.device.setOnline(true);
				await runFor(world, random.int(0, 3_000));
				folder.engine.kill();
				folder.device.setOnline(false);
				return `ada commits ${saved.length} files: "${message}"`;
			},
		],
		[
			2,
			async () => {
				await folder.crash();
				return 'ada crashes and starts again';
			},
		],
		[2, () => (folder.device.loseNextReply(), 'ada loses the next reply')],
	];
	const total = STEP_TABLE.reduce((sum, [weight]) => sum + weight, 0);
	async function oneStep(random: Random) {
		let roll = random.int(1, total);
		for (const [weight, act] of STEP_TABLE) {
			roll -= weight;
			if (roll <= 0) return act();
		}
		return null;
	}

	// ------------------------------------------------------------------------
	// Checks
	// ------------------------------------------------------------------------

	/** When each of ada's commits was first sent: one sent before a group was made (a resend of earlier work) cannot split it. */
	const firstSent = new Map<string, number>();
	world.onRequest((device, request, reply) => {
		if (device !== 'ada' || request.type !== 'push' || reply.type !== 'answer') return;
		if (!firstSent.has(request.commit.id)) firstSent.set(request.commit.id, world.net.now());
		if (process.env.F_TRACE) log.push(`   [${world.net.now()} push ${request.commit.id.slice(0, 7)} ${JSON.stringify(request.commit.message ?? null)} ${request.commit.files.map((f) => f.path).join(',')} -> ${reply.answer.kind}]`);
		if (reply.answer.kind !== 'applied' && reply.answer.kind !== 'merged') return;
		const message = request.commit.message;
		const paths = request.commit.files.map((f) => fold(f.path));
		if (message !== undefined) {
			const ids = landedMessages.get(message) ?? new Set();
			ids.add(request.commit.id);
			landedMessages.set(message, ids);
			if (ids.size > 1) violations.push(`"${message}" landed in ${ids.size} commits`);
			groups.delete(message);
			// A held group a later commit joined lands under that commit's message: the earlier one is settled with it.
			for (const [said, group] of groups) if (group.at <= (groups.get(message)?.at ?? world.net.now()) && paths.some((p) => group.paths.has(p))) groups.delete(said);
			return;
		}
		const sent = new Map(request.commit.files.map((f) => [fold(f.path), f.text]));
		for (const [said, { paths: group, texts, at }] of groups) for (const p of paths) if (group.has(p) && sent.get(p) === texts.get(p) && !madeSince(p, texts.get(p) ?? null, at) && (firstSent.get(request.commit.id) ?? 0) > at) violations.push(`${p} of "${said}"'s group landed without its message before it did (at ${world.net.now()}, commit ${request.commit.id.slice(0, 7)} of ${paths.join(', ')})`);
	});

	function present() {
		const texts: string[] = [...folder.disk.texts().map(([, text]) => text), ...folder.disk.scratchTexts(), ...writing.values(), ...stale.values()];
		for (const device of [folder.replica, bo.replica])
			for (const f of device.files().values()) texts.push(f.mine ?? '', f.base ?? '', f.tip ?? '');
		for (const text of world.server.snapshot().values()) texts.push(text);
		const all = new Set<string>();
		for (const text of texts) for (const t of tokensIn(text)) all.add(t);
		return all;
	}
	/** Where token `t` is now, for a trace. */
	function where(t: string) {
		const at: string[] = [];
		for (const [p, text] of folder.disk.texts()) if (tokensIn(text).has(t)) at.push(`disk:${p}`);
		if (folder.disk.scratchTexts().some((text) => tokensIn(text).has(t))) at.push('scratch');
		for (const [name, device] of [['ada', folder.replica], ['bo', bo.replica]] as const)
			for (const [p, f] of device.files()) for (const [level, text] of [['mine', f.mine], ['base', f.base], ['tip', f.tip]] as const) if (tokensIn(text).has(t)) at.push(`${name}.${level}:${p}`);
		for (const [p, text] of world.server.snapshot()) if (tokensIn(text).has(t)) at.push(`server:${p}`);
		return at.join(' ');
	}
	function checkStep(label: string) {
		if (process.env.F_TOKEN !== undefined) log.push(`   <${process.env.F_TOKEN} ${owed.has(process.env.F_TOKEN) ? 'owed' : 'not owed'}: ${where(process.env.F_TOKEN)}>`);
		const here = present();
		for (const t of owed) if (!here.has(t)) violations.push(`after "${label}": ${t} is nowhere`);
		for (const p of world.server.snapshot().keys()) if (ignored(p)) violations.push(`the server holds ${p}, which is ignored`);
		violations.push(...folder.disk.violations.splice(0));
	}

	// ------------------------------------------------------------------------
	// The run
	// ------------------------------------------------------------------------

	await until(world, folder.start());
	for (let i = 0; i < steps && violations.length === 0; i++) {
		const did = await oneStep(random);
		if (did !== null) log.push(`${i}: ${did}`);
		if (process.env.F_WATCH !== undefined) {
			const w = process.env.F_WATCH;
			log.push(`   {${w}: ${JSON.stringify(folder.replica.state(w))} ${JSON.stringify(folder.replica.query('SELECT f.text IS NULL AS gone, f.text IS f.base AS clean, f.saved, f.held, u.path IS NOT NULL AS committed, (SELECT group_concat(other) FROM "epicenter/groups" g WHERE g.path = f.path) AS together, (SELECT group_concat(level || \'=\' || message) FROM "epicenter/messages" m WHERE m.path = f.path) AS said FROM "epicenter/files" f LEFT JOIN "epicenter/unsent" u ON u.path = f.path WHERE f.path = ?', [w]))}}`);
		}
		await runFor(world, random.int(0, 600));
		checkStep(did ?? `step ${i}`);
	}

	// Quiescence: everyone online, ada live, every upload through, editors stopped, the network calm.
	world.calm();
	// Editors finish the saves they are making before the stale buffers are saved.
	while (writing.size > 0) await runFor(world, 10);
	for (const [p, text] of stale) {
		stale.delete(p);
		retype(text);
		save(p, text, 'atomic', [staleTokens.get(p) ?? '']);
	}
	if (!live) {
		live = true;
		folder.device.setOnline(true);
	}
	await folder.crash({ watch: true });
	bo.setOnline(true);
	for (let round = 0; round < 6; round++) {
		await runFor(world, 3_000);
		await until(world, folder.upload());
		for (const owedBytes of bo.replica.owed()) bo.replica.present(owedBytes.oid, owedBytes.size);
		// Repairs: what a person holds back they fix and save again (a note), or save again (a blob kept).
		for (const { path: p } of folder.replica.held()) {
			const text = folder.disk.text(p);
			retype(text);
			if (p.endsWith('.md')) put(p, note([...tokensIn(text ?? '')].concat([token()])));
			else if (text !== null) folder.disk.write(p, bytes());
		}
		for (const { path: p, reason } of folder.engine.held()) {
			// A file whose name another's folds to: the person renames it.
			if (reason === TWIN) folder.disk.rename(p, p.replace(/(\.[a-z]+)$/, ` ${token()}$1`));
			else put(p, note([token()]));
		}
		await runFor(world, 3_000);
	}
	// Two periodic scans pass, and a restart's startup scan.
	await runFor(world, 61_000);
	await folder.crash({ watch: true });
	await runFor(world, 10_000);
	await until(world, folder.engine.idle());
	world.settle();
	await runFor(world, 1_000);
	checkStep('quiescence');

	// Convergence.
	const server = world.server.snapshot();
	// Held by the replica (the door refused it) or by the engine (the repository cannot take the file): its text is the person's, in the folder.
	const held = new Set([...folder.replica.held(), ...folder.engine.held()].map((h) => h.path));
	const heldText = (p: string) => (folder.engine.held().some((h) => h.path === p) ? folder.disk.text(p) : folder.replica.read(p));
	for (const [p, text] of folder.disk.texts()) {
		if (ignored(p)) continue;
		const mine = folder.replica.read(p);
		if (mine === null && !held.has(p)) violations.push(`${p} is in the folder but not the replica`);
		else if (mine === null) continue;
		else if (p.endsWith('.md') ? text !== mine : parsePointer(mine)?.oid !== oidOf(encoder.encode(text)).oid && parsePointer(mine)?.oid !== oidOf(folder.disk.bytes(p) ?? new Uint8Array()).oid)
			violations.push(`${p}: the folder holds ${JSON.stringify(text).slice(0, 60)}, the replica ${JSON.stringify(mine).slice(0, 60)}`);
		if (!held.has(p) && mine !== (server.get(p) ?? null)) violations.push(`${p}: the replica and the server differ`);
	}
	for (const [p] of server) if (folder.disk.bytes(p) === null && !held.has(p)) violations.push(`${p} is on the server but not in the folder`);
	for (const t of owed) {
		const inServer = [...server.values()].some((text) => tokensIn(text).has(t));
		const inHeld = [...held].some((p) => tokensIn(heldText(p)).has(t));
		if (!inServer && !inHeld) violations.push(`at quiescence, ${t} is not on the server`);
	}
	for (const [p, text] of [...server, ...folder.disk.texts().filter(([p]) => p.endsWith('.md'))]) {
		for (const [version, written] of versionsOf(text)) {
			const seen = new Map<string, number>();
			for (const t of written.match(TOKEN) ?? []) seen.set(t, (seen.get(t) ?? 0) + 1);
			for (const [t, count] of seen) if (count > 1 && !retyped.has(t)) violations.push(`${t} appears ${count} times in ${p} (${version})${process.env.F_TRACE ? `:\n${text}` : ''}`);
		}
	}
	// Own writes never echo: quiet now, an idle period and a scan send nothing.
	const pushes = folder.replica.stats().pushes;
	await runFor(world, 5_000);
	await until(world, folder.engine.scan());
	await runFor(world, 5_000);
	if (folder.replica.stats().pushes !== pushes) violations.push(`an idle folder sent ${folder.replica.stats().pushes - pushes} more pushes`);
	if (folder.disk.scratchNames().length > 0) violations.push(`captures left in scratch: ${folder.disk.scratchNames().join(', ')}`);
	violations.push(...folder.disk.violations.splice(0));
	return { violations, log, decoder };
}

const seeds = SEED !== undefined ? [Number(SEED)] : Array.from({ length: RUNS }, (_, i) => FROM + i);
test(`the folder engine holds its invariants over ${seeds.length} seeds of ${STEPS} steps`, async () => {
	// Every seed runs, so one sweep names every failing seed; the first failure is shown in full.
	const failed: { seed: number; first: string }[] = [];
	let shown = '';
	for (const seed of seeds) {
		// A run that throws (the engine never idle, say) is that seed's failure, and the sweep goes on.
		const { violations, log } = await run(seed, STEPS).catch((cause: unknown) => ({ violations: [`the run threw: ${cause instanceof Error ? cause.message : String(cause)}`], log: [] as string[] }));
		if (violations.length === 0) continue;
		failed.push({ seed, first: violations[0] ?? '' });
		if (shown === '') shown = `seed ${seed} (F_SEED=${seed} F_STEPS=${STEPS}):\n${violations.slice(0, 10).join('\n')}\n\nsteps:\n${log.slice(-Number(process.env.F_LOG ?? 40)).join('\n')}`;
	}
	if (failed.length > 0) throw new Error(`${failed.length} of ${seeds.length} seeds fail:\n${failed.map((f) => `  ${f.seed}: ${f.first}`).join('\n')}\n\n${shown}`);
	expect(true).toBe(true);
}, 3_600_000);
