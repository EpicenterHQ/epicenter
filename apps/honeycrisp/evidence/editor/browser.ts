/** Run with bun apps/honeycrisp/evidence/editor/browser.ts. Uses real Chromium and both Svelte editors. */
import assert from 'node:assert/strict';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
	configFile: false,
	root: new URL('../../', import.meta.url).pathname,
	plugins: [
		svelte({ configFile: false }),
		{
			name: 'editor-evidence',
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					if (req.url !== '/') return next();
					res.setHeader('Content-Type', 'text/html');
					res.end(
						'<div id="rich"></div><div id="plain"></div><div id="peer"></div>',
					);
				});
			},
		},
	],
	optimizeDeps: { entries: ['evidence/editor/main.ts'] },
	server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome' });
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(server.resolvedUrls!.local[0]!);
	const call = <T>(method: string, argument?: T) =>
		page.evaluate(
			async ({ method, argument }) => {
				const path = '/evidence/editor/main.ts';
				const fixture = await import(/* @vite-ignore */ path);
				return fixture[method](argument);
			},
			{ method, argument },
		);
	const initial = await call('snapshot');
	assert.equal(initial.text, '');
	assert.equal(initial.stable, true);
	assert.equal(initial.emptyBody, true);
	assert.equal(initial.emptyPeer, true);
	assert.equal(initial.peerWrites, 0);
	assert.equal(initial.bodyEvents, 0);
	const rich = page.locator('#rich .ProseMirror');
	await rich.click();
	await page.keyboard.type('Hello');
	const typed = await call('snapshot');
	assert.equal(typed.text, 'Hello');
	assert.equal(typed.tableEvents, initial.tableEvents);
	assert.ok(typed.bodyEvents > initial.bodyEvents);
	assert.deepEqual(typed.fields, initial.fields);
	await call('remoteMetadata');
	const metadata = await call('snapshot');
	assert.equal(metadata.bodyEvents, typed.bodyEvents);
	assert.equal(metadata.fields.title, 'Remote title');
	await page.keyboard.press('ControlOrMeta+z');
	assert.equal((await call('snapshot')).text, '');
	assert.equal((await call('snapshot')).emptyBody, true);
	await page.keyboard.press('ControlOrMeta+y');
	assert.equal((await call('snapshot')).text, 'Hello');
	await page.keyboard.press('ControlOrMeta+z');
	await page.keyboard.type('Different');
	assert.equal((await call('snapshot')).text, 'Different');
	await call('rewrite', '# Rewritten\n\nSecond paragraph');
	assert.equal((await call('snapshot')).text, 'RewrittenSecond paragraph');
	await page.keyboard.press('ControlOrMeta+z');
	assert.equal((await call('snapshot')).text, 'RewrittenSecond paragraph');
	await call('rewrite', '');
	assert.equal((await call('snapshot')).text, '');
	await rich.click();
	await page.keyboard.type('After rewrite');
	assert.equal((await call('snapshot')).text, 'After rewrite');
	await page.keyboard.press('ControlOrMeta+z');
	assert.equal((await call('snapshot')).text, '');
	await page.keyboard.press('ControlOrMeta+y');
	assert.equal((await call('snapshot')).text, 'After rewrite');
	await call('remoteBody');
	assert.equal((await call('snapshot')).text, 'Remote writing');
	await page.keyboard.press('ControlOrMeta+z');
	assert.equal((await call('snapshot')).text, 'Remote writing');
	const plain = page.locator('.cm-content');
	await plain.click();
	await page.keyboard.type('Instructions');
	assert.equal((await call('snapshot')).plain, 'Instructions');
	await call('plainMetadata');
	assert.equal(await plain.innerText(), 'Instructions');
	const final = await call('snapshot');
	assert.equal(final.stable, true);
	assert.equal(final.fields.body, 'metadata');
	assert.equal(final.fields.content, 'ordinary');
	assert.equal(final.fields['!status'], 'draft');
	const reopened = await call('reopen');
	assert.equal(reopened.text, 'Remote writing');
	assert.equal(reopened.soleChild, true);
	assert.deepEqual(reopened.fields, final.fields);
	assert.equal(reopened.plain, 'Instructions');
	assert.deepEqual(errors, []);
	console.log(
		'PASS: real Svelte ProseMirror and CodeMirror editors, empty initialization, typing, metadata isolation, undo/redo, bound rewrite, remote edits, stable child, IndexedDB reopen, remote deletion',
	);
} finally {
	await browser.close();
	await server.close();
}
