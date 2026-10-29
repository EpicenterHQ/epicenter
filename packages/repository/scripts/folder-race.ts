/**
 * Races an "engine" projecting text into one file against an "editor" saving
 * the same file in a tight loop, on the real file system, and counts how many
 * editor saves each write primitive destroys.
 *
 * Usage:
 *   bun packages/repository/scripts/folder-race.ts                    # all three, 60 s each
 *   bun packages/repository/scripts/folder-race.ts --seconds 5        # quick smoke
 *   bun packages/repository/scripts/folder-race.ts --only naive,swap  # some of: naive, capture, swap
 *
 * Candidates (the engine's write primitive):
 *   naive    read + hash the file, compare with what the engine last wrote,
 *            then write a temp file (fsync) and rename it over the target.
 *   capture  candidate (a): `createBunFolderFs(root).replace(path, blob, { scratch })`
 *            (rename the target to `.epicenter/tmp/<scratch>`, then `link(temp, target)`,
 *            EEXIST-safe); the displaced scratch file is compared with what the
 *            engine last wrote, kept 150 ms, and read again (a write through an
 *            open descriptor lands there) before it is dropped.
 *   swap     candidate (b): write a temp file (fsync), then
 *            `renamex_np(temp, target, RENAME_SWAP)` through bun:ffi; the old
 *            bytes are now at the temp path and are compared, kept 150 ms, and
 *            read again, as for capture. When the target does not exist it falls
 *            back to `link(temp, target)`.
 *
 * Processes: the engine runs on the main thread (async, as the real engine
 * does; capture uses the adapter's promise-based `node:fs` calls). The editor
 * runs in a Bun Worker (a separate OS thread with its own event loop) using
 * synchronous `node:fs` calls, so it races the engine for real. They share
 * only a SharedArrayBuffer: per editor save k, bits the engine sets when it
 * observed k (read it before writing) or captured it (found it in what its
 * primitive displaced, or in the 150 ms recheck).
 *
 * Editor: alternates in-place saves (open 'r+', read what the inode holds,
 * truncate, write) and atomic saves (write `.note.md.tmp`, then put it over
 * the target), each with a unique token, with a random 0-3 ms pause between
 * saves. The atomic save uses `renamex_np(RENAME_SWAP)` instead of a plain
 * rename so the editor learns, atomically, what it replaced; the path goes
 * from old file to new file in one step either way, so the engine sees the
 * same thing a rename-over would give it. When the swap or the 'r+' open finds
 * no file (an "absent instant"), the editor counts it and does what a typical
 * editor does: an atomic save renames over anyway (creating the file); an
 * in-place save retries with open 'w' (create + truncate).
 *
 * How "destroyed" is decided: before save k+1 the editor learns exactly what
 * it is about to overwrite (the bytes in the inode it truncates, or the file
 * its swap took off the path). If that is save k, k was superseded by the
 * editor itself. If it is engine text, or the path was absent, the engine
 * replaced k; k is destroyed if, when the run ends, the engine neither
 * observed nor captured it. "Detached" saves are in-place saves whose
 * descriptor's inode was no longer at the path right after the write (the
 * bytes went into a file the engine had already moved away); they are a
 * subset of what can end up destroyed. The last save is classified against
 * the file left at the end.
 *
 * Output: one block per candidate, then a table. Read "destroyed" as the
 * number that matters; "captured" are saves the engine holds and would
 * ingest; "superseded" are saves the editor overwrote itself.
 */
import { dlopen, FFIType, read as readPointer } from 'bun:ffi';
import { closeSync, fstatSync, ftruncateSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { link, open, readFile, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { createBunFolderFs } from '../src/bun/folder-fs.js';
import { SCRATCH } from '../src/folder/fs.js';

// From the macOS SDK, usr/include/sys/stdio.h: `#define RENAME_SWAP 0x00000002`,
// `int renamex_np(const char *, const char *, unsigned int)` (10.12+).
const RENAME_SWAP = 0x2;
const ENOENT = 2;
const MAX_SAVES = 4_000_000;
const OBSERVED = 1;
const CAPTURED = 2;
const RECHECKED = 4;
const NAME = 'note.md';

type Candidate = 'naive' | 'capture' | 'swap';

function loadSwap() {
	const lib = dlopen('/usr/lib/libSystem.B.dylib', {
		renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		__error: { args: [], returns: FFIType.ptr },
	});
	const cstr = (path: string) => Buffer.from(`${path}\0`);
	/** 0 on success, else errno. */
	return (from: string, to: string) => {
		const result = lib.symbols.renamex_np(cstr(from), cstr(to), RENAME_SWAP);
		if (result === 0) return 0;
		const where = lib.symbols.__error();
		return where === null ? -1 : readPointer.i32(where, 0);
	};
}

const pad = 'x'.repeat(200);
const editorText = (k: number) => `editor ${k} ${pad}\n`;
const engineText = (n: number) => `engine ${n} ${pad}\n`;
const editorToken = (text: string | null) => {
	const match = text === null ? null : /^editor (\d+) /.exec(text);
	return match === null ? null : Number(match[1]);
};
const code = (cause: unknown) => (typeof cause === 'object' && cause !== null && 'code' in cause ? (cause as { code: unknown }).code : undefined);
const sleepSync = (lock: Int32Array, ms: number) => Atomics.wait(lock, 0, 0, ms);

// ============================================================================
// Editor (Worker)
// ============================================================================

type EditorReport = {
	saves: number;
	inPlace: number;
	atomic: number;
	superseded: number;
	replaced: number;
	absentReplaced: number;
	other: number;
	destroyed: number;
	destroyedDetached: number;
	detached: number;
	absentInPlace: number;
	absentAtomic: number;
	inPlaceRetryFailed: number;
	swapErrors: Record<string, number>;
	errors: Record<string, number>;
	lostIds: number[];
};

function editor({ dir, flags, stop }: { dir: string; flags: Uint8Array; stop: Int32Array }) {
	const swap = loadSwap();
	const path = join(dir, NAME);
	const tmp = join(dir, `.${NAME}.tmp`);
	const lock = new Int32Array(new SharedArrayBuffer(4));
	const buffer = Buffer.alloc(8192);
	const report: EditorReport = {
		saves: 0, inPlace: 0, atomic: 0, superseded: 0, replaced: 0, absentReplaced: 0, other: 0,
		destroyed: 0, destroyedDetached: 0, detached: 0, absentInPlace: 0, absentAtomic: 0, inPlaceRetryFailed: 0,
		swapErrors: {}, errors: {}, lostIds: [],
	};
	const bump = (record: Record<string, number>, key: string) => (record[key] = (record[key] ?? 0) + 1);
	/** Saves the engine replaced (engine text, or absent, where save k was): judged at the end. */
	const replacedSaves: number[] = [];
	const detachedSaves = new Set<number>();

	/** What was at the path just before this save, given the previous completed save. */
	const classify = (previous: number, before: string | null) => {
		if (previous === 0) return;
		if (before === null) {
			report.absentReplaced++;
			replacedSaves.push(previous);
			return;
		}
		const token = editorToken(before);
		if (token === previous) report.superseded++;
		else if (before.startsWith('engine ')) {
			report.replaced++;
			replacedSaves.push(previous);
		} else report.other++;
	};

	let previous = 0;
	for (let k = 1; Atomics.load(stop, 0) === 0 && k < MAX_SAVES; k++) {
		const bytes = Buffer.from(editorText(k));
		try {
			if (k % 2 === 1) {
				report.inPlace++;
				let fd: number;
				let before: string | null;
				try {
					fd = openSync(path, 'r+');
					const length = readSync(fd, buffer, 0, buffer.length, 0);
					before = buffer.toString('utf8', 0, length);
				} catch (cause) {
					if (code(cause) !== 'ENOENT') throw cause;
					report.absentInPlace++;
					before = null;
					try {
						fd = openSync(path, 'w');
					} catch (retry) {
						report.inPlaceRetryFailed++;
						bump(report.errors, `in-place retry ${String(code(retry))}`);
						continue;
					}
				}
				classify(previous, before);
				ftruncateSync(fd, 0);
				writeSync(fd, bytes, 0, bytes.length, 0);
				const mine = fstatSync(fd).ino;
				let atPath: number | null = null;
				try {
					atPath = lstatSync(path).ino;
				} catch {}
				closeSync(fd);
				if (atPath !== mine) {
					report.detached++;
					detachedSaves.add(k);
				}
			} else {
				report.atomic++;
				writeFileSync(tmp, bytes);
				const errno = swap(tmp, path);
				if (errno === 0) {
					const before = readFileSync(tmp, 'utf8');
					unlinkSync(tmp);
					classify(previous, before);
				} else {
					if (errno === ENOENT) report.absentAtomic++;
					else bump(report.swapErrors, `errno ${errno}`);
					renameSync(tmp, path);
					classify(previous, errno === ENOENT ? null : '?');
				}
			}
			report.saves++;
			previous = k;
		} catch (cause) {
			bump(report.errors, String(code(cause) ?? cause));
		}
		sleepSync(lock, Math.random() * 3);
	}
	// The engine has stopped (and finished its rechecks): the file left is what replaced the last save.
	let last: string | null = null;
	try {
		last = readFileSync(path, 'utf8');
	} catch {}
	classify(previous, last);

	for (const k of replacedSaves) {
		if (Atomics.load(flags, k) !== 0) continue;
		report.destroyed++;
		if (detachedSaves.has(k)) report.destroyedDetached++;
		if (report.lostIds.length < 10) report.lostIds.push(k);
	}
	return report;
}

// ============================================================================
// Engine (main thread)
// ============================================================================

type EngineReport = {
	ticks: number;
	writes: number;
	ingests: number;
	observed: number;
	captured: number;
	capturedOther: number;
	recheckCaptured: number;
	linkEexist: number;
	swapCalls: number;
	swapFallbackLink: number;
	swapErrors: Record<string, number>;
	errors: Record<string, number>;
};

async function engine(candidate: Candidate, dir: string, flags: Uint8Array, seconds: number) {
	const path = join(dir, NAME);
	const port = createBunFolderFs(dir);
	const swap = candidate === 'swap' ? loadSwap() : null;
	const report: EngineReport = {
		ticks: 0, writes: 0, ingests: 0, observed: 0, captured: 0, capturedOther: 0, recheckCaptured: 0,
		linkEexist: 0, swapCalls: 0, swapFallbackLink: 0, swapErrors: {}, errors: {},
	};
	const bump = (record: Record<string, number>, key: string) => (record[key] = (record[key] ?? 0) + 1);
	const rechecks: Promise<void>[] = [];
	let n = 0;
	let temp = 0;
	let record = engineText(n);
	await Bun.write(path, record);

	/** The engine holds `text` as a save it did not write. */
	const hold = (text: string, bit: number) => {
		const k = editorToken(text);
		if (k === null) {
			if (bit !== OBSERVED) report.capturedOther++;
			return;
		}
		if (bit === OBSERVED) report.observed++;
		else if (bit === CAPTURED) report.captured++;
		else report.recheckCaptured++;
		Atomics.or(flags, k, bit);
	};
	/** Look at what the primitive displaced: compare now, then once more after 150 ms. */
	const inspect = (first: string, expected: string, readAgain: () => Promise<string | null>, release: () => Promise<void>) => {
		if (Bun.hash(first) !== Bun.hash(expected)) hold(first, CAPTURED);
		rechecks.push(
			(async () => {
				await Bun.sleep(150);
				const again = await readAgain();
				if (again !== null && again !== first && again !== expected) hold(again, RECHECKED);
				await release();
			})(),
		);
	};
	async function stage(text: string) {
		const file = join(dir, `.engine-${++temp}`);
		const handle = await open(file, 'wx');
		try {
			await handle.write(text, 0);
			await handle.sync();
		} finally {
			await handle.close();
		}
		return file;
	}

	const deadline = performance.now() + seconds * 1000;
	while (performance.now() < deadline) {
		await Bun.sleep(1 + Math.random() * 4);
		report.ticks++;
		try {
			let now: string | null;
			if (candidate === 'capture') {
				const blob = await port.read(NAME);
				now = blob === null ? null : await blob.text().catch(() => null);
			} else now = await readFile(path, 'utf8').catch(() => null);
			if (now === null) continue;
			if (Bun.hash(now) !== Bun.hash(record)) {
				// Not what the engine last wrote: a save, ingested without writing.
				report.ingests++;
				hold(now, OBSERVED);
				record = now;
				continue;
			}
			const next = engineText(++n);
			const expected = record;
			if (candidate === 'naive') {
				const file = await stage(next);
				await rename(file, path);
				report.writes++;
				record = next;
			} else if (candidate === 'capture') {
				const scratch = `s-${n}`;
				const result = await port.replace(NAME, new Blob([next]), { scratch });
				if (result.error) {
					bump(report.errors, String(result.error.message).slice(0, 80));
					continue;
				}
				const { written, displaced } = result.data;
				if (written) {
					report.writes++;
					record = next;
				} else report.linkEexist++;
				if (displaced !== null) {
					const first = (await (await port.readScratch(displaced))?.bytes.text()) ?? '';
					inspect(first, expected, async () => (await (await port.readScratch(displaced))?.bytes.text()) ?? null, () => port.drop(displaced));
				}
			} else if (swap !== null) {
				const file = await stage(next);
				report.swapCalls++;
				const errno = swap(file, path);
				if (errno === 0) {
					report.writes++;
					record = next;
					const first = await readFile(file, 'utf8');
					inspect(first, expected, () => readFile(file, 'utf8').catch(() => null), () => unlink(file).catch(() => {}));
				} else {
					bump(report.swapErrors, `errno ${errno}`);
					if (errno === ENOENT) {
						report.swapFallbackLink++;
						try {
							await link(file, path);
							report.writes++;
							record = next;
						} catch (cause) {
							if (code(cause) === 'EEXIST') report.linkEexist++;
							else throw cause;
						}
					}
					await unlink(file).catch(() => {});
				}
			}
		} catch (cause) {
			bump(report.errors, String(code(cause) ?? cause));
		}
	}
	await Promise.all(rechecks);
	return report;
}

// ============================================================================
// Driver
// ============================================================================

async function run(candidate: Candidate, seconds: number) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `folder-race-${candidate}-`)));
	const flags = new Uint8Array(new SharedArrayBuffer(MAX_SAVES));
	const stop = new Int32Array(new SharedArrayBuffer(4));
	try {
		const worker = new Worker(new URL(import.meta.url), { workerData: { dir, flags, stop } });
		const done = new Promise<EditorReport>((resolve, reject) => {
			worker.on('message', resolve);
			worker.on('error', reject);
		});
		const engineReport = await engine(candidate, dir, flags, seconds);
		Atomics.store(stop, 0, 1);
		const editorReport = await done;
		await worker.terminate();
		const leftover = (() => {
			try {
				return readFileSync(join(dir, NAME), 'utf8').slice(0, 20);
			} catch {
				return '(absent)';
			}
		})();
		return { candidate, engine: engineReport, editor: editorReport, leftover, scratchDir: join(dir, SCRATCH) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function main() {
	const args = process.argv.slice(2);
	const secondsAt = args.indexOf('--seconds');
	const seconds = secondsAt === -1 ? 60 : Number(args[secondsAt + 1]);
	const onlyAt = args.indexOf('--only');
	const candidates = (onlyAt === -1 ? ['naive', 'capture', 'swap'] : (args[onlyAt + 1] ?? '').split(',')) as Candidate[];
	console.log(`folder-race: ${seconds} s per candidate, bun ${Bun.version}, ${process.platform} ${process.arch}, tmpdir ${tmpdir()}`);
	console.log('engine: main thread (async); editor: Bun Worker thread (sync node:fs)\n');
	return (async () => {
		const results: Awaited<ReturnType<typeof run>>[] = [];
		for (const candidate of candidates) {
			const result = await run(candidate, seconds);
			results.push(result);
			console.log(`== ${candidate}`);
			console.log('engine', JSON.stringify(result.engine));
			console.log('editor', JSON.stringify(result.editor));
			console.log(`file left: ${JSON.stringify(result.leftover)}\n`);
		}
		const rows: [string, (r: (typeof results)[number]) => string | number][] = [
			['editor saves (in-place/atomic)', (r) => `${r.editor.saves} (${r.editor.inPlace}/${r.editor.atomic})`],
			['engine writes', (r) => r.engine.writes],
			['saves observed (read before writing)', (r) => r.engine.observed],
			['saves captured (displaced != expected)', (r) => r.engine.captured],
			['saves captured by 150 ms recheck', (r) => r.engine.recheckCaptured],
			['superseded by the editor itself', (r) => r.editor.superseded],
			['replaced by engine (engine text found)', (r) => r.editor.replaced],
			['replaced by engine (path absent)', (r) => r.editor.absentReplaced],
			['DESTROYED', (r) => r.editor.destroyed],
			['  of which detached (fd write after move)', (r) => r.editor.destroyedDetached],
			['detached in-place writes (all)', (r) => r.editor.detached],
			['absent instants: in-place open r+ ENOENT', (r) => r.editor.absentInPlace],
			['absent instants: atomic swap ENOENT', (r) => r.editor.absentAtomic],
			['in-place retry (open w) failures', (r) => r.editor.inPlaceRetryFailed],
			['editor errors', (r) => JSON.stringify(r.editor.errors)],
			['editor swap errors (non-ENOENT)', (r) => JSON.stringify(r.editor.swapErrors)],
			['engine link EEXIST (editor won)', (r) => r.engine.linkEexist],
			['engine swap calls / errors', (r) => `${r.engine.swapCalls} / ${JSON.stringify(r.engine.swapErrors)}`],
			['engine errors', (r) => JSON.stringify(r.engine.errors)],
			['unclassified prior content', (r) => r.editor.other],
		];
		const width = Math.max(...rows.map(([label]) => label.length));
		console.log(`${''.padEnd(width)} | ${results.map((r) => r.candidate.padEnd(16)).join(' | ')}`);
		for (const [label, cell] of rows) console.log(`${label.padEnd(width)} | ${results.map((r) => String(cell(r)).padEnd(16)).join(' | ')}`);
	})();
}

if (isMainThread) await main();
else parentPort?.postMessage(editor(workerData as { dir: string; flags: Uint8Array; stop: Int32Array }));
