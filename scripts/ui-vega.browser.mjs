import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const req = createRequire(`${root}/packages/ui/package.json`);
const { chromium } = await import(req.resolve('playwright'));
const { createServer } = await import(req.resolve('vite'));
const { svelte } = await import(req.resolve('@sveltejs/vite-plugin-svelte'));
const { default: tailwind } = await import(req.resolve('@tailwindcss/vite'));
const dir = await mkdtemp(`${root}/packages/ui/.browser-migration-`);
const out = await mkdtemp(join(tmpdir(), 'epicenter-ui-migration-'));
await writeFile(
	`${dir}/index.html`,
	'<!doctype html><html lang="en" class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>',
);
await writeFile(
	`${dir}/main.js`,
	"import {mount} from 'svelte';import App from './App.svelte';import '@epicenter/ui/app.css';mount(App,{target:document.getElementById('app')});",
);
await writeFile(
	`${dir}/App.svelte`,
	`<script>
	import { Button } from '@epicenter/ui/button';
	import { Link } from '@epicenter/ui/link';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import * as Popover from '@epicenter/ui/popover';
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Modal from '@epicenter/ui/modal';

	let opens = $state(0);
	let submits = $state(0);
	let dialogOpen = $state(false);
	let modalOpen = $state(false);
</script>

<Tooltip.Provider>
	<main class="space-y-4 p-6">
		<form onsubmit={(event) => { event.preventDefault(); submits++; }}>
			<Button data-testid="submit" type="submit" tooltip="Submit">Submit</Button>
			<Button data-testid="disabled-button" disabled tooltip="Disabled" onclick={() => opens++}>Disabled</Button>
			<Button data-testid="combobox-button" role="combobox" tabindex={-1} tooltip="Choose">Choose</Button>
		</form>
		<Button data-testid="disabled-anchor" href="#danger" disabled tooltip="Unavailable">Unavailable</Button>
		<Button data-testid="custom-anchor" href="#custom" role="menuitem" tabindex={3} tooltip="Custom">Custom</Button>
		<Link data-testid="custom-link" href="#link" role="menuitem" tabindex={4} tooltip="Link">Link</Link>

		<Popover.Root onOpenChange={(open) => { if (open) opens++; }}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button data-testid="popover-button" {...props} tooltip="Popover">Popover</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content>Popover content</Popover.Content>
		</Popover.Root>

		<Dialog.Root bind:open={dialogOpen}>
			<Dialog.Trigger>
				{#snippet child({ props })}<Button {...props}>Open dialog</Button>{/snippet}
			</Dialog.Trigger>
			<Dialog.Content class="max-w-sm sm:max-w-sm">
				<Dialog.Title>Dialog title</Dialog.Title>
				<div style="height:1200px">Long dialog body</div>
			</Dialog.Content>
		</Dialog.Root>

		<Modal.Root bind:open={modalOpen}>
			<Modal.Trigger>
				{#snippet child({ props })}<Button {...props}>Open modal</Button>{/snippet}
			</Modal.Trigger>
			<Modal.Content class="sm:max-w-2xl">
				<Modal.Title>Mobile title</Modal.Title>
				<div style="height:1000px">Long mobile body</div>
			</Modal.Content>
		</Modal.Root>
		<p data-testid="counts">{opens}:{submits}</p>
	</main>
</Tooltip.Provider>`,
);
let server, browser;
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
	const url = server.resolvedUrls.local[0];
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1280, height: 900 },
	});
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto(url);
	await page.getByTestId('submit').waitFor();
	await page.getByTestId('disabled-button').click({ force: true });
	assert.equal(await page.getByTestId('disabled-button').isDisabled(), true);
	assert.equal(
		await page.getByTestId('combobox-button').getAttribute('role'),
		'combobox',
	);
	assert.equal(
		await page.getByTestId('combobox-button').getAttribute('tabindex'),
		'-1',
	);
	assert.equal(await page.getByTestId('counts').innerText(), '0:0');
	await page.getByTestId('submit').click();
	assert.equal(await page.getByTestId('counts').innerText(), '0:1');
	assert.equal(
		await page.getByTestId('disabled-anchor').getAttribute('tabindex'),
		'-1',
	);
	assert.equal(
		await page.getByTestId('disabled-anchor').getAttribute('href'),
		null,
	);
	assert.equal(
		await page.getByTestId('custom-anchor').getAttribute('role'),
		'menuitem',
	);
	assert.equal(
		await page.getByTestId('custom-anchor').getAttribute('tabindex'),
		'3',
	);
	assert.equal(
		await page.getByTestId('custom-link').getAttribute('role'),
		'menuitem',
	);
	assert.equal(
		await page.getByTestId('custom-link').getAttribute('tabindex'),
		'4',
	);
	await page.getByTestId('popover-button').hover();
	await page
		.locator('[data-slot="tooltip-content"]')
		.filter({ hasText: 'Popover' })
		.waitFor();
	await page.getByTestId('popover-button').click();
	await page.getByText('Popover content').waitFor();
	assert.equal(await page.getByTestId('counts').innerText(), '1:1');
	await page.keyboard.press('Escape');
	await page.getByTestId('popover-button').focus();
	await page.keyboard.press('Enter');
	await page.getByText('Popover content').waitFor();
	assert.equal(await page.getByTestId('counts').innerText(), '2:1');
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Open dialog' }).click();
	const dialog = page.getByRole('dialog', { name: 'Dialog title' });
	await dialog.waitFor();
	assert.equal(
		await dialog.evaluate((el) => getComputedStyle(el).width),
		'384px',
	);
	await dialog.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	assert((await dialog.evaluate((el) => el.scrollTop)) > 0);
	await page.keyboard.press('Escape');
	await dialog.waitFor({ state: 'hidden' });
	assert.equal(
		await page.evaluate(() => document.activeElement?.textContent?.trim()),
		'Open dialog',
	);
	await page.getByRole('button', { name: 'Open modal' }).click();
	const desktopModal = page.getByRole('dialog', { name: 'Mobile title' });
	await desktopModal.waitFor();
	assert.equal(
		await desktopModal.evaluate((el) => getComputedStyle(el).maxWidth),
		'672px',
	);
	await page.screenshot({ path: join(out, 'desktop-modal.png') });
	await page.keyboard.press('Escape');
	await desktopModal.waitFor({ state: 'hidden' });
	const narrow = await browser.newPage({
		viewport: { width: 500, height: 800 },
	});
	narrow.on('pageerror', (e) => errors.push(e.message));
	await narrow.goto(url);
	await narrow.getByRole('button', { name: 'Open dialog' }).click();
	const d500 = narrow.getByRole('dialog', { name: 'Dialog title' });
	await d500.waitFor();
	assert.equal(
		await d500.evaluate((el) => getComputedStyle(el).width),
		'384px',
	);
	await narrow.screenshot({ path: join(out, 'narrow-dialog.png') });
	await narrow.keyboard.press('Escape');
	await d500.waitFor({ state: 'hidden' });
	const mobile = await browser.newPage({
		viewport: { width: 390, height: 720 },
	});
	mobile.on('pageerror', (e) => errors.push(e.message));
	await mobile.goto(url);
	await mobile.getByRole('button', { name: 'Open modal' }).click();
	const drawer = mobile.getByRole('dialog', { name: 'Mobile title' });
	await drawer.waitFor();
	await drawer.evaluate(async (el) => {
		await Promise.all(
			el.getAnimations().map((a) => a.finished.catch(() => {})),
		);
	});
	const box = await drawer.boundingBox();
	assert(box && box.width > 300);
	await mobile.screenshot({ path: join(out, 'mobile-drawer-top.png') });
	await drawer.locator('div.overflow-y-auto').evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	assert(
		(await drawer
			.locator('div.overflow-y-auto')
			.evaluate((el) => el.scrollTop)) > 0,
	);
	await mobile.screenshot({ path: join(out, 'mobile-drawer-scrolled.png') });
	await drawer.locator('div.overflow-y-auto').evaluate((el) => {
		el.scrollTop = 0;
	});
	const handle = await drawer.locator('div').first().boundingBox();
	await mobile.mouse.move(
		handle.x + handle.width / 2,
		handle.y + handle.height / 2,
	);
	await mobile.mouse.down();
	await mobile.mouse.move(
		handle.x + handle.width / 2,
		handle.y + handle.height / 2 + 240,
		{ steps: 12 },
	);
	await mobile.mouse.up();
	await drawer.waitFor({ state: 'hidden', timeout: 3000 });
	assert.equal(
		await mobile.evaluate(() => document.activeElement?.textContent?.trim()),
		'Open modal',
	);
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify(
			{
				desktopModalMaxWidth: 672,
				narrowWidth: 384,
				mobileDrawerWidth: box.width,
				errors,
				out,
			},
			null,
			2,
		),
	);
} finally {
	await browser?.close();
	await server?.close();
	await rm(dir, { recursive: true, force: true });
}
