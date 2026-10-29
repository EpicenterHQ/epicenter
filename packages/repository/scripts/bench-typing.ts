/**
 * Typing Benchmark: how many writes a second a replica of many notes takes
 * from one editor, when every keystroke is its own write.
 *
 * Builds (once, cached under the system's temporary directory) a replica
 * database of N synced notes, written straight into the replica's tables,
 * opens it in Bun with an in-process host (the replica and its page server
 * in this process, as a browser's worker would run them), opens one note's
 * editor, and types K keystrokes into it as fast as the editor takes them,
 * then once more at 10 ms apart. It reports, for the notes kept in page
 * memory and for `memory: false`:
 *
 * - burst: writes a second with every keystroke posted back to back, until
 *   the last is stored and the editor is saved
 * - paced: how long each keystroke takes to be stored (p50, p99, max), with
 *   one every 10 ms (a person typing fast); under 10 ms means the worker
 *   keeps up
 *
 * Run: bun scripts/bench-typing.ts [notes=100000] [keystrokes=200]
 */
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { openBunSqlite } from '../src/bun/sqlite.js';
import { openReplica } from '../src/client/replica.js';
import { fold } from '../src/core/door.js';
import { gitBlobHash } from '../src/core/hash.js';
import { defineApp } from '../src/core/lens.js';
import { openLocalRepository } from '../src/api/local.js';

const count = Number(process.argv[2] ?? 100_000);
const keystrokes = Number(process.argv[3] ?? 200);
const schema = Type.Object({ title: Type.String() });
const apps = {
	memory: defineApp({ notes: { path: 'notes/{stem}.md', schema } }),
	'memory: false': defineApp({ notes: { path: 'notes/{stem}.md', schema, memory: false } }),
};
const binding = { repository: 'bench', server: null, account: null };
const note = (i: number) => `---\ntitle: Note ${i}\n---\n${Array.from({ length: 60 }, (_, w) => `word${(i * 31 + w * 7) % 997}`).join(' ')}\n`;

function build(filename: string) {
	const opened = openReplica({ driver: openBunSqlite(filename), binding, device: 'bench', app: apps.memory, after: () => {}, now: () => 0 });
	if (opened.error !== null) throw new Error(opened.error.message);
	opened.data.close();
	const driver = openBunSqlite(filename);
	driver.transaction(() => {
		for (let i = 0; i < count; i++) {
			const path = `notes/n${String(i).padStart(6, '0')}.md`;
			const text = note(i);
			driver.run('INSERT INTO "epicenter/files" (path, fold, text, fields, base, hash) VALUES (?, ?, ?, ?, ?, ?)', [path, fold(path), text, JSON.stringify({ title: `Note ${i}` }), text, gitBlobHash(text)]);
		}
		driver.run(`INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES ('position', 'p1')`);
	});
	driver.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	driver.close();
}

const until = async (check: () => boolean) => {
	while (!check()) await new Promise((resolve) => setTimeout(resolve, 1));
};

async function run(label: keyof typeof apps, filename: string) {
	const app = apps[label];
	const replica = openReplica({ driver: openBunSqlite(filename), binding, device: 'bench', app, after: (ms, go) => void setTimeout(go, ms), now: () => Date.now() });
	if (replica.error !== null) throw new Error(replica.error.message);
	const repo = openLocalRepository({ app, replica: replica.data });
	await until(() => repo.status().status === 'open');
	const opened = await repo.notes.openEditor({ stem: 'n000042' });
	if (opened.error !== null) throw new Error(opened.error.message);
	const editor = opened.data;

	let draft = editor.draft();
	const started = performance.now();
	for (let k = 0; k < keystrokes; k++) editor.update((draft += 'x'));
	await until(() => editor.state().status === 'saved' && replica.data.read('notes/n000042.md') === draft);
	const burst = (keystrokes / (performance.now() - started)) * 1000;

	// Paced: one keystroke every 10 ms, timing each one's answer through the stored text.
	const times: number[] = [];
	for (let k = 0; k < keystrokes; k++) {
		const typedAt = performance.now();
		editor.update((draft += 'y'));
		const expected = draft;
		await until(() => replica.data.read('notes/n000042.md') === expected);
		times.push(performance.now() - typedAt);
		const waited = performance.now() - typedAt;
		if (waited < 10) await new Promise((resolve) => setTimeout(resolve, 10 - waited));
	}
	await editor.close();
	repo.close();
	times.sort((a, b) => a - b);
	const at = (q: number) => (times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0).toFixed(1);
	console.log(`${label}: ${count} notes, ${keystrokes} keystrokes: burst ${burst.toFixed(0)} writes/s; paced at 10 ms, each stored in p50 ${at(0.5)} ms, p99 ${at(0.99)} ms, max ${at(1)} ms`);
}

const dir = join(tmpdir(), 'epicenter-bench-typing');
mkdirSync(dir, { recursive: true });
const filename = join(dir, `replica-${count}.sqlite`);
if (!existsSync(filename)) build(filename);
for (const label of Object.keys(apps) as (keyof typeof apps)[]) await run(label, filename);
