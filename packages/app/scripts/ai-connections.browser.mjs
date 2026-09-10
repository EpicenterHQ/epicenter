/** Real browser storage migration and SDK destination acceptance. Run from root with Bun. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const evidence = await mkdtemp(join(tmpdir(), 'ai-connections-evidence-'));
const requests = [];
const errors = [];
const root = join(import.meta.dir, '../../..');
const html = `<!doctype html><title>AI settings acceptance</title><script type="module">
import { createAppAi } from '/packages/app/src/ai.ts';
import { createBrowserAppAi } from '/packages/app/src/browser.ts';
import { initializeBrowserAiSettings } from '/packages/app-shell/src/migrate-ai-settings.ts';
import { createBrowserInferenceSelections, matchInferenceTarget } from '/packages/app-shell/src/inference-selections.ts';
const key = 'acceptance';
let owner, selections, lifetime;
window.acceptance = {
 async open() {
  await initializeBrowserAiSettings(key);
  lifetime = new AbortController();
  owner = createAppAi({ lifetime: { signal: lifetime.signal, assertUsable: () => lifetime.signal.throwIfAborted() }, account: null, runtime: null, connections: createBrowserAppAi(key).connections() });
  selections = createBrowserInferenceSelections(key);
  return { records: owner.value.ai.connections.getAll().map(({client,...record})=>record), target: selections.get('chat'), oldApi: 'configuration' in owner.value.ai || 'configured' in owner.value.ai };
 },
 selected() { return selections.get('chat'); },
 records() { return owner.value.ai.connections.getAll().map(({client,...record})=>record); },
 select(target) { selections.set('chat', target); },
 remove(id) { return owner.value.ai.connections.remove(id); },
 async run() {
  const target = selections.get('chat');
  const client = matchInferenceTarget({ ai: owner.value.ai, account: null }, target);
  if (!client) return null;
  return (await client.chat.completions.create({model:target.model,messages:[]})).choices[0].message.content;
 },
 async close() { selections[Symbol.dispose](); lifetime.abort(); await owner.close(); },
};
</script>`;
let browser;
const server = await createServer({
	configFile: false,
	root,
	server: { host: 'localhost', port: 0, watch: null },
	plugins: [
		{
			name: 'ai-acceptance',
			configureServer(vite) {
				vite.middlewares.use(async (req, res, next) => {
					if (req.url === '/') {
						res.setHeader('content-type', 'text/html');
						res.end(html);
						return;
					}
					if (req.url === '/inference/v1/chat/completions') {
						let body = '';
						for await (const chunk of req) body += chunk;
						requests.push({
							url: req.url,
							authorization: req.headers.authorization,
							body: JSON.parse(body),
						});
						res.setHeader('content-type', 'application/json');
						res.end(
							JSON.stringify({
								choices: [
									{ message: { role: 'assistant', content: 'accepted' } },
								],
							}),
						);
						return;
					}
					next();
				});
			},
		},
	],
});
try {
	await server.listen();
	const origin = server.resolvedUrls.local[0];
	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	const first = await context.newPage();
	const second = await context.newPage();
	for (const page of [first, second])
		page.on('pageerror', (error) => errors.push(error.message));
	await Promise.all([first.goto(origin), second.goto(origin)]);
	await Promise.all([
		first.waitForFunction(() => window.acceptance),
		second.waitForFunction(() => window.acceptance),
	]);
	await first.evaluate(() => {
		localStorage.setItem(
			'acceptance.inference-connections',
			JSON.stringify([
				{
					baseUrl: location.origin + '/inference/v1',
					apiKey: 'acceptance-key',
					models: ['manual'],
				},
			]),
		);
		localStorage.setItem(
			'acceptance.inference-targets',
			JSON.stringify({
				chat: {
					connectionId: location.origin + '/inference/v1',
					model: 'manual',
				},
			}),
		);
	});
	const opened = await Promise.all([
		first.evaluate(() => window.acceptance.open()),
		second.evaluate(() => window.acceptance.open()),
	]);
	assert.equal(opened[0].records[0].id, opened[1].records[0].id);
	assert.equal(opened[0].target.connectionId, opened[0].records[0].id);
	assert.equal(opened[0].oldApi, false);
	assert.equal(requests.length, 0);
	assert.equal(await first.evaluate(() => window.acceptance.run()), 'accepted');
	assert.deepEqual(requests, [
		{
			url: '/inference/v1/chat/completions',
			authorization: 'Bearer acceptance-key',
			body: { model: 'manual', messages: [] },
		},
	]);
	await first.evaluate(() => window.acceptance.close());
	await first.reload();
	await first.waitForFunction(() => window.acceptance);
	assert.deepEqual(
		await first.evaluate(() => window.acceptance.open()),
		opened[0],
	);
	await second.evaluate(() =>
		window.acceptance.select({
			connectionId: 'unresolved:missing',
			model: 'manual',
		}),
	);
	await first.waitForFunction(
		() => window.acceptance.selected()?.connectionId === 'unresolved:missing',
	);
	assert.equal(await first.evaluate(() => window.acceptance.run()), null);
	await second.evaluate(
		(target) => window.acceptance.select(target),
		opened[0].target,
	);
	await first.waitForFunction(
		(id) => window.acceptance.selected()?.connectionId === id,
		opened[0].records[0].id,
	);
	await second.evaluate(
		(id) => window.acceptance.remove(id),
		opened[0].records[0].id,
	);
	await first.waitForFunction(() => window.acceptance.records().length === 0);
	assert.equal(await first.evaluate(() => window.acceptance.run()), null);
	assert.equal(requests.length, 1);
	const stored = await first.evaluate(() => ({
		connections: JSON.parse(
			localStorage.getItem('acceptance.app-ai-connections'),
		),
		selections: JSON.parse(
			localStorage.getItem('acceptance.app-ai-selections'),
		),
		legacy: localStorage.getItem('acceptance.inference-connections'),
		normalized: JSON.parse(localStorage.getItem('acceptance.app-ai')),
	}));
	assert.deepEqual(stored.connections.connections, []);
	assert.equal(
		stored.selections.selections.chat.connectionId,
		opened[0].records[0].id,
	);
	assert.equal(stored.normalized.connections[0].id, opened[0].records[0].id);
	assert.ok(stored.legacy);
	await Promise.all([
		first.evaluate(() => window.acceptance.close()),
		second.evaluate(() => window.acceptance.close()),
	]);
	assert.deepEqual(errors, []);
	await writeFile(
		join(evidence, 'result.json'),
		JSON.stringify(
			{
				passed: true,
				checks: [
					'concurrent documents share committed ID mapping',
					'separate stores preserve IDs across reload',
					'exact URL bearer and manual model through actual SDK',
					'cross-document selection and deletion never reroute',
					'old bytes retained',
				],
				requests,
			},
			null,
			2,
		),
	);
	console.log('AI browser acceptance passed:', evidence);
} catch (cause) {
	await writeFile(
		join(evidence, 'failure.json'),
		JSON.stringify({ error: String(cause), errors, requests }, null, 2),
	);
	throw cause;
} finally {
	await browser?.close();
	await server.close();
}
