/** Picker acceptance: awaited saves, hidden credentials, reactive updates, and stale UI retirement. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = join(import.meta.dir, '../../..');
const appRequire = createRequire(join(root, 'packages/app/package.json'));
const whisperingRequire = createRequire(
	join(root, 'apps/whispering/package.json'),
);
const { chromium } = await import(appRequire.resolve('playwright'));
const { createServer } = await import(appRequire.resolve('vite'));
const { svelte } = await import(
	whisperingRequire.resolve('@sveltejs/vite-plugin-svelte')
);
const directory = await mkdtemp(
	join(root, 'packages/app-shell/.picker-acceptance-'),
);
const evidence = await mkdtemp(join(tmpdir(), 'inference-picker-evidence-'));
const errors = [];
const requests = [];
await writeFile(
	join(directory, 'Picker.svelte'),
	`<script>
import InferencePicker from '../src/inference-picker/inference-picker.svelte';
import { createInferenceConnections } from '../src/inference-picker/connections.svelte';
import { createAppAi } from '../../app/src/ai';
import { createBrowserAppAi } from '../../app/src/browser';
import { createBrowserInferenceSelections } from '../src/inference-selections';
const records = createBrowserAppAi().connections('picker-acceptance');
const hidden = (records) => records.map(({apiKey, ...record}) => ({ ...record, hasApiKey: Boolean(apiKey), accessVersion: apiKey ? 'credential' : 'anonymous' }));
let blocked, release;
let fail = false;
const save = async (operation) => { if (blocked) await blocked; if (fail) throw new Error('Save failed'); return operation(); };
const owner = createAppAi({
 lifetime: { signal: new AbortController().signal, assertUsable() {} }, account: null, runtime: null,
 connections: {
  ...records,
  getAll: () => hidden(records.getAll()),
  subscribe: (listener) => records.subscribe((next) => listener(hidden(next))),
  add: (input) => save(() => records.add(input)),
  update: (id, patch) => save(() => records.update(id, patch)),
  transport(record) {
   const key = records.getAll().find(entry => entry.id === record.id)?.apiKey;
   return { baseURL: record.baseUrl, fetch(input, init) {
    const headers = new Headers(init.headers); if (key) headers.set('authorization', 'Bearer ' + key);
    return fetch(input, { ...init, headers });
   }};
  },
 }
});
const app = { ai: owner.value.ai, account: null };
const selections = createBrowserInferenceSelections('picker-acceptance');
const connections = createInferenceConnections({
 connections: { runtime: app.ai.runtime, custom: app.ai.connections },
 accountConnection: app.ai.account, selections, hostedModels: []
});
let shown = $state(true);
let model = $state('');
window.acceptance = {
 selected: () => selections.get('chat'),
 records: () => app.ai.connections.getAll().map(({client,...record}) => record),
 add: (input) => app.ai.connections.add(input),
 update: (id, patch) => app.ai.connections.update(id, patch),
 key: (id) => records.getAll().find(entry => entry.id === id)?.apiKey,
 block() { blocked = new Promise(resolve => release = resolve); },
 release() { blocked = undefined; release?.(); },
 fail(value) { fail = value; },
 hide() { shown = false; },
 show() { shown = true; },
};
</script>
{#if shown}<InferencePicker scope="chat" {model} {connections} onSelectModel={(value) => model = value} />{/if}
`,
);
await writeFile(
	join(directory, 'main.js'),
	`import { mount } from 'svelte'; import Picker from './Picker.svelte'; mount(Picker, { target: document.body });`,
);
const html = `<!doctype html><title>Inference picker acceptance</title><script type="module" src="/@fs${directory}/main.js"></script>`;
let browser;
const server = await createServer({
	configFile: false,
	root: join(root, 'packages/app-shell'),
	cacheDir: join(evidence, 'vite-cache'),
	server: {
		host: 'localhost',
		port: 0,
		watch: null,
		hmr: false,
		fs: { allow: [root] },
	},
	plugins: [
		svelte({ configFile: false }),
		{
			name: 'picker-acceptance',
			configureServer(vite) {
				vite.middlewares.use((req, res, next) => {
					if (req.url === '/') {
						res.setHeader('content-type', 'text/html');
						res.end(html);
						return;
					}
					const failure = /^\/errors\/(401|403|429|malformed)\/v1\/models$/.exec(req.url);
					if (failure) {
						res.setHeader('content-type', 'application/json');
						res.statusCode = failure[1] === 'malformed' ? 200 : Number(failure[1]);
						res.end(JSON.stringify(failure[1] === 'malformed'
							? { data: [{ id: 123 }] }
							: { error: { message: 'Fixture rejection' } }));
						return;
					}
					if (req.url === '/models/v1/models') {
						requests.push(req.headers.authorization ?? null);
						res.setHeader('content-type', 'application/json');
						res.end(JSON.stringify({ data: [{ id: 'discovered-model' }] }));
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
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(origin);
	await page.waitForFunction(() => window.acceptance);
	const id = await page.evaluate(async () =>
		window.acceptance.add({
			name: 'Shared endpoint',
			baseUrl: location.origin + '/models/v1',
			apiKey: 'saved-key',
			models: ['manual-model'],
		}),
	);
	assert.equal(
		await page.evaluate(
			(id) =>
				window.acceptance.records().find((entry) => entry.id === id).apiKey,
			id,
		),
		undefined,
	);
	await page.locator('button[role="combobox"]').click();
	await page
		.getByText('Edit Shared endpoint or enter a model', { exact: true })
		.click();
	await page.getByLabel('Model ID', { exact: true }).fill('chosen-model');
	await page.waitForFunction(() =>
		document.body.textContent.includes('discovered-model'),
	);
	assert.ok(requests.includes('Bearer saved-key'));
	await page.getByLabel('Name', { exact: true }).fill('Renamed endpoint');
	await page.evaluate(() => window.acceptance.block());
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.getByRole('button', { name: 'Saving...', exact: true }).waitFor();
	assert.equal(await page.evaluate(() => window.acceptance.selected()), null);
	assert.equal(
		await page.evaluate(
			(id) => window.acceptance.records().find((entry) => entry.id === id).name,
			id,
		),
		'Shared endpoint',
	);
	await page.evaluate(() => window.acceptance.release());
	await page.waitForFunction(
		() => window.acceptance.selected()?.model === 'chosen-model',
	);
	assert.equal(
		await page.evaluate((id) => window.acceptance.key(id), id),
		'saved-key',
	);
	await page.locator('button[role="combobox"]').click();
	await page
		.getByText('Edit Renamed endpoint or enter a model', { exact: true })
		.click();
	await page.getByLabel('Model ID', { exact: true }).fill('after-failure');
	await page.evaluate(() => window.acceptance.fail(true));
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.getByRole('alert').waitFor();
	assert.equal(
		await page.evaluate(() => window.acceptance.selected().model),
		'chosen-model',
	);
	await page.evaluate(() => window.acceptance.fail(false));
	await page
		.getByRole('button', { name: 'Remove saved API key', exact: true })
		.click();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.waitForFunction(
		() => window.acceptance.selected()?.model === 'after-failure',
	);
	assert.equal(await page.evaluate((id) => window.acceptance.key(id), id), '');
	const second = await context.newPage();
	second.on('pageerror', (error) => errors.push(error.message));
	await second.goto(origin);
	await second.waitForFunction(() => window.acceptance);
	await second.evaluate(
		(id) => window.acceptance.update(id, { name: 'Changed in another window' }),
		id,
	);
	await page.locator('button[role="combobox"]').click();
	await page
		.getByText('Edit Changed in another window or enter a model', {
			exact: true,
		})
		.click();
	await page.getByLabel('Model ID', { exact: true }).fill('discarded-model');
	await page.evaluate(() => window.acceptance.block());
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.getByRole('button', { name: 'Saving...', exact: true }).waitFor();
	await page.evaluate(() => window.acceptance.hide());
	await page.evaluate(() => window.acceptance.release());
	await page.waitForFunction(
		(id) =>
			window.acceptance
				.records()
				.find((entry) => entry.id === id)
				.models.includes('discarded-model'),
		id,
	);
	assert.equal(
		await page.evaluate(() => window.acceptance.selected().model),
		'after-failure',
	);
	await page.evaluate(() => window.acceptance.show());
	for (const [failure, message] of [
		['401', 'The endpoint rejected this API key.'],
		['403', 'The endpoint rejected this API key.'],
		['429', 'The endpoint returned 429.'],
		['malformed', "This endpoint didn't return an OpenAI model list."],
	]) {
		await page.evaluate(failure => window.acceptance.add({
			name: `Failure ${failure}`,
			baseUrl: `${location.origin}/errors/${failure}/v1`,
			models: [],
		}), failure);
		await page.locator('button[role="combobox"]').click();
		await page.getByText(`Edit Failure ${failure} or enter a model`, { exact: true }).click();
		await page.getByText(message, { exact: false }).waitFor();
		assert.equal(await page.evaluate(() => window.acceptance.selected().model), 'after-failure');
		await page.keyboard.press('Escape');
	}
	assert.deepEqual(errors, []);
	await writeFile(
		join(evidence, 'result.json'),
		JSON.stringify(
			{
				passed: true,
				cases: [
					'awaited save',
					'hidden key retained',
					'failed save preserves selection',
					'explicit key removal',
					'cross-window observation',
					'destroyed picker suppresses selection',
					'SDK 401/403 identify rejected keys, 429 preserves status, malformed suggestions preserve selection',
				],
			},
			null,
			2,
		),
	);
	console.log('Inference picker browser acceptance passed: ' + evidence);
} finally {
	await browser?.close();
	await server.close();
	await rm(directory, { recursive: true, force: true });
}
