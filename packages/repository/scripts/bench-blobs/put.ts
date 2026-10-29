/**
 * Browser PUT bench (phase 8, step 6): a dedicated worker PUTs a File
 * sealed in OPFS to the Bun server's LFS route through `LfsClient`, in
 * Chromium and WebKit; reports the PUT's time and the browser's peak
 * resident memory above its level after the seal. Memory bounded means the
 * browser streams the File; a peak near its size means it buffered it.
 * Chromium is measured as its process tree; WebKit's web content runs in
 * launchd's XPC processes, so it is the sum over every WebKit process on
 * the machine (others' drift is noise). The server verifies the bytes and
 * keeps none, read slowly so backpressure must hold the browser back, and
 * each profile is removed after.
 *
 *   bun scripts/bench-blobs/put.ts [MiB]   (default 256: the seal writes the bytes to disk)
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { Ok } from 'wellcrafted/result';
import { serveRepository } from '../../src/bun/serve.js';
import { openBunSqlite } from '../../src/bun/sqlite.js';
import { LfsStoreError, type LfsStore } from '../../src/server/lfs-store.js';
import { createMemoryGitStore } from '../../src/server/memory-git.js';
import { createServer } from '../../src/server/server.js';
import { authenticateBearer } from '../../src/wire/wire.js';
import { matchingRss, peakAbove, profileRoot, treeRss } from './rss.js';

const MIB = 1024 * 1024;
const size = Number(process.argv[2] ?? 256) * MIB;

/** Verify the bytes, keep none, and read them at 50 MiB/s, so the upload lasts seconds and a browser that buffered the File would show it. */
const discard: LfsStore = {
	has: async () => false,
	get: async () => null,
	async put(oid, length, body) {
		const digest = createHash('sha256');
		const started = performance.now();
		let count = 0;
		const reader = body.getReader();
		for (let read = await reader.read(); !read.done; read = await reader.read()) {
			const chunk = read.value;
			count += chunk.byteLength;
			digest.update(chunk);
			const due = (count / (50 * MIB)) * 1000 - (performance.now() - started);
			if (due > 0) await Bun.sleep(due);
		}
		return count === length && digest.digest('hex') === oid
			? Ok('stored')
			: LfsStoreError.Mismatch();
	},
};

const build = await Bun.build({
	entrypoints: [join(import.meta.dir, 'put.worker.ts')],
	target: 'browser',
	format: 'esm',
});
if (!build.success)
	throw new AggregateError(build.logs, 'The bench build failed');
const worker = await build.outputs[0]?.text();
const site = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch: ({ url }) =>
		new URL(url).pathname === '/worker.js'
			? new Response(worker, { headers: { 'content-type': 'text/javascript' } })
			: new Response('<!doctype html><title>bench</title>', {
					headers: { 'content-type': 'text/html' },
				}),
});
const origin = site.url.origin;
const server = createServer({
	store: openBunSqlite(),
	git: createMemoryGitStore(),
});
const served = serveRepository({
	repository: 'r',
	serverId: 's',
	server,
	lfs: discard,
	origins: [origin],
	authenticate: authenticateBearer((token) =>
		token === 'alice' ? { user: 'alice', role: 'writer' } : null,
	),
});

const rows: string[] = [];
for (const [name, type] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	const profile = await mkdtemp(join(tmpdir(), 'bench-put-'));
	const context = await type.launchPersistentContext(profile, {
		headless: true,
	});
	const root = await profileRoot(profile);
	const rss =
		name === 'chromium'
			? () => treeRss(root)
			: () => matchingRss(/com\.apple\.WebKit\.|Playwright\.app/);
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await page.goto(site.url.href);
		await page.evaluate(() => {
			const w = new Worker('/worker.js', { type: 'module' });
			(
				globalThis as unknown as {
					step: (message: unknown) => Promise<unknown>;
				}
			).step = (message) =>
				new Promise((resolve) => {
					w.onerror = (event) =>
						resolve({ error: `worker error: ${event.message}` });
					w.onmessage = ({ data }) => resolve(data);
					w.postMessage(message);
				});
		});
		const step = (message: unknown) =>
			page.evaluate(
				(m) =>
					(
						globalThis as unknown as {
							step: (
								message: unknown,
							) => Promise<{ ok?: unknown; error?: string }>;
						}
					).step(m),
				message,
			);
		const sealedStep = await step({
			step: 'seal',
			size,
			salt: rows.length + 1,
		});
		if (sealedStep.error !== undefined)
			throw new Error(`${name} seal: ${sealedStep.error}`);
		await Bun.sleep(1_000);
		const idle = await rss();
		const { result, peak } = await peakAbove(rss, idle, () =>
			step({ step: 'put', url: served.url }),
		);
		if (result.error !== undefined)
			throw new Error(`${name} put: ${result.error}`);
		const { ms } = result.ok as { ms: number };
		rows.push(
			`${name}\tPUT ${size / MIB} MiB\t${Math.round(ms)} ms\t${((size / MIB / ms) * 1000).toFixed(0)} MiB/s\tpeak +${Math.round(peak / MIB)} MiB over ${Math.round(idle / MIB)} MiB`,
		);
		console.log(rows.at(-1));
		await step({ step: 'clean' });
	} finally {
		await context.close();
		await rm(profile, { recursive: true, force: true });
	}
}
await served.stop();
site.stop(true);
console.log(`\n${rows.join('\n')}`);
