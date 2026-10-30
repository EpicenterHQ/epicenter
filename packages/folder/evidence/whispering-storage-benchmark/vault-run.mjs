import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { chromium } from 'playwright';

const root = Bun.argv[2] ?? `${process.env.HOME}/Code/vault`;
const exclude = new Set([
	'.git',
	'node_modules',
	'.obsidian',
	'.trash',
	'.claude',
	'.codex',
	'.agents',
]);
const all = [];
async function walk(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory() && !exclude.has(entry.name)) await walk(path);
		else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
			all.push([relative(root, path), await readFile(path, 'utf8')]);
	}
}
await walk(root);
all.sort((a, b) => a[0].localeCompare(b[0]));
const corpora = {
	pages: all.filter(([path]) => path.startsWith('pages/')),
	all,
};
function checksum(rows) {
	let hash = 2166136261;
	for (const row of [...rows].sort((a, b) =>
		a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
	))
		for (const s of row) {
			for (let i = 0; i < s.length; i++)
				hash = Math.imul(hash ^ s.charCodeAt(i), 16777619) >>> 0;
			hash = Math.imul(hash ^ 65535, 16777619) >>> 0;
		}
	return hash;
}
const payloads = new Map(
	Object.entries(corpora).map(([name, rows]) => [name, JSON.stringify(rows)]),
);
const bundle = await Bun.build({
	entrypoints: [join(import.meta.dir, 'vault-client.mjs')],
	target: 'browser',
	minify: true,
});
if (!bundle.success) throw new Error(String(bundle.logs));
const script = await bundle.outputs[0].text();
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === '/client.js')
			return new Response(script, {
				headers: { 'content-type': 'text/javascript' },
			});
		if (path.startsWith('/corpus/')) {
			const payload = payloads.get(path.slice(8));
			return payload
				? new Response(payload, {
						headers: { 'content-type': 'application/json' },
					})
				: new Response('Not found', { status: 404 });
		}
		return new Response(
			'<!doctype html><title>Disposable vault benchmark</title><script type="module" src="/client.js"></script>',
			{ headers: { 'content-type': 'text/html' } },
		);
	},
});
const output = {
	recordedAt: new Date().toISOString(),
	source:
		'Read-only live vault snapshot, raw Markdown per nested shared text node; no metadata projection or UI',
	yjs: '14.0.0-rc.26',
	exclusions: [...exclude],
	corpora: [],
};
try {
	for (const [name, rows] of Object.entries(corpora)) {
		const profile = await mkdtemp('/tmp/PROTOTYPE-vault-yjs-profile-');
		const launch = () =>
			chromium.launchPersistentContext(profile, {
				headless: true,
				args: ['--enable-precise-memory-info'],
			});
		let context = await launch();
		try {
			output.chromium = context.browser()?.version();
			const seedPage = await context.newPage();
			await seedPage.goto(server.url.href);
			await seedPage.waitForFunction(() => globalThis.vaultBench !== undefined);
			const seed = await seedPage.evaluate(
				(name) => globalThis.vaultBench.seed(name),
				name,
			);
			const record = {
				name,
				files: rows.length,
				utf8Bytes: rows.reduce((n, [, text]) => n + Buffer.byteLength(text), 0),
				utf16Units: rows.reduce((n, [, text]) => n + text.length, 0),
				checksum: checksum(rows),
				seed,
				trials: [],
			};
			await context.close();
			for (let trial = 0; trial < 3; trial++) {
				context = await launch();
				const page = await context.newPage();
				await page.goto(server.url.href);
				await page.waitForFunction(() => globalThis.vaultBench !== undefined);
				const cdp = await context.newCDPSession(page);
				await cdp.send('HeapProfiler.collectGarbage');
				const baseline = await cdp.send('Runtime.getHeapUsage');
				const timing = await page.evaluate(
					(name) => globalThis.vaultBench.load(name),
					name,
				);
				const startupHeap = await cdp.send('Runtime.getHeapUsage');
				await cdp.send('HeapProfiler.collectGarbage');
				const steadyHeap = await cdp.send('Runtime.getHeapUsage');
				const validation = await page.evaluate(() =>
					globalThis.vaultBench.validate(),
				);
				if (
					validation.files !== record.files ||
					validation.utf16Units !== record.utf16Units ||
					validation.checksum !== record.checksum
				)
					throw new Error('Corpus verification failed');
				record.trials.push({
					trial,
					...timing,
					validation,
					baseline,
					startupHeap,
					steadyHeap,
					baselineHeapBytes: baseline.usedSize,
					startupHeapDeltaBytes: startupHeap.usedSize - baseline.usedSize,
					postGcHeapDeltaBytes: steadyHeap.usedSize - baseline.usedSize,
					startupBackingDeltaBytes:
						startupHeap.backingStorageSize - baseline.backingStorageSize,
					postGcBackingDeltaBytes:
						steadyHeap.backingStorageSize - baseline.backingStorageSize,
					postGcHeapAndBackingDeltaBytes:
						steadyHeap.usedSize +
						steadyHeap.backingStorageSize -
						baseline.usedSize -
						baseline.backingStorageSize,
				});
				if (trial === 2) {
					record.edits = [];
					for (let e = 0; e < 20; e++)
						record.edits.push(
							await page.evaluate(
								(path) => globalThis.vaultBench.edit(path),
								rows[0][0],
							),
						);
					record.editedValidation = await page.evaluate(() =>
						globalThis.vaultBench.validate(),
					);
					await page.reload();
					await page.waitForFunction(() => globalThis.vaultBench !== undefined);
					record.incrementalReplay = await page.evaluate(
						(name) => globalThis.vaultBench.load(name),
						name,
					);
					const replayed = await page.evaluate(() =>
						globalThis.vaultBench.validate(),
					);
					if (
						JSON.stringify(replayed) !== JSON.stringify(record.editedValidation)
					)
						throw new Error('Incremental replay lost edits');
					record.incrementalReplayVerified = true;
					record.compaction = await page.evaluate(() =>
						globalThis.vaultBench.compact(),
					);
					await page.reload();
					await page.waitForFunction(() => globalThis.vaultBench !== undefined);
					await page.evaluate((name) => globalThis.vaultBench.load(name), name);
					const after = await page.evaluate(() =>
						globalThis.vaultBench.validate(),
					);
					if (JSON.stringify(after) !== JSON.stringify(record.editedValidation))
						throw new Error('Compaction lost edits');
					record.compactionReopenVerified = true;
				}
				await context.close();
			}
			output.corpora.push(record);
			await Bun.write(
				join(import.meta.dir, 'vault-results.json'),
				JSON.stringify(output, null, 2),
			);
			console.log(
				JSON.stringify({
					name,
					files: record.files,
					utf8Bytes: record.utf8Bytes,
					seed,
					trials: record.trials,
				}),
			);
		} finally {
			await context.close().catch(() => {});
			await rm(profile, { recursive: true, force: true });
		}
	}
} finally {
	server.stop(true);
}
