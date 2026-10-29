/**
 * Measure the folder engine on a generated folder, in a temporary
 * directory deleted afterwards:
 *
 *   bun scripts/bench-folder.ts [--notes 10000] [--blobs 200] [--commit 1000]
 *
 * Prints, as JSON: a cold startup scan (no records: every file hashed and
 * saved to the replica), a warm one (records match), the peak RSS, the
 * database's size with the record's texts, and `commit` over `--commit`
 * changed notes against a repository served in this process (the time to
 * the group, and whether it landed in one commit or was held intact as
 * oversized). Refuses to run with less than 4 GB free.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openFolderEngine } from '../src/bun/folder.js';
import { serveRepository } from '../src/bun/serve.js';
import { createTestServer } from '../src/sim/harness.js';
import { authenticateBearer } from '../src/wire/wire.js';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { notes: { type: 'string', default: '10000' }, blobs: { type: 'string', default: '200' }, commit: { type: 'string', default: '1000' } } });
const NOTES = Number(values.notes);
const BLOBS = Number(values.blobs);
const CHANGED = Number(values.commit);
const free = statfsSync(tmpdir());
if (free.bavail * free.bsize < 4 * 1024 ** 3) throw new Error('Less than 4 GB free: not running');

const root = mkdtempSync(join(tmpdir(), 'bench-folder-'));
let peak = 0;
const sample = setInterval(() => {
	peak = Math.max(peak, process.memoryUsage.rss());
}, 20);
const time = async <T>(run: () => Promise<T>) => {
	const start = performance.now();
	const value = await run();
	return { ms: Math.round(performance.now() - start), value };
};
const body = (i: number) => `---\ntitle: Note ${i}\ntags: [bench]\n---\n${`Line ${i} of a note that reads like one.\n`.repeat(8)}`;
try {
	const dir = join(root, 'folder');
	for (let i = 0; i < NOTES; i++) {
		const sub = join(dir, `d${i % 100}`);
		if (i < 100) mkdirSync(sub, { recursive: true });
		writeFileSync(join(sub, `n${i}.md`), body(i));
	}
	mkdirSync(join(dir, 'media'), { recursive: true });
	for (let i = 0; i < BLOBS; i++) writeFileSync(join(dir, 'media', `b${i}.png`), new Uint8Array(4096).fill(i % 251));
	const dataDir = join(root, 'data');
	// Files older than the racy window, as a folder's files are: a file modified within 2 s of its record is hashed again.
	await Bun.sleep(2_500);

	// Cold: no records, kept only here (no server), so the cost is the engine's and the replica's.
	const opened = await openFolderEngine({ dir, dataDir });
	if (opened.error !== null) throw new Error(opened.error.message);
	const cold = await time(() => opened.data.engine.start({ watch: false }));
	const coldPeak = peak;
	await Bun.sleep(2_500);
	const warm = await time(() => opened.data.engine.scan());
	await opened.data.engine.stop();
	opened.data.close();
	const database = statSync(join(dataDir, 'replicas', opened.data.identity.replica, 'replica.sqlite')).size;
	const again = await openFolderEngine({ dir, dataDir });
	if (again.error !== null) throw new Error(again.error.message);
	const warmAfterRestart = await time(() => again.data.engine.scan());
	await again.data.engine.stop();
	again.data.close();

	// Commit over CHANGED notes, against a served repository.
	const server = createTestServer({ clock: () => Date.now() });
	const served = serveRepository({ repository: 'bench', serverId: 'local', server, authenticate: authenticateBearer((token) => ({ user: token, role: 'owner' })), port: 0 });
	const small = join(root, 'committing');
	mkdirSync(small, { recursive: true });
	const joined = await openFolderEngine({ dir: small, dataDir, join: { repository: 'me/bench', server: served.url }, token: 'ada', agent: 'bench' });
	if (joined.error !== null) throw new Error(joined.error.message);
	await joined.data.engine.start({ watch: false });
	for (let i = 0; i < CHANGED; i++) writeFileSync(join(small, `c${i}.md`), body(i));
	const group = await time(() => joined.data.engine.commit(`Bench ${CHANGED}`));
	const link = joined.data.connect();
	const sent = await time(async () => {
		for (let i = 0; i < 600; i++) {
			if (!joined.data.replica.busy() || joined.data.replica.held().length > 0) break;
			await Bun.sleep(50);
		}
	});
	const held = joined.data.replica.held();
	const landed = server.read('c0.md') !== null;
	link?.close();
	await joined.data.engine.stop();
	joined.data.close();
	await served.stop();
	clearInterval(sample);
	console.log(
		JSON.stringify(
			{
				notes: NOTES,
				blobs: BLOBS,
				coldScanMs: cold.ms,
				warmScanMs: warm.ms,
				warmScanAfterRestartMs: warmAfterRestart.ms,
				peakRssMB: Math.round(Math.max(peak, coldPeak) / 1024 ** 2),
				databaseMB: Math.round((database / 1024 ** 2) * 10) / 10,
				commit: { files: CHANGED, toGroupMs: group.ms, saved: group.value.length, answerMs: sent.ms, landed, held: held.slice(0, 2), heldCount: held.length },
			},
			null,
			'\t',
		),
	);
} finally {
	clearInterval(sample);
	rmSync(root, { recursive: true, force: true });
}
