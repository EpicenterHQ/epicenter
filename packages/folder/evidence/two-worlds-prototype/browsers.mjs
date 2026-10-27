// PROTOTYPE: claim 1 across engines and claim 5. Run: bun packages/folder/evidence/two-worlds-prototype/browsers.mjs
import { chromium, webkit } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { identity, seedUpdate } from './core.mjs'; import { fixture } from './fixture.mjs';
const dir = import.meta.dir, sizes = [1000, 10000];
const b = await Bun.build({ entrypoints: [join(dir, 'page.mjs')], target: 'browser', minify: true }); if (!b.success) throw new AggregateError(b.logs);
const script = await b.outputs[0].text();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: r => new URL(r.url).pathname === '/p.js' ? new Response(script, { headers: { 'content-type': 'text/javascript' } }) : new Response('<!doctype html><script type="module" src="/p.js"></script>', { headers: { 'content-type': 'text/html' } }) });
const rows = [];
for (const size of sizes) {
  const t0 = performance.now(); const u = seedUpdate(identity('braden/whispering', 'c0ffee'), fixture(size));
  rows.push({ engine: 'bun', rows: size * 5, seedMs: +(performance.now() - t0).toFixed(0), bytes: u.byteLength, sha256: new Bun.CryptoHasher('sha256').update(u).digest('hex') });
}
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) for (const size of sizes) {
  const profile = await mkdtemp(join(tmpdir(), 'PROTOTYPE-two-worlds-'));
  const session = async fn => { const c = await type.launchPersistentContext(profile, { headless: true }); try { const p = await c.newPage(); await p.goto(server.url.origin); await p.waitForFunction(() => globalThis.proto); return await fn(p); } finally { await c.close(); } };
  try {
    const s = await session(p => p.evaluate(n => proto.seed(n), size));
    const opens = []; for (let i = 0; i < 3; i++) opens.push(await session(p => p.evaluate(n => proto.open(n), size)));
    rows.push({ engine: name, rows: size * 5, seedMs: +s.seedMs.toFixed(0), bytes: s.bytes, sha256: s.sha256, openMs: opens.map(o => +o.openMs.toFixed(0)), split: opens.map(o => [o.readMs, o.applyMs, o.projectMs].map(x => +x.toFixed(0))) });
  } finally { await rm(profile, { recursive: true, force: true }); }
}
server.stop(true);
for (const size of sizes) { const set = new Set(rows.filter(r => r.rows === size * 5).map(r => r.sha256)); console.log(`${size * 5} rows: ${set.size === 1 ? 'IDENTICAL seed bytes in bun, chromium, webkit' : 'MISMATCH'}`); }
for (const r of rows) console.log(JSON.stringify({ ...r, sha256: r.sha256.slice(0, 12) }));
await Bun.write(join(dir, 'browsers-results.json'), JSON.stringify({ recordedAt: new Date().toISOString(), rows }, null, 2));
