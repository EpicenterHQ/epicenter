/** Account catalog and workflow isolation in real Chromium and WebKit storage. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const root = join(import.meta.dir, '../../..');
const requireWhispering = createRequire(
	join(root, 'apps/whispering/package.json'),
);
const { svelte } = await import(
	requireWhispering.resolve('@sveltejs/vite-plugin-svelte')
);
const html = `<!doctype html><title>Account AI isolation</title><script type="module">
import { createAppAi } from '/@fs${root}/packages/app/src/ai.ts';
import { createBrowserAppAi } from '/@fs${root}/packages/app/src/browser.ts';
import { createBrowserInferenceSelections, matchInferenceTarget } from '/@fs${root}/packages/app-shell/src/inference-selections.ts';
let owner, selections, lifetime;
const requests = [];
window.acceptance = {
 async open(product, identity) {
  lifetime = new AbortController();
  const binding = createBrowserAppAi(async (input, init) => {
   const request = new Request(input, init);
   requests.push({ url: request.url, key: request.headers.get('authorization') });
   return Response.json({ text: 'accepted' });
  });
  owner = createAppAi({
   lifetime: { signal: lifetime.signal, assertUsable: () => lifetime.signal.throwIfAborted() },
   account: null, runtime: null, configuredFetch: binding.configuredFetch,
   connections: binding.connections(product, identity ?? undefined),
  });
  selections = createBrowserInferenceSelections(product, identity ?? undefined);
  await owner.ready;
  return this.snapshot();
 },
 snapshot() { return { records: owner.value.ai.connections.getAll().map(({client, ...record}) => record), target: selections.get('transcription') }; },
 async add(key) {
  const id = await owner.value.ai.connections.add({ baseUrl: location.origin + '/provider/v1', apiKey: key, models: ['manual'] });
  selections.set('transcription', { connectionId: id, model: 'manual' });
  return id;
 },
 select(target) { selections.set('transcription', target); },
 async run() {
  const target = selections.get('transcription');
  const client = matchInferenceTarget(owner.value.ai, target);
  if (!client) return null;
  await client.audio.transcriptions.create({ file: new File(['audio'], 'audio.wav'), model: target.model });
  return requests.at(-1).key;
 },
 async close() {
  const records = owner.value.ai.connections;
  const retained = records.getAll()[0]?.client;
  const choices = selections;
  choices[Symbol.dispose]();
  lifetime.abort();
  await owner.close();
  let refused = 0;
  try { records.getAll(); } catch { refused++; }
  try { choices.get('transcription'); } catch { refused++; }
  if (retained) { try { await retained.models.list(); } catch { refused++; } }
  return refused;
 },
 async resetDeviceConfig() {
  const { deviceConfig } = await import('/@fs${root}/apps/whispering/src/lib/state/device-config.svelte.ts');
  deviceConfig.reset();
 },
};
</script>`;
const server = await createServer({
	configFile: false,
	root: join(root, 'apps/whispering'),
	logLevel: 'error',
	resolve: {
		alias: {
			'$lib/report': '/@test/report',
			$lib: join(root, 'apps/whispering/src/lib'),
			'#platform/os': join(
				root,
				'apps/whispering/src/lib/platform/os.browser.ts',
			),
		},
	},
	server: { host: 'localhost', port: 0, watch: null },
	plugins: [
		svelte({ configFile: false }),
		{
			name: 'account-ai-acceptance',
			resolveId(id) {
				if (id === '/@test/report') return id;
			},
			load(id) {
				if (id === '/@test/report')
					return 'export const report = { error() { throw new Error("Device config write failed"); } };';
			},
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
				for (const provider of [
					'openai',
					'groq',
					'deepgram',
					'elevenlabs',
					'mistral',
					'anthropic',
					'google',
					'openrouter',
					'custom',
					'speaches',
				])
					for (const field of ['apiKey', 'endpoint', 'modelId'])
						values['whispering.device.providers.' + provider + '.' + field] =
							JSON.stringify('legacy-' + provider);
				for (const [key, value] of Object.entries(values))
					localStorage.setItem(key, value);
				return values;
			});
			const alice = {
				authorityId: 'https://one.example',
				principalId: 'Alice',
			};
			const bob = { authorityId: 'https://one.example', principalId: 'Bob' };
			const otherAlice = {
				authorityId: 'https://two.example',
				principalId: 'Alice',
			};
			const owners = [null, alice, bob, otherAlice];
			const saved = [];
			for (let index = 0; index < owners.length; index++) {
				const state = await page.evaluate(
					(identity) => window.acceptance.open('whispering', identity),
					owners[index],
				);
				assert.deepEqual(state, { records: [], target: null });
				const id = await page.evaluate(
					(key) => window.acceptance.add(key),
					'key-' + index,
				);
				saved.push(id);
				assert.equal(
					await page.evaluate(() => window.acceptance.run()),
					'Bearer key-' + index,
				);
				assert.equal(await page.evaluate(() => window.acceptance.close()), 3);
			}
			// Return to Alice, sign out to no-account, then return to Bob.
			for (const index of [1, 0, 2, 1]) {
				await page.reload();
				await page.waitForFunction(() => window.acceptance);
				const state = await page.evaluate(
					(identity) => window.acceptance.open('whispering', identity),
					owners[index],
				);
				assert.equal(state.records.length, 1);
				assert.equal(state.target.connectionId, saved[index]);
				assert.equal(
					await page.evaluate(() => window.acceptance.run()),
					'Bearer key-' + index,
				);
				const foreign = saved[(index + 1) % saved.length];
				await page.evaluate(
					(connectionId) =>
						window.acceptance.select({ connectionId, model: 'manual' }),
					foreign,
				);
				assert.equal(await page.evaluate(() => window.acceptance.run()), null);
				await page.evaluate(
					(connectionId) =>
						window.acceptance.select({ connectionId, model: 'manual' }),
					saved[index],
				);
				await page.evaluate(() => window.acceptance.close());
			}
			// Vocab shares Alice's catalog, but not Whispering's workflow selection.
			const vocab = await page.evaluate(
				(identity) => window.acceptance.open('vocab', identity),
				alice,
			);
			assert.equal(vocab.records[0].id, saved[1]);
			assert.equal(vocab.target, null);
			await page.evaluate(
				(connectionId) =>
					window.acceptance.select({ connectionId, model: 'manual' }),
				saved[1],
			);
			assert.equal(
				await page.evaluate(() => window.acceptance.run()),
				'Bearer key-1',
			);
			await page.evaluate(() => window.acceptance.close());
			const bobVocab = await page.evaluate(
				(identity) => window.acceptance.open('vocab', identity),
				bob,
			);
			assert.equal(bobVocab.target, null);
			assert.equal(bobVocab.records[0].id, saved[2]);
			await page.evaluate(() => window.acceptance.close());
			const aliceVocab = await page.evaluate(
				(identity) => window.acceptance.open('vocab', identity),
				alice,
			);
			assert.equal(aliceVocab.target.connectionId, saved[1]);
			await page.evaluate(() => window.acceptance.close());
			await page.evaluate(() => window.acceptance.resetDeviceConfig());
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
					': owner isolation, return restoration, retired handles, cross-app catalog, and legacy-byte retention passed',
			);
			await context.close();
		} finally {
			await browser.close();
		}
	}
} finally {
	await server.close();
}
