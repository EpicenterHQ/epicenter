/**
 * Browser regressions for chat scroll resource cleanup, reading position,
 * streamed text, and long folder submenus. Run from the repo root:
 * bun scripts/ui-scroll.browser.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd(),
	req = createRequire(`${root}/packages/app/package.json`),
	appReq = createRequire(`${root}/apps/whispering/package.json`);
const { chromium } = await import(req.resolve('playwright'));
const { createServer } = await import(req.resolve('vite'));
const { svelte } = await import(appReq.resolve('@sveltejs/vite-plugin-svelte'));
const { default: tailwind } = await import(appReq.resolve('@tailwindcss/vite'));
const dir = await mkdtemp(`${root}/packages/ui/.browser-scroll-`),
	out = await mkdtemp(join(tmpdir(), 'epicenter-ui-scroll-'));
await writeFile(
	`${dir}/index.html`,
	'<!doctype html><html lang="en" class="style-vega dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>',
);
await writeFile(
	`${dir}/main.js`,
	"import {mount} from 'svelte';import App from './App.svelte';import '@epicenter/ui/app.css';mount(App,{target:document.getElementById('app')});",
);
await writeFile(
	`${dir}/App.svelte`,
	`<script>
import * as Chat from '@epicenter/ui/chat';
import * as Menu from '@epicenter/ui/context-menu';
import {Button} from '@epicenter/ui/button';
let visible=$state(false),count=$state(30),chosen=$state('none'),text=$state('Streaming message');
</script>
<main style="padding:24px;max-width:760px;margin:auto;display:flex;flex-direction:column;gap:16px">
<h1 style="font-size:24px;font-weight:600">Chat scrolling and folder menus</h1>
<div><Button onclick={()=>visible=!visible}>Toggle chat</Button> <Button onclick={()=>count++}>Append message</Button> <Button onclick={()=>text+=' More streaming text.'.repeat(30)}>Stream text</Button></div>
<div style="height:200px">{#if visible}<Chat.List data-testid="chat">{#each Array.from({length:count},(_,i)=>i+1) as n}<p style="flex-shrink:0">Message {n}</p>{/each}<p style="flex-shrink:0">{text}</p></Chat.List>{/if}</div>
<Menu.Root onOpenChange={(open)=>{if(open)chosen='none'}}><Menu.Trigger data-testid="note" style="display:block;padding:16px;border:1px solid var(--border)">Right-click this note to move it</Menu.Trigger><Menu.Content><Menu.Sub><Menu.SubTrigger>Move to Folder</Menu.SubTrigger><Menu.SubContent class="w-48">{#each Array.from({length:60},(_,i)=>'Folder '+String(i+1).padStart(2,'0')) as folder}<Menu.Item onclick={()=>chosen=folder}>{folder}</Menu.Item>{/each}</Menu.SubContent></Menu.Sub></Menu.Content></Menu.Root>
<p id="chosen">Selected: {chosen}</p>
</main>`,
);
let server, browser;
const report = { cycles: [] },
	errors = [];
try {
	server = await createServer({
		configFile: false,
		root: dir,
		plugins: [svelte(), tailwind()],
		server: {
			host: '127.0.0.1',
			port: 0,
			strictPort: true,
			fs: { allow: [root] },
		},
	});
	await server.listen();
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 900, height: 600 },
		deviceScaleFactor: 2,
	});
	page.on('pageerror', (e) => errors.push(e.message));
	await page.addInitScript(() => {
		const listeners = new Set(),
			observers = new Set();
		const add = window.addEventListener,
			remove = window.removeEventListener;
		window.addEventListener = function (type, fn, ...rest) {
			if (type === 'resize') listeners.add(fn);
			return add.call(this, type, fn, ...rest);
		};
		window.removeEventListener = function (type, fn, ...rest) {
			if (type === 'resize') listeners.delete(fn);
			return remove.call(this, type, fn, ...rest);
		};
		const Original = window.MutationObserver;
		window.MutationObserver = class extends Original {
			observe(target, options) {
				if (
					target instanceof Element &&
					target.getAttribute('data-testid') === 'chat'
				)
					observers.add(this);
				return super.observe(target, options);
			}
			disconnect() {
				observers.delete(this);
				return super.disconnect();
			}
		};
		window.scrollResources = () => ({
			resize: listeners.size,
			observers: observers.size,
		});
	});
	await page.goto(server.resolvedUrls.local[0]);
	await page.getByRole('button', { name: 'Toggle chat' }).waitFor();
	const initial = await page.evaluate(() => window.scrollResources());
	for (let i = 0; i < 4; i++) {
		await page.getByRole('button', { name: 'Toggle chat' }).click();
		await page.getByTestId('chat').waitFor();
		await page.getByRole('button', { name: 'Toggle chat' }).click();
		await page.getByTestId('chat').waitFor({ state: 'detached' });
		const counts = await page.evaluate(() => window.scrollResources());
		report.cycles.push(counts);
		assert.deepEqual(counts, initial);
	}
	await page.getByRole('button', { name: 'Toggle chat' }).click();
	const chat = page.getByTestId('chat');
	await chat.waitFor();
	await page.waitForTimeout(100);
	const atBottom = () =>
		chat.evaluate((e) => e.scrollTop + e.clientHeight >= e.scrollHeight - 2);
	assert(await atBottom());
	await page
		.getByRole('button', { name: 'Append message', exact: true })
		.click();
	await page.waitForTimeout(100);
	report.followsNewMessage = await atBottom();
	assert(report.followsNewMessage);
	for (let update = 0; update < 5; update++) {
		await page
			.getByRole('button', { name: 'Stream text', exact: true })
			.click();
		await page.waitForTimeout(25);
	}
	await page.waitForTimeout(100);
	report.followsStreamingText = await atBottom();
	assert(report.followsStreamingText);
	await chat.evaluate((e) => e.scrollTo({ top: 100, behavior: 'instant' }));
	await page.waitForTimeout(100);
	const previous = await chat.evaluate((e) => e.scrollTop);
	await page
		.getByRole('button', { name: 'Append message', exact: true })
		.click();
	await page.getByRole('button', { name: 'Stream text', exact: true }).click();
	await page.waitForTimeout(100);
	report.readingPositionPreserved =
		(await chat.evaluate((e) => e.scrollTop)) === previous;
	assert(report.readingPositionPreserved);
	await page.screenshot({ path: `${out}/chat-reading-history.png` });
	await page.evaluate(() => {
		document
			.querySelector('button[aria-label="Scroll to latest message"]')
			.click();
		[...document.querySelectorAll('button')]
			.find((button) => button.textContent === 'Stream text')
			.click();
	});
	await page.waitForTimeout(100);
	assert(
		await atBottom(),
		'A same-turn text update after jumping must follow the new bottom',
	);
	for (let update = 0; update < 5; update++) {
		await page
			.getByRole('button', { name: 'Stream text', exact: true })
			.click();
		await page.waitForTimeout(25);
	}
	await page.waitForTimeout(100);
	assert(await atBottom());
	await page.getByRole('button', { name: 'Toggle chat' }).click();
	for (const size of [
		{ width: 900, height: 600 },
		{ width: 390, height: 520 },
	]) {
		await page.setViewportSize(size);
		await page.getByTestId('note').click({ button: 'right' });
		const trigger = page.getByRole('menuitem', { name: 'Move to Folder' });
		await page.mouse.move(0, 0);
		await trigger.focus();
		await page.keyboard.press('ArrowRight');
		const sub = page.locator('[data-slot="context-menu-sub-content"]');
		await sub.waitFor();
		await page.waitForTimeout(150);
		const box = await sub.boundingBox();
		report[`submenu${size.width}`] = { box, viewport: size };
		assert(box.y >= -1 && box.y + box.height <= size.height + 1);
		await page.keyboard.press('End');
		await page.waitForTimeout(100);
		{
			const last = await page
				.getByRole('menuitem', { name: 'Folder 60', exact: true })
				.boundingBox();
			assert(last.y >= box.y && last.y + last.height <= box.y + box.height + 1);
		}
		assert(
			await page
				.getByRole('menuitem', { name: 'Folder 60', exact: true })
				.evaluate((e) => {
					const r = e.getBoundingClientRect();
					return e.contains(
						document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
					);
				}),
			'Last folder must be visible outside the parent menu clipping region',
		);
		await page.screenshot({ path: `${out}/submenu-${size.width}.png` });
		await page.keyboard.press('Enter');
		await page.waitForTimeout(100);
		assert.match(await page.locator('#chosen').innerText(), /Folder 60/);
	}
	assert.deepEqual(errors, []);
	report.errors = errors;
	await writeFile(`${out}/results.json`, JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
	console.log('Evidence:', out);
} finally {
	await browser?.close();
	await server?.close();
	await rm(dir, { recursive: true, force: true });
}
