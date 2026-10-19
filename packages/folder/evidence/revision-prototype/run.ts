/** THROWAWAY: bun run.ts; requires a locally installed Playwright and browser binaries. */
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const output = process.env.REVISION_OUTPUT ?? join(tmpdir(), 'epicenter-revision-prototype');
await mkdir(output, { recursive: true });
const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'page.ts')], target: 'browser', outdir: output });
if (!built.success) throw new AggregateError(built.logs);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
	return new URL(request.url).pathname === '/page.js' ? new Response(Bun.file(join(output, 'page.js')), { headers: { 'content-type': 'text/javascript' } }) : new Response('<!doctype html><title>Scratch revision prototype</title><p>Scratch IndexedDB revision experiment.</p><script type="module" src="/page.js"></script>', { headers: { 'content-type': 'text/html' } });
} });
const pw = await import(Bun.resolveSync('playwright', '/tmp'));
const cache = '/Users/braden/Library/Caches/ms-playwright';
const executables = {
	chromium: cache + '/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell',
	webkit: cache + '/webkit-2336/pw_run.sh',
	firefox: cache + '/firefox-1532/firefox/Nightly.app/Contents/MacOS/firefox',
};
const cases = [
	{ name: 'no-sync-10hz', rows: 5000, large: false, samePath: false, saveEvery: 100, duration: 3000, delay: 0 },
	{ name: 'two-tabs-1hz', rows: 5000, large: false, samePath: false, saveEvery: 1000, duration: 6000, delay: 0 },
	{ name: 'two-tabs-10hz', rows: 5000, large: false, samePath: false, saveEvery: 100, duration: 5000, delay: 0 },
	{ name: 'two-tabs-50hz', rows: 5000, large: false, samePath: false, saveEvery: 20, duration: 5000, delay: 0 },
	{ name: 'large-same-file-10hz', rows: 5000, large: true, samePath: true, saveEvery: 100, duration: 5000, delay: 0 },
	{ name: 'injected-250ms-window-50hz', rows: 5000, large: false, samePath: false, saveEvery: 20, duration: 2500, delay: 250 },
];
const quantiles = (numbers: number[]) => { const sorted = [...numbers].sort((a, b) => a - b); const q = (p: number) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0) * 100) / 100; return { p50: q(.5), p95: q(.95), max: q(1) }; };
type OpenArgs = { database: string; settings: Parameters<typeof globalThis.revisionPrototype.open>[1] };
type VerifyArgs = { expected: Parameters<typeof globalThis.revisionPrototype.verify>[0]; round: number };
type Report = ReturnType<typeof globalThis.revisionPrototype.report>;
const all: unknown[] = [];
try {
	for (const engine of (process.env.REVISION_ENGINES ?? 'chromium,webkit,firefox').split(',')) {
		if (engine !== 'chromium' && engine !== 'webkit' && engine !== 'firefox') throw Error(`unknown engine ${engine}`);
		const browser = await pw[engine].launch({ headless: true, executablePath: executables[engine], ...(engine === 'chromium' ? { args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] } : {}) });
		try {
			for (const settings of cases.filter((item) => !process.env.REVISION_CASE || item.name.includes(process.env.REVISION_CASE))) {
				const context = await browser.newContext(); const a = await context.newPage(); const b = await context.newPage();
				try {
					for (const page of [a, b]) { page.on('pageerror', (error: Error) => console.error(engine, settings.name, error)); await page.goto(server.url.href); await page.waitForFunction(() => 'revisionPrototype' in globalThis); }
					const database = `PROTOTYPE-wipe-me-${engine}-${settings.name}-${Date.now()}`;
					await a.evaluate(async ({ database, settings }: OpenArgs) => { await globalThis.revisionPrototype.open(database, settings); await globalThis.revisionPrototype.seed(); }, { database, settings });
					await b.evaluate(async ({ database, settings }: OpenArgs) => globalThis.revisionPrototype.open(database, settings), { database, settings });
					if (settings.name === 'no-sync-10hz') await context.setOffline(true);
					const started = Date.now();
					const [countA, countB, round] = await Promise.all([
						a.evaluate(() => globalThis.revisionPrototype.writer('A')),
						b.evaluate(() => globalThis.revisionPrototype.writer('B')),
						settings.name === 'no-sync-10hz' ? Promise.resolve(0) : a.evaluate(() => globalThis.revisionPrototype.syncing()),
					]);
					if (settings.name === 'no-sync-10hz') await context.setOffline(false);
					const drained = await a.evaluate((round: number) => globalThis.revisionPrototype.finish(round), round);
					const reportA: Report = await a.evaluate(() => globalThis.revisionPrototype.report()); const reportB: Report = await b.evaluate(() => globalThis.revisionPrototype.report());
					const latest = new Map<string, Report['saves'][number]>();
					for (const save of [...reportA.saves, ...reportB.saves]) latest.set(`${save.actor}/${save.path}`, save);
					const verification = await a.evaluate(({ expected, round }: VerifyArgs) => globalThis.revisionPrototype.verify(expected, round), { expected: [...latest.values()], round: round + 1 });
					await a.evaluate(() => globalThis.revisionPrototype.close());
					await b.evaluate(() => globalThis.revisionPrototype.close());
					await Promise.all([a.reload(), b.reload()]);
					await a.waitForFunction(() => 'revisionPrototype' in globalThis);
					await a.evaluate(async ({ database, settings }: OpenArgs) => globalThis.revisionPrototype.open(database, settings), { database, settings });
					const reopened = await a.evaluate(({ expected, round }: VerifyArgs) => globalThis.revisionPrototype.verify(expected, round), { expected: [...latest.values()], round: round + 1 });
					const saveEvents = [...reportA.events, ...reportB.events].filter((event) => event.phase.startsWith('save-'));
					const adoptEvents = reportA.events.filter((event) => event.phase === 'adopt');
					const result = { engine, version: browser.version(), name: settings.name, settings, elapsed: Date.now() - started, countA, countB, drained, verification, reopened,
						save: { acknowledged: countA + countB, rejectedAttempts: saveEvents.filter((e) => !e.ok).length, latency: quantiles([...reportA.saves, ...reportB.saves].map((s) => s.latency)), window: quantiles(saveEvents.map((e) => e.window)) },
						adopt: { publications: adoptEvents.filter((e) => e.ok).length, rejectedAttempts: adoptEvents.filter((e) => !e.ok).length, window: quantiles(adoptEvents.map((e) => e.window)), attempts: reportA.syncs },
					};
					all.push(result);
					await Bun.write(join(output, 'results.json'), JSON.stringify(all, null, 2));
					await Bun.write(join(output, `${engine}-${settings.name}-trace.json`), JSON.stringify({ a: reportA, b: reportB }, null, 2));
					console.log(JSON.stringify({ engine, name: result.name, save: result.save, adopt: { publications: result.adopt.publications, rejectedAttempts: result.adopt.rejectedAttempts, window: result.adopt.window }, drained, verification }));
					if (!drained || verification.failures.length || verification.pending || !verification.refsEqual || reopened.failures.length || reopened.pending || !reopened.refsEqual) throw Error('preservation or drain failed');
					await a.evaluate(() => globalThis.revisionPrototype.close());
					await a.evaluate((name: string) => new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); }), database);
				} finally { await context.close(); }
			}
		} finally { await browser.close(); }
	}
} finally { server.stop(true); }
