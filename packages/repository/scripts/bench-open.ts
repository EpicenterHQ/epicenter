/**
 * Open Benchmark: how long a replica of many notes takes to open in Bun,
 * and how much JavaScript heap it keeps and peaks at.
 *
 * Builds (once, cached under the system's temporary directory) a replica
 * database of N synced notes, each a small Markdown note with frontmatter
 * and a body of a few hundred bytes, written straight into the replica's
 * tables. Then opens it in a fresh process, so nothing of the build is in
 * the heap, and reports:
 *
 * - open: milliseconds for `openReplica` (schema, views, start-up reads)
 * - heap after open: the heap (with the memory its strings hold outside
 *   it) once a full collection has run: what the open replica keeps
 * - peak heap: the largest heap sampled while opening and after it (every
 *   allocation the open made before a collection could free it)
 * - peak RSS: the process's maximum resident set
 *
 * Run: bun scripts/bench-open.ts [notes=100000]
 */
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heapStats } from 'bun:jsc';
import { openBunSqlite } from '../src/bun/sqlite.js';
import { openReplica } from '../src/client/replica.js';
import { gitBlobHash } from '../src/core/hash.js';
import { fold } from '../src/core/door.js';

const binding = { repository: 'bench', server: null, account: null };
const options = (filename: string) => ({
	driver: openBunSqlite(filename),
	binding,
	device: 'bench',
	app: { lenses: [{ name: 'notes', view: `CREATE TEMP VIEW "notes" AS SELECT path, json_extract(fields, '$."title"') AS "title", body FROM "epicenter/files" WHERE text IS NOT NULL AND path LIKE 'notes/%'` }] },
	after: () => {},
	now: () => 0,
});

function note(i: number) {
	const words = Array.from({ length: 60 }, (_, w) => `word${(i * 31 + w * 7) % 997}`).join(' ');
	return `---\ntitle: Note ${i}\ncreatedAt: 2026-01-01T00:00:00Z\ndone: ${i % 2 === 0}\n---\n${words}\n`;
}

function build(filename: string, count: number) {
	const opened = openReplica(options(filename));
	if (opened.error !== null) throw new Error(opened.error.message);
	opened.data.close();
	const driver = openBunSqlite(filename);
	const columns = new Set(driver.all<{ name: string }>(`PRAGMA table_info("epicenter/files")`).map((c) => c.name));
	const withFold = columns.has('fold');
	driver.transaction(() => {
		for (let i = 0; i < count; i++) {
			const path = `notes/n${String(i).padStart(6, '0')}.md`;
			const text = note(i);
			const fields = JSON.stringify({ title: `Note ${i}`, createdAt: '2026-01-01T00:00:00Z', done: i % 2 === 0 });
			if (withFold) driver.run('INSERT INTO "epicenter/files" (path, fold, text, fields, base, hash) VALUES (?, ?, ?, ?, ?, ?)', [path, fold(path), text, fields, text, gitBlobHash(text)]);
			else driver.run('INSERT INTO "epicenter/files" (path, text, fields, base, hash) VALUES (?, ?, ?, ?, ?)', [path, text, fields, text, gitBlobHash(text)]);
		}
		driver.run(`INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES ('position', 'p1')`);
	});
	driver.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	driver.close();
}

/** The JavaScript heap in use, with the memory its strings and buffers hold outside it. */
const used = () => {
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
};

function measure(filename: string) {
	Bun.gc(true);
	const before = used();
	let peak = before;
	const sample = () => {
		const size = used();
		if (size > peak) peak = size;
	};
	const sampler = setInterval(sample, 1);
	const started = performance.now();
	// Sample inside the open too: the driver's reads are where it allocates.
	const driver = openBunSqlite(filename);
	const sampled: typeof driver = {
		...driver,
		all: (sql, params) => {
			const rows = driver.all(sql, params);
			sample();
			return rows as never;
		},
	};
	const opened = openReplica({ ...options(filename), driver: sampled });
	const open = performance.now() - started;
	sample();
	clearInterval(sampler);
	if (opened.error !== null) throw new Error(opened.error.message);
	Bun.gc(true);
	const after = used();
	sample();
	// The replica must stay reachable through the collection above.
	const paths = opened.data.paths().length;
	opened.data.close();
	const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	console.log(
		JSON.stringify({
			notes: paths,
			openMs: Math.round(open),
			heapAfterOpen: mb(after - before),
			peakHeap: mb(peak - before),
			peakRss: mb(process.resourceUsage().maxRSS * 1024),
		}),
	);
}

const [mode, arg] = process.argv.slice(2);
if (mode === '--open' && arg !== undefined) measure(arg);
else {
	const count = Number(mode ?? 100_000);
	const directory = join(tmpdir(), 'epicenter-bench-open');
	mkdirSync(directory, { recursive: true });
	const filename = join(directory, `replica-${count}-${process.env.BENCH_SCHEMA ?? 'current'}.sqlite`);
	if (process.env.BENCH_REBUILD === '1' || !existsSync(filename)) {
		for (const suffix of ['', '-wal', '-shm']) rmSync(filename + suffix, { force: true });
		const started = performance.now();
		build(filename, count);
		console.log(`built ${count} notes in ${Math.round(performance.now() - started)} ms: ${filename}`);
	}
	for (let run = 0; run < 3; run++) {
		const child = Bun.spawnSync(['bun', import.meta.path, '--open', filename], { stdout: 'pipe', stderr: 'inherit' });
		process.stdout.write(child.stdout.toString());
	}
}
