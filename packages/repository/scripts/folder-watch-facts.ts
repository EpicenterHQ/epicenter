/**
 * Records what `fs.watch(root, { recursive: true })` reports on this machine.
 *
 * Usage:
 *   bun packages/repository/scripts/folder-watch-facts.ts            # all scenarios
 *   bun packages/repository/scripts/folder-watch-facts.ts burst rename   # named scenarios
 *
 * Scenarios: paths, unicode, atomic, inplace, oldmodify, dirrename, rmrf, burst,
 * rename, latency, latencyburst, overflow, overflowbig.
 *
 * Each scenario runs in a fresh temp dir under the OS temp dir (deleted after),
 * with its own watcher. For each it prints the raw (eventType, filename)
 * sequence with milliseconds since the scenario's first action, plus a short
 * summary (counts, distinct names, null filenames, `error` events). Output is
 * plain text meant to be read by a person and pasted into notes.
 *
 * The watched root is `realpath`ed first: on macOS `/tmp` is a symlink to
 * `/private/tmp`, and FSEvents reports real paths.
 *
 * "rootBasenameChange" counts ('change', <basename of the watched root>) events.
 * On macOS that is how Bun 1.4.3 surfaces an FSEvents MustScanSubDirs|UserDropped
 * event on the root (verified with a raw FSEvents probe): it is the only drop
 * signal; there is no null filename and no 'error' event.
 *
 * Works on Linux too (inotify backend); run it there to compare.
 */
import { watch, type FSWatcher } from 'node:fs';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	openSync,
	writeSync,
	ftruncateSync,
	closeSync,
	linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

type Rec = { t: number; type: string; name: string | null | undefined };

/** Lines a scenario body wants printed under its header (bodies run before the header prints). */
let notes: string[] = [];
const note = (line: string) => notes.push(`  [note] ${line}`);
const form = (n: string) =>
	n === n.normalize('NFC') && n === n.normalize('NFD')
		? ''
		: n === n.normalize('NFC')
			? ' (NFC)'
			: n === n.normalize('NFD')
				? ' (NFD)'
				: ' (mixed)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

function blockLoop(ms: number) {
	const end = now() + ms;
	while (now() < end) {}
}

async function withWatcher(
	label: string,
	body: (root: string, t0: () => number) => Promise<void> | void,
	opts: { settleMs?: number; print?: number; quietPrint?: boolean } = {},
) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'fwf-')));
	const events: Rec[] = [];
	const errors: unknown[] = [];
	let start = now();
	const watcher: FSWatcher = watch(root, { recursive: true }, (type, name) => {
		events.push({ t: now() - start, type, name: name as string | null });
	});
	watcher.on('error', (e) => errors.push(e));
	// FSEvents needs a moment before the stream is live; events before that are lost.
	await sleep(300);
	const preEvents = events.length;
	notes = [];
	start = now();
	await body(root, () => now() - start);
	await sleep(opts.settleMs ?? 600);
	watcher.close();
	rmSync(root, { recursive: true, force: true });

	console.log(`\n=== ${label} ===`);
	console.log(`root: ${root}`);
	if (preEvents) console.log(`(events before first action: ${preEvents})`);
	for (const n of notes) console.log(n);
	const list = events.slice(preEvents);
	const max = opts.print ?? 60;
	for (const e of list.slice(0, max)) {
		const shown =
			e.name === null ? 'null' : e.name === undefined ? 'undefined' : JSON.stringify(e.name);
		console.log(
			`  +${e.t.toFixed(1).padStart(8)}ms  ${e.type.padEnd(6)} ${shown}${typeof e.name === 'string' ? form(e.name) : ''}`,
		);
	}
	if (list.length > max) console.log(`  ... ${list.length - max} more`);
	const nulls = list.filter((e) => e.name == null).length;
	const types = Object.entries(
		list.reduce<Record<string, number>>((a, e) => ((a[e.type] = (a[e.type] ?? 0) + 1), a), {}),
	);
	// FSEvents MustScanSubDirs|UserDropped on the root has no ItemIsDir flag, so Bun
	// strips the root prefix to "", substitutes the root's basename, and emits 'change'.
	const rootName = basename(root);
	const dropSignals = list.filter((e) => e.type === 'change' && e.name === rootName).length;
	console.log(
		`  summary: events=${list.length} nullNames=${nulls} errors=${errors.length} rootBasenameChange(drop signal)=${dropSignals} types=${JSON.stringify(Object.fromEntries(types))}`,
	);
	for (const e of errors) console.log(`  error event: ${String(e)}`);
	return { events: list, errors };
}

const scenarios: Record<string, () => Promise<unknown>> = {
	// (1) relative vs absolute, nested paths
	paths: () =>
		withWatcher('1. filename form (relative/absolute), nested create', (root) => {
			mkdirSync(join(root, 'a/b'), { recursive: true });
			writeFileSync(join(root, 'a/b/c.txt'), 'x');
			writeFileSync(join(root, 'top.txt'), 'x');
		}),

	// (2) NFC vs NFD
	unicode: async () => {
		const nfc = 'café.txt';
		const nfd = 'café.txt';
		let report = '';
		await withWatcher('2. NFC vs NFD names', (root) => {
			writeFileSync(join(root, nfc), 'nfc');
			const inoNfc = statSync(join(root, nfc)).ino;
			let sameFile = false;
			try {
				sameFile = statSync(join(root, nfd)).ino === inoNfc;
			} catch {}
			writeFileSync(join(root, nfd), 'nfd');
			const listing = readdirSync(root);
			report =
				`  NFC stat via NFD path is same inode before 2nd write: ${sameFile}\n` +
				`  readdir after writing both: ${JSON.stringify(listing.map((n) => ({ n, nfc: n === n.normalize('NFC'), codepoints: [...n].length })))}\n` +
				`  content: ${readdirSync(root).map((n) => statSync(join(root, n)).size).join(',')} bytes`;
			// A second dir where NFD is written first.
			mkdirSync(join(root, 'nfd-first'));
			writeFileSync(join(root, 'nfd-first', nfd), 'nfd');
			report += `\n  NFD-first readdir: ${JSON.stringify(readdirSync(join(root, 'nfd-first')).map((n) => (n === n.normalize('NFC') ? 'NFC' : n === n.normalize('NFD') ? 'NFD' : 'other')))}`;
		});
		console.log(report);
		console.log(
			`  (reference: NFC name length ${nfc.length}, NFD name length ${nfd.length}; event names above are JSON-escaped, compare forms below)`,
		);
		return;
	},

	// (3) atomic save
	atomic: () =>
		withWatcher('3. atomic save (write temp in same dir, rename over target)', async (root) => {
			const target = join(root, 'note.md');
			writeFileSync(target, 'v1');
			await sleep(300);
			const ino1 = statSync(target).ino;
			const tmp = join(root, '.note.md.tmp');
			writeFileSync(tmp, 'v2');
			renameSync(tmp, target);
			note(`inode before ${ino1} after ${statSync(target).ino}`);
		}),

	// (4) in-place write in two chunks
	inplace: () =>
		withWatcher('4. in-place write (truncate, chunk, 20ms gap, chunk)', async (root, t) => {
			const target = join(root, 'note.md');
			writeFileSync(target, 'original content');
			await sleep(300);
			note(`truncate at +${t().toFixed(1)}ms`);
			const fd = openSync(target, 'r+');
			ftruncateSync(fd, 0);
			writeSync(fd, 'first half ', 0);
			await sleep(20);
			note(`second chunk at +${t().toFixed(1)}ms`);
			writeSync(fd, 'second half', 11);
			closeSync(fd);
		}),

	// (4b) modify a file that existed well before the watcher started
	oldmodify: async () => {
		const pre = realpathSync(mkdtempSync(join(tmpdir(), 'fwf-')));
		writeFileSync(join(pre, 'old.md'), 'v1');
		await sleep(3000);
		const events: Rec[] = [];
		let start = now();
		const w = watch(pre, { recursive: true }, (type, name) =>
			events.push({ t: now() - start, type, name: name as string }),
		);
		await sleep(300);
		start = now();
		const fd = openSync(join(pre, 'old.md'), 'r+');
		writeSync(fd, 'v2', 0);
		closeSync(fd);
		await sleep(300);
		writeFileSync(join(pre, 'old.md'), 'v3 longer');
		await sleep(600);
		w.close();
		rmSync(pre, { recursive: true, force: true });
		console.log('\n=== 4b. modify a file created 3s before the watcher (write at +0, +300ms) ===');
		for (const e of events)
			console.log(`  +${e.t.toFixed(1).padStart(8)}ms  ${e.type.padEnd(6)} ${JSON.stringify(e.name)}`);
	},

	// (9b) back-to-back writes 10ms apart: how far the 50ms stream latency defers later events
	latencyburst: async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'fwf-')));
		const sent = new Map<string, number>();
		const lat: number[] = [];
		const w = watch(root, { recursive: true }, (_t, name) => {
			const s = sent.get(String(name));
			if (s !== undefined) {
				lat.push(now() - s);
				sent.delete(String(name));
			}
		});
		await sleep(300);
		for (let i = 0; i < 40; i++) {
			const n = `b${i}.txt`;
			sent.set(n, now());
			writeFileSync(join(root, n), 'x');
			await sleep(10);
		}
		await sleep(500);
		w.close();
		rmSync(root, { recursive: true, force: true });
		const s = [...lat].sort((a, b) => a - b);
		console.log('\n=== 9b. latency for 40 creates spaced 10ms apart (ms) ===');
		console.log(
			`  n=${s.length} min=${s[0]?.toFixed(1)} p50=${s[Math.floor(s.length / 2)]?.toFixed(1)} p95=${s[Math.floor(s.length * 0.95)]?.toFixed(1)} max=${s.at(-1)?.toFixed(1)}`,
		);
	},

	// (5) directory rename
	dirrename: () =>
		withWatcher('5. rename a directory containing 3 files', async (root) => {
			mkdirSync(join(root, 'old'));
			for (const n of ['1.md', '2.md', '3.md']) writeFileSync(join(root, 'old', n), n);
			await sleep(300);
			note('setup at +0; rename at +300ms');
			renameSync(join(root, 'old'), join(root, 'new'));
		}),

	// (6) recursive delete
	rmrf: () =>
		withWatcher('6. recursive delete of a directory with 3 files', async (root) => {
			mkdirSync(join(root, 'gone'));
			for (const n of ['1.md', '2.md', '3.md']) writeFileSync(join(root, 'gone', n), n);
			await sleep(300);
			note('setup at +0; delete at +300ms');
			rmSync(join(root, 'gone'), { recursive: true });
		}),

	// (7) 10,000 small files in one dir
	burst: async () => {
		const N = 10_000;
		let writeMs = 0;
		const { events } = await withWatcher(
			`7. burst: ${N} small files in one dir`,
			(root) => {
				const s = now();
				for (let i = 0; i < N; i++) writeFileSync(join(root, `f${i}.txt`), 'x');
				writeMs = now() - s;
			},
			{ settleMs: 3000, print: 10 },
		);
		const distinct = new Set(events.map((e) => e.name));
		const missing: number[] = [];
		for (let i = 0; i < N; i++) if (!distinct.has(`f${i}.txt`)) missing.push(i);
		const last = events.at(-1)?.t ?? 0;
		console.log(
			`  writes took ${writeMs.toFixed(0)}ms; events=${events.length}; distinct names=${distinct.size}; files never named=${missing.length}; last event +${last.toFixed(0)}ms`,
		);
		const expected = (n: unknown) => typeof n === 'string' && /^f\d+\.txt$/.test(n);
		console.log(`  never named: ${JSON.stringify(missing.slice(0, 20).map((i) => `f${i}.txt`))}`);
		console.log(
			`  unexpected names: ${JSON.stringify([...distinct].filter((n) => !expected(n)).slice(0, 20))}`,
		);
		console.log(
			`  'change' events: ${JSON.stringify(events.filter((e) => e.type === 'change').slice(0, 20).map((e) => [Math.round(e.t), e.name]))}`,
		);
	},

	// (8) file rename: old, new, or both
	rename: () =>
		withWatcher('8. rename a file (a.md -> b.md), then move into subdir', async (root) => {
			writeFileSync(join(root, 'a.md'), 'x');
			mkdirSync(join(root, 'sub'));
			await sleep(300);
			note('a.md -> b.md at +300ms; b.md -> sub/c.md at +600ms');
			renameSync(join(root, 'a.md'), join(root, 'b.md'));
			await sleep(300);
			renameSync(join(root, 'b.md'), join(root, 'sub/c.md'));
		}),

	// (9) latency from write return to event delivery
	latency: async () => {
		const lat: number[] = [];
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'fwf-')));
		const pending = new Map<string, number>();
		const w = watch(root, { recursive: true }, (_t, name) => {
			const s = pending.get(String(name));
			if (s !== undefined) {
				lat.push(now() - s);
				pending.delete(String(name));
			}
		});
		await sleep(300);
		for (let i = 0; i < 30; i++) {
			const n = `l${i}.txt`;
			pending.set(n, now());
			writeFileSync(join(root, n), 'x');
			await sleep(150);
		}
		// modify-only latency on an existing file
		const modLat: number[] = [];
		writeFileSync(join(root, 'm.txt'), 'x');
		await sleep(300);
		let mark = 0;
		const w2 = watch(root, { recursive: true }, (_t, name) => {
			if (name === 'm.txt' && mark) {
				modLat.push(now() - mark);
				mark = 0;
			}
		});
		await sleep(300);
		for (let i = 0; i < 20; i++) {
			mark = now();
			writeFileSync(join(root, 'm.txt'), `x${i}`);
			await sleep(150);
		}
		await sleep(300);
		w.close();
		w2.close();
		rmSync(root, { recursive: true, force: true });
		const stats = (a: number[]) => {
			const s = [...a].sort((x, y) => x - y);
			const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
			return `n=${s.length} min=${s[0]?.toFixed(1)} p50=${q(0.5)?.toFixed(1)} p95=${q(0.95)?.toFixed(1)} max=${s.at(-1)?.toFixed(1)}`;
		};
		console.log('\n=== 9. latency write-return -> first event (ms) ===');
		console.log(`  create: ${stats(lat)}`);
		console.log(`  modify: ${stats(modLat)}`);
	},

	// Overflow attempt: 10k files across 100 subdirs while loop is blocked for 2s.
	overflow: async () => {
		const N = 10_000;
		const { events } = await withWatcher(
			`overflow: ${N} files across 100 subdirs, event loop blocked 2s after writing`,
			(root) => {
				for (let d = 0; d < 100; d++) mkdirSync(join(root, `d${d}`));
				for (let i = 0; i < N; i++) writeFileSync(join(root, `d${i % 100}`, `f${i}.txt`), 'x');
				blockLoop(2000);
			},
			{ settleMs: 4000, print: 5 },
		);
		const names = new Set(events.map((e) => e.name));
		let missing = 0;
		for (let i = 0; i < N; i++) if (!names.has(`d${i % 100}/f${i}.txt`)) missing++;
		const dirOnly = events.filter((e) => e.name && /^d\d+$/.test(e.name)).length;
		console.log(
			`  distinct names=${names.size}; files never named=${missing}; events naming a bare dir=${dirOnly}`,
		);
	},

	// Larger: 50k across 500 dirs, loop blocked 5s, renames and links mixed in.
	overflowbig: async () => {
		const N = 50_000;
		const { events } = await withWatcher(
			`overflowbig: ${N} files across 500 subdirs, loop blocked 5s`,
			(root) => {
				for (let d = 0; d < 500; d++) mkdirSync(join(root, `d${d}`));
				for (let i = 0; i < N; i++) {
					const p = join(root, `d${i % 500}`, `f${i}.txt`);
					writeFileSync(p, 'x');
					if (i % 10 === 0) linkSync(p, `${p}.lnk`);
				}
				blockLoop(5000);
			},
			{ settleMs: 8000, print: 5 },
		);
		const names = new Set(events.map((e) => e.name));
		let missing = 0;
		for (let i = 0; i < N; i++) if (!names.has(`d${i % 500}/f${i}.txt`)) missing++;
		const dirOnly = events.filter((e) => e.name && /^d\d+\/?$/.test(e.name)).length;
		console.log(
			`  distinct names=${names.size}; files never named=${missing}; events naming a bare dir=${dirOnly}`,
		);
	},
};

const wanted = process.argv.slice(2);
console.log(`bun ${Bun.version} ${process.platform} ${process.arch} ${require('node:os').release()}`);
for (const [name, run] of Object.entries(scenarios)) {
	if (wanted.length && !wanted.includes(name)) continue;
	await run();
}
