// bun packages/folder/evidence/storage-shape-benchmark/run.mjs [--sizes 1000,10000] [--edits 2000]
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
const dir = import.meta.dir;
const { values } = parseArgs({ options: { sizes: { type: 'string', default: '1000,10000' }, edits: { type: 'string', default: '2000' }, variants: { type: 'string' }, output: { type: 'string', default: 'results.json' } } });
const sizes = values.sizes.split(',').map(Number), edits = Number(values.edits);
const bundles = new Map();
for (const v of ['packed', 'yjs', 'rows']) { const b = await Bun.build({ entrypoints: [join(dir, 'client.mjs')], target: 'browser', minify: true, define: { BENCH_VARIANT: JSON.stringify(v) } }); if (!b.success) throw new AggregateError(b.logs); bundles.set(v, await b.outputs[0].text()); }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(r) { const p = new URL(r.url).pathname; if (p.endsWith('.js')) return new Response(bundles.get(p.slice(1, -3)), { headers: { 'content-type': 'text/javascript' } }); return new Response(`<!doctype html><script type="module" src="${p}.js"></script>`, { headers: { 'content-type': 'text/html' } }); } });
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2); };
const results = { recordedAt: new Date().toISOString(), browser: null, edits, runs: [] };
async function session(profile, v, fn) {
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, args: ['--enable-precise-memory-info'] }); results.browser = ctx.browser()?.version() ?? 'chromium';
  try { const page = await ctx.newPage(); await page.goto(`${server.url.origin}/${v}`); await page.waitForFunction(() => globalThis.bench); const cdp = await ctx.newCDPSession(page);
    const mem = async () => { await cdp.send('HeapProfiler.collectGarbage'); const h = await cdp.send('Runtime.getHeapUsage'); return (h.usedSize + h.backingStorageSize) / 1048576; };
    return await fn(page, mem); } finally { await ctx.close(); }
}
try {
  for (const size of sizes) for (const v of (values.variants ?? 'packed,yjs,rows').split(',')) {
    const profile = await mkdtemp(join(tmpdir(), 'PROTOTYPE-shape-')); const id = `${v}-${size}`; const run = { size, variant: v };
    try {
      run.seed = await session(profile, v, p => p.evaluate(([id, n]) => bench.seed(id, n), [id, size]));
      run.cold = []; for (let i = 0; i < 3; i++) run.cold.push(await session(profile, v, async (p, mem) => { const base = await mem(); const r = await p.evaluate(id => bench.load(id), id); r.retainedMiB = +((await mem()) - base).toFixed(1); return r; }));
      // typing: `edits` single-character operations into one 3 KB transcript; every 10th is a backspace.
      run.typing = await session(profile, v, async p => {
        await p.evaluate(id => bench.load(id), id);
        return p.evaluate(async n => { const ms = [], bytes = []; let body = bench.body(); let at = body.length - 1;
          for (let i = 0; i < n; i++) { const del = i % 10 === 9;
            if (bench.type) { const r = await bench.type(del ? { del: true, at: at - 1 } : { at, ch: 'x' }); ms.push(r.ms); bytes.push(r.bytes); }
            else { body = del ? body.slice(0, at - 1) + body.slice(at) : body.slice(0, at) + 'x' + body.slice(at); ms.push(await bench.edit(body)); }
            at += del ? -1 : 1; }
          return { ms, bytes, expected: bench.body(), digest: bench.validate() }; }, edits);
      });
      const t = run.typing; run.typingSummary = { p50: pct(t.ms, .5), p95: pct(t.ms, .95), max: pct(t.ms, 1), logBytes: t.bytes.length ? t.bytes.reduce((a, b) => a + b, 0) : null };
      run.reopenWithLog = await session(profile, v, async p => { const r = await p.evaluate(id => bench.load(id), id); r.sameText = await p.evaluate(e => bench.body() === e, t.expected); return r; });
      run.compact = await session(profile, v, async p => { await p.evaluate(id => bench.load(id), id); const c = await p.evaluate(() => bench.compact()); if (v === 'yjs') c.rebuild = await p.evaluate(() => bench.rebuild()); return c; });
      run.reopenCompacted = await session(profile, v, async (p, mem) => { const base = await mem(); const r = await p.evaluate(id => bench.load(id), id); r.sameText = await p.evaluate(e => bench.body() === e, t.expected); r.retainedMiB = +((await mem()) - base).toFixed(1); return r; });
      delete run.typing.ms; delete run.typing.bytes; delete run.typing.expected;
      results.runs.push(run); await Bun.write(join(dir, values.output), JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ size, v, cold: run.cold.map(c => Math.round(c.readyMs)), mem: run.cold.map(c => c.retainedMiB), typing: run.typingSummary, reopenLog: Math.round(run.reopenWithLog.readyMs), compact: run.compact, reopenCompacted: Math.round(run.reopenCompacted.readyMs), ok: run.reopenWithLog.sameText && run.reopenCompacted.sameText }));
    } finally { await rm(profile, { recursive: true, force: true }); }
  }
} finally { server.stop(true); }
