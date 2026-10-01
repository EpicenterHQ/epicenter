/**
 * Can two windows on one origin hold two different records?
 *
 * Run: `bun run evidence/browser/two-records.ts [--webkit]`
 *
 * This exists because the answer was NO and nothing would have caught it.
 * Epicenter serves every application from one origin (ADR-0118), so honeycrisp
 * and whispering are two windows on `http://127.0.0.1:39131`. The store's
 * durable record was SQLite over an OPFS pool then, and a pool takes exclusive
 * access handles for all of its files when it installs. One pool shared across
 * the origin therefore let the first record anyone opened lock out every other
 * record in every other window:
 *
 * ```txt
 *   tab A opens vault           ok
 *   tab B opens somewhere-else  "Access Handles cannot be created if there is
 *                                another open Access Handle ..."
 * ```
 *
 * The fix was a pool per record, which makes the unit of exclusion the unit of
 * addressing, and the unit `claims.ts` already locks. This probe is the thing
 * that would notice if that ever collapsed back into a shared pool.
 *
 * CONTROL: tab A must SUCCEED. If both tabs fail, the probe has found a
 * browser with no OPFS or a profile it cannot write, and has measured its own
 * harness rather than the store.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { build } from 'vite';

const ENGINE = process.argv.includes('--webkit') ? webkit : chromium;
const root = new URL('./durable-store/', import.meta.url).pathname;
const outDir = new URL('./durable-store-dist/', import.meta.url).pathname;
await build({
	root,
	logLevel: 'error',
	build: { target: 'esnext', outDir, emptyOutDir: true },
});
const server = Bun.serve({
	port: 0,
	async fetch(r) {
		const { pathname } = new URL(r.url);
		const f = Bun.file(
			`${outDir}${pathname === '/' ? 'index.html' : pathname.slice(1)}`,
		);
		return (await f.exists())
			? new Response(f)
			: new Response('nope', { status: 404 });
	},
});
const origin = `http://localhost:${server.port}`;
const profile = mkdtempSync(join(tmpdir(), 'two-tabs-'));
const browser = await ENGINE.launchPersistentContext(profile, {});
console.log(`engine: ${ENGINE.name()}\n`);

const a = await browser.newPage();
await a.goto(origin);
const first = await a.evaluate(() => (globalThis as any).open('vault'));
console.log('tab A opens "vault":         ', JSON.stringify(first));

const b = await browser.newPage();
await b.goto(origin);
const second = await b.evaluate(() =>
	(globalThis as any).open('somewhere-else'),
);
console.log('tab B opens "somewhere-else":', JSON.stringify(second));

await browser.close();
rmSync(profile, { recursive: true, force: true });
server.stop(true);

const held = (first as { ok?: boolean }).ok === true;
const both = held && (second as { ok?: boolean }).ok === true;
console.log(
	both
		? '\nTwo windows on one origin hold two records at once.'
		: held
			? '\nFAILED: the second record was refused. A pool is being shared.'
			: '\nINCONCLUSIVE: the first record failed, so this measured the harness.',
);
if (!both) process.exit(1);
