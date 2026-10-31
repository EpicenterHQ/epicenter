/** Browser catalog and workflow choices in real Chromium and WebKit storage. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const root = join(import.meta.dir, '../../..');
const html = `<!doctype html><title>Browser AI storage</title><script type="module">
import { openConnectionCatalog } from '/@fs${root}/packages/ai/src/connection-catalog.ts';
import { createBrowserConnections } from '/@fs${root}/packages/ai/src/browser.ts';
import { createBrowserInferenceSelections } from '/@fs${root}/packages/ai/src/selections.ts';
import { resolveInferenceTarget } from '/@fs${root}/packages/ai/src/target.ts';
let catalog, selections, lifetime;
const requests = [];
window.acceptance = {
 async open(product) {
  lifetime = new AbortController();
  const configuredFetch = async (input, init) => {
   const request = new Request(input, init);
   requests.push({ url: request.url, key: request.headers.get('authorization') });
   return Response.json({ text: 'accepted' });
  };
  catalog = await openConnectionCatalog({ ...createBrowserConnections(), transport(record) {return {baseURL:record.baseUrl, fetch:configuredFetch};} });
  selections = createBrowserInferenceSelections(product);

  return this.snapshot();
 },
 snapshot() { return { records: catalog.getAll().map(({client, ...record}) => record), target: selections.get('transcription') }; },
 async add(key) {
  const id = await catalog.add({ baseUrl: location.origin + '/provider/v1', apiKey: key, models: ['manual'] });
  selections.set('transcription', { connectionId: id, model: 'manual' });
  return id;
 },
 select(target) { selections.set('transcription', target); },
 async run() {
  const target = selections.get('transcription');
  const resolved = resolveInferenceTarget({account:null,connections:catalog}, target);
  if (!resolved) return null;
  await resolved.client.audio.transcriptions.create({ file: new File(['audio'], 'audio.wav'), model: resolved.model });
  return requests.at(-1).key;
 },
 async close() {
  const records = catalog;
  const retained = records.getAll()[0]?.client;
  const choices = selections;
  choices[Symbol.dispose]();
  lifetime.abort();
  await catalog.close();
  let refused = 0;
  try { records.getAll(); } catch { refused++; }
  try { choices.get('transcription'); } catch { refused++; }
  if (retained) { try { await retained.models.list(); } catch { refused++; } }
  return refused;
 },
};
</script>`;
const server = await createServer({
	configFile: false,
	root: join(root, 'packages/ai'),
	logLevel: 'error',
	optimizeDeps: {
		entries: [
			join(root, 'packages/ai/src/ai.ts'),
			join(root, 'packages/ai/src/browser.ts'),
			join(root, 'packages/ai/src/selections.ts'),
		],
	},
	server: { host: 'localhost', port: 0, watch: null },
	plugins: [
		{
			name: 'browser-ai-acceptance',
			configureServer(vite) {
				vite.middlewares.use((req, res, next) => {
					if (req.url !== '/') return next();
					res.setHeader('content-type', 'text/html');
					res.end(html);
				});
			},
		},
	],
});
try {
	await server.listen();
	const origin = server.resolvedUrls.local[0];
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch({ headless: true });
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			const errors = [];
			page.on('pageerror', (error) => {
				errors.push(error.message);
				console.error(error.message);
			});
			page.on('requestfailed', (request) =>
				console.error(request.url(), request.failure()),
			);
			await page.goto(origin);
			await page.waitForFunction(() => window.acceptance);
			const legacy = await page.evaluate(() => {
				const values = {};
				for (const product of ['whispering', 'vocab', 'epicenter'])
					for (const suffix of [
						'app-ai',
						'app-ai-connections',
						'app-ai-selections',
						'inference-connections',
						'inference-targets',
					])
						values[product + '.' + suffix] =
							'malformed legacy credential bytes';
				for (const [key, value] of Object.entries(values))
					localStorage.setItem(key, value);
				return values;
			});
			const state = await page.evaluate(() =>
				window.acceptance.open('whispering'),
			);
			assert.deepEqual(state, { records: [], target: null });
			const saved = await page.evaluate(
				(key) => window.acceptance.add(key),
				'key-0',
			);
			assert.equal(
				await page.evaluate(() => window.acceptance.run()),
				'Bearer key-0',
			);
			assert.equal(await page.evaluate(() => window.acceptance.close()), 3);
			// A reload restores the connection and the choice; a choice naming a
			// connection that does not exist resolves to nothing.
			await page.reload();
			await page.waitForFunction(() => window.acceptance);
			const restored = await page.evaluate(() =>
				window.acceptance.open('whispering'),
			);
			assert.equal(restored.records.length, 1);
			assert.equal(restored.target.connectionId, saved);
			assert.equal(
				await page.evaluate(() => window.acceptance.run()),
				'Bearer key-0',
			);
			await page.evaluate(() =>
				window.acceptance.select({ connectionId: 'missing', model: 'manual' }),
			);
			assert.equal(await page.evaluate(() => window.acceptance.run()), null);
			await page.evaluate(() => window.acceptance.close());
			// Vocab shares the browser's catalog, but not Whispering's choice.
			const vocab = await page.evaluate(() => window.acceptance.open('vocab'));
			assert.equal(vocab.records[0].id, saved);
			assert.equal(vocab.target, null);
			await page.evaluate(() => window.acceptance.close());
			const after = await page.evaluate(
				(keys) =>
					Object.fromEntries(
						keys.map((key) => [key, localStorage.getItem(key)]),
					),
				Object.keys(legacy),
			);
			assert.deepEqual(after, legacy);
			assert.deepEqual(errors, []);
			console.log(
				engine.name() +
					': reload restoration, retired handles, cross-app catalog, and legacy-byte retention passed',
			);
			await context.close();
		} finally {
			await browser.close();
		}
	}
} finally {
	await server.close();
}
