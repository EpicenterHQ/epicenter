// Run from any directory: bun packages/folder/evidence/whispering-storage-benchmark/run.mjs
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { chromium, webkit, firefox } from 'playwright';

const directory = import.meta.dir;
const root = resolve(directory, '../../../..');
const { values } = parseArgs({ options: { sizes: { type: 'string', default: '1000,10000' }, rounds: { type: 'string', default: '3' }, browsers: { type: 'string', default: 'chromium' }, variants: { type: 'string', default: 'current,batched-cache,yjs' }, output: { type: 'string', default: 'results.json' } } });
const sizes = values.sizes.split(',').map(Number), rounds = Number(values.rounds);
const variants = ['current', 'batched-cache', 'yjs'];
const measuredVariants = values.variants.split(',');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const hash = text => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const replacements = [];
function change(source, before, after, label) { assert(source.split(before).length === 2, `Source drift at ${label}`); replacements.push({ label, before, after }); return source.replace(before, after); }
const bundles = new Map();
for (const variant of variants) {
  const build = await Bun.build({ entrypoints: [join(directory, 'client.mjs')], target: 'browser', minify: true, define: { BENCH_VARIANT: JSON.stringify(variant) }, plugins: variant === 'batched-cache' ? [{ name: 'isolated-read-experiment', setup(build) {
    build.onLoad({ filter: /\/src\/browser\/(storage|repository)\.ts$/ }, async ({ path }) => {
      let source = await readFile(path, 'utf8');
      if (path.endsWith('/storage.ts')) {
        source = change(source, '| { rows: string }', '| { rows: string; knownRows?: ReadonlyMap<string, string> }', 'allow hash-only witnesses for cached rows');
        source = change(source, '\t\t\t\tfor (const path of selected) {\n\t\t\t\t\tconst entry = tree.files.get(path);\n\t\t\t\t\tif (entry !== undefined && entry.mode !== \'160000\')\n\t\t\t\t\t\tawait read(entry.oid);\n\t\t\t\t}', '\t\t\t\tawait Promise.all([...selected].map(async (path) => {\n\t\t\t\t\tconst entry = tree.files.get(path);\n\t\t\t\t\tif (entry !== undefined && entry.mode !== \'160000\') await read(entry.oid);\n\t\t\t\t}));', 'batch selected blobs');
        source = change(source, "if (entry !== undefined && entry.mode !== '160000') await read(entry.oid);", "if (entry !== undefined && entry.mode !== '160000' && !(scope && typeof scope === 'object' && 'rows' in scope && scope.knownRows?.get(path) === entry.oid)) await read(entry.oid);", 'skip unchanged cached row blobs');
      } else {
        source = change(source, '\t\tconst rowPath = (id: string) => `${name}/${id}.md`;', '\t\tconst rowPath = (id: string) => `${name}/${id}.md`;\n\t\tlet cache = new Map<string, { oid: string; row: Row<TSchema> }>();', 'table-local latest-row cache');
        source = change(source, '\t\t\t\t\tconst rows: Row<TSchema>[] = [];', '\t\t\t\t\tconst rows: Row<TSchema>[] = [];\n\t\t\t\t\tconst nextCache = new Map<string, { oid: string; row: Row<TSchema> }>();', 'prune cache to current table');
        source = change(source, 'await storage.capture({ rows: name })', 'await storage.capture({ rows: name, knownRows: new Map([...cache].map(([id, value]) => [rowPath(id), value.oid])) })', 'supply current parsed-row hashes to capture');
        source = change(source, '\t\t\t\t\t\tconst content = snapshotContent(snapshot, path);', '\t\t\t\t\t\tconst known = cache.get(id);\n\t\t\t\t\t\tif (known?.oid === snapshot.files.get(path)?.oid) { nextCache.set(id, known); rows.push(known.row); continue; }\n\t\t\t\t\t\tconst content = snapshotContent(snapshot, path);', 'use cached row before requesting its absent blob');
        source = change(source, '\t\t\t\t\t\tif (content !== null) rows.push(readRow(id, content, schema));', '\t\t\t\t\t\tif (content !== null) {\n\t\t\t\t\t\t\tconst oid = snapshot.files.get(path)!.oid;\n\t\t\t\t\t\t\tconst previous = cache.get(id);\n\t\t\t\t\t\t\tconst row = previous?.oid === oid ? previous.row : readRow(id, content, schema);\n\t\t\t\t\t\t\tnextCache.set(id, { oid, row }); rows.push(row);\n\t\t\t\t\t\t}', 'reuse parsed row only for equal content hash');
        source = change(source, '\t\t\t\t\treturn rows;', '\t\t\t\t\tcache = nextCache;\n\t\t\t\t\treturn rows;', 'install current cache');
      }
      return { contents: source, loader: 'ts', resolveDir: dirname(path) };
    });
  } }] : [] });
  if (!build.success) throw new AggregateError(build.logs, 'Browser build failed');
  bundles.set(variant, await build.outputs[0].text());
}
await Bun.write(join(directory, 'optimized-replacements.json'), JSON.stringify(replacements, null, 2));
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith('.js')) { const script = bundles.get(path.slice(1, -3)); return script ? new Response(script, { headers: { 'content-type': 'text/javascript' } }) : new Response('Missing', { status: 404 }); }
  return new Response(`<!doctype html><title>Disposable storage benchmark</title><script type="module" src="/${path.slice(1)}.js"></script>`, { headers: { 'content-type': 'text/html' } });
} });
const results = { recordedAt: new Date().toISOString(), scope: 'Data-layer startup: open storage, hydrate/project five tables, list files. Excludes browser launch, script loading, Svelte mount, network sync and audio.', rounds, sizes, yjs: '14.0.0-rc.26', manifests: [], trials: [], bundles: Object.fromEntries([...bundles].map(([name, source]) => [name, hash(source)])), productionSources: Object.fromEntries(await Promise.all(['src/browser/storage.ts', 'src/browser/repository.ts', 'src/shared/markdown-codec.ts'].map(async path => [path, hash(await readFile(join(root, 'packages/folder', path), 'utf8'))]))) };
const profiles = [];
async function visit(context, variant) { const page = await context.newPage(); await page.route('**/*', route => route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort()); await page.goto(`${server.url.origin}/${variant}`); await page.waitForFunction(() => globalThis.storageBenchmark !== undefined); page.on('pageerror', error => console.error(error)); return page; }
async function heap(cdp) { return cdp ? cdp.send('Runtime.getHeapUsage') : null; }
function delta(a, b) { return a && b ? { jsHeapBytes: b.usedSize - a.usedSize, backingBytes: b.backingStorageSize - a.backingStorageSize, heapAndBackingBytes: b.usedSize + b.backingStorageSize - a.usedSize - a.backingStorageSize } : null; }
try {
 for (const browserName of values.browsers.split(',')) {
  const browserType = { chromium, webkit, firefox }[browserName]; assert(browserType, 'Unknown browser');
  for (const size of sizes) {
   const group = new Map(); let expected;
   for (const variant of measuredVariants) {
    const profile = await mkdtemp(join(tmpdir(), 'PROTOTYPE-whispering-storage-')); profiles.push(profile);
    const launch = () => browserType.launchPersistentContext(profile, { headless: true, ...(browserName === 'chromium' ? { args: ['--enable-precise-memory-info'] } : {}) });
    const context = await launch();
    try {
      const page = await visit(context, variant); const id = `PROTOTYPE-${browserName}-${size}-${variant}`;
      const manifest = await page.evaluate(({ id, size }) => globalThis.storageBenchmark.seed(id, size), { id, size });
      expected ??= manifest.expected; assert(JSON.stringify(manifest.expected) === JSON.stringify(expected), 'Fixture mismatch');
      results.manifests.push({ browser: browserName, version: context.browser().version(), variant, size, ...manifest }); group.set(variant, { launch, id });
      console.log(JSON.stringify({ event: 'seeded', browser: browserName, variant, rowsPerTable: size, seedMs: manifest.seedMs }));
    } finally { await context.close(); }
   }
   for (let round = 0; round < rounds; round++) {
    const order = (round % 3 === 0 ? variants : round % 3 === 1 ? [...variants].reverse() : ['batched-cache', 'current', 'yjs']).filter(variant => measuredVariants.includes(variant));
    for (const variant of order) {
      const { launch, id } = group.get(variant); const context = await launch();
      try {
        const page = await visit(context, variant); const cdp = browserName === 'chromium' ? await context.newCDPSession(page) : null;
        if (cdp) await cdp.send('HeapProfiler.collectGarbage'); const baseline = await heap(cdp);
        const startup = await page.evaluate(id => globalThis.storageBenchmark.load(id), id); const immediate = await heap(cdp);
        if (cdp) await cdp.send('HeapProfiler.collectGarbage'); const steady = await heap(cdp);
        const validation = await page.evaluate(() => globalThis.storageBenchmark.validate());
        assert(JSON.stringify(validation) === JSON.stringify(expected), 'Cold-start row checksum mismatch');
        assert(startup.counts.every(count => count === size) && startup.files === size * 5, 'Cold-start count mismatch');
        const warm = []; for (let i = 0; i < 3; i++) { const sample = await page.evaluate(() => globalThis.storageBenchmark.warm()); assert(JSON.stringify(sample.validation) === JSON.stringify(expected), 'Warm row mismatch'); warm.push(sample.ms); }
        const edits = []; for (let i = 0; i < 5; i++) edits.push(await page.evaluate(i => globalThis.storageBenchmark.edit(i), i));
        const editedValidation = await page.evaluate(() => globalThis.storageBenchmark.validate());
        await page.reload(); await page.waitForFunction(() => globalThis.storageBenchmark !== undefined); await page.evaluate(id => globalThis.storageBenchmark.load(id), id);
        const replayed = await page.evaluate(() => globalThis.storageBenchmark.validate()); assert(JSON.stringify(replayed) === JSON.stringify(editedValidation), 'Durable edits lost on reload');
        await page.evaluate(() => globalThis.storageBenchmark.reset());
        const result = { browser: browserName, size, variant, round, startup, baseline, immediate, steady, startupMemory: delta(baseline, immediate), retainedMemory: delta(baseline, steady), warmMs: warm, edits, validation, editedValidation, incrementalReopenVerified: true };
        results.trials.push(result); await Bun.write(join(directory, values.output), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ event: 'measured', browser: browserName, size, variant, round, readyMs: startup.readyMs, retainedMiB: result.retainedMemory ? result.retainedMemory.heapAndBackingBytes / 1048576 : null }));
      } finally { await context.close(); }
    }
   }
  }
 }
} finally { server.stop(true); for (const profile of profiles) await rm(profile, { recursive: true, force: true }); }
