import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');
const req = createRequire(join(root, 'packages/app/package.json'));
const appReq = createRequire(join(root, 'apps/whispering/package.json'));
const { chromium, webkit } = await import(req.resolve('playwright'));
const { createServer } = await import(req.resolve('vite'));
const { svelte } = await import(appReq.resolve('@sveltejs/vite-plugin-svelte'));
const directory = await mkdtemp(join(root, 'apps/whispering/.audio-review-'));
await writeFile(
	join(directory, 'Test.svelte'),
	`<script>
import { tick } from 'svelte';
import AudioBlobPlayer from '../src/lib/components/AudioBlobPlayer.svelte';
import { setWhisperingContext } from '../src/lib/whispering/context';
import { fromData } from '/@fs${root}/packages/svelte/src/from-data.svelte.ts';
import { fromData } from '/@fs${root}/packages/svelte/src/from-data.svelte.ts';
let enabled = $state(true);
let row = { id: 'recording', audioBlobId: 'first', audioUrl: null, title: '', transcript: '' };
const listeners = new Set();
const table = {
	ids: () => [row.id],
	get: () => row,
	get rows() { return [row]; },
	nonconforming: [],
	subscribe(listener) {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};
const library = fromData({
	tables: { recordings: table },
	kv: { get() {}, nonconforming: [], subscribe() { return () => {}; } },
	persistence: { get() { return 'saved'; }, subscribe() { return () => {}; } },
});
const opened = [];
const disposed = [];
function store(initial) {
	let value = initial;
	const subscribers = new Set();
	return {
		tables: {},
		kv: {
			get() { return value; },
			update(fields) { value = fields.value; for (const subscriber of subscribers) subscriber(); },
			subscribe(subscriber) { subscribers.add(subscriber); return () => subscribers.delete(subscriber); },
			nonconforming: [],
		},
		persistence: { get() { return 'saved'; }, subscribe() { return () => {}; } },
	};
}
const raw = { device: store('device'), account: { personal: store('personal') } };
const app = {...raw, local:fromData(raw.device), localBlobs:raw.blobs.local, remoteBlobs:raw.blobs.remote};
let release;
setWhisperingContext({
	app: {
		library,
		blobs: {
			local: {
				async open(id) {
					opened.push(id);
					if (id === 'late') await new Promise(resolve => { release = resolve; });
					return {
						data: {
							url: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=',
							[Symbol.dispose]() { disposed.push(id); },
						},
						error: null,
					};
				},
			},
			remote: null,
		},
	},
});
window.acceptance = {
	async editStores() {
		app.local.kv.update({ value: 'device edited' });
		raw.account.personal.kv.update({ value: 'personal synced' });
		await tick();
	},
	snapshot: () => ({ opened: [...opened], disposed: [...disposed] }),
	async enable(value) {
		enabled = value;
		await tick();
		await tick();
		return this.snapshot();
	},
	async release() {
		release();
		await tick();
		await tick();
		return this.snapshot();
	},
	async patch(fields) {
		row = { ...row, ...fields };
		for (const listener of listeners) listener([row.id]);
		await tick();
		await tick();
		return this.snapshot();
	},
};
</script>
<p id="device-setting">{app.local.kv.get('value')}</p>
<p id="personal-setting">{app.account.personal.kv.get('value')}</p>
<AudioBlobPlayer id="recording" {enabled} />`,
);
await writeFile(
	join(directory, 'main.js'),
	"import {mount} from 'svelte';import Test from './Test.svelte';mount(Test,{target:document.body});",
);
const server = await createServer({
	configFile: false,
	root: join(root, 'apps/whispering'),
	logLevel: 'error',
	optimizeDeps: { entries: [join(directory, 'main.js')] },
	resolve: { alias: { $lib: join(root, 'apps/whispering/src/lib') } },
	server: { host: 'localhost', port: 0, watch: null },
	plugins: [
		svelte({ configFile: false }),
		{
			name: 'audio-review',
			configureServer(v) {
				v.middlewares.use((req, res, next) => {
					if (req.url !== '/') return next();
					res.setHeader('content-type', 'text/html');
					res.end(
						'<!doctype html><script type="module" src="/@fs' +
							directory +
							'/main.js"></script>',
					);
				});
			},
		},
	],
});
let browser;
try {
	await server.listen();
	for (const engine of [chromium, webkit]) {
		browser = await engine.launch({ headless: true });
		const page = await browser.newPage();
		const errors = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(server.resolvedUrls.local[0]);
		await page.waitForFunction(
			() => window.acceptance?.snapshot().opened.length === 1,
		);
		assert.equal(await page.locator('#device-setting').textContent(), 'device');
		assert.equal(
			await page.locator('#personal-setting').textContent(),
			'personal',
		);
		await page.evaluate(() => window.acceptance.editStores());
		assert.equal(
			await page.locator('#device-setting').textContent(),
			'device edited',
		);
		assert.equal(
			await page.locator('#personal-setting').textContent(),
			'personal synced',
		);
		assert.deepEqual(
			await page.evaluate(() =>
				window.acceptance.patch({ transcript: 'edited', title: 'renamed' }),
			),
			{
				opened: ['first'],
				disposed: [],
			},
			'metadata edits must preserve playback',
		);
		assert.deepEqual(
			await page.evaluate(() =>
				window.acceptance.patch({ audioBlobId: 'second' }),
			),
			{
				opened: ['first', 'second'],
				disposed: ['first'],
			},
			'new audio must dispose the old source once',
		);
		assert.deepEqual(
			await page.evaluate(() => window.acceptance.enable(false)),
			{
				opened: ['first', 'second'],
				disposed: ['first', 'second'],
			},
			'disabling playback must release its source',
		);
		await page.evaluate(() => window.acceptance.patch({ audioBlobId: 'late' }));
		await page.evaluate(() => window.acceptance.enable(true));
		await page.evaluate(() => window.acceptance.enable(false));
		assert.deepEqual(
			await page.evaluate(() => window.acceptance.release()),
			{
				opened: ['first', 'second', 'late'],
				disposed: ['first', 'second', 'late'],
			},
			'a source acquired after teardown must be released',
		);
		assert.deepEqual(errors, []);
		console.log(
			engine.name() +
				': both reactive stores, playback identity and disposal passed',
		);
		await browser.close();
		browser = undefined;
	}
} finally {
	await browser?.close();
	await server.close();
	await rm(directory, { recursive: true, force: true });
}
