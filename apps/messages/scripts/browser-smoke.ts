/** Real Chromium, isolated storage, fictional conversations only. All other HTTP origins are blocked. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const probe = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch: () => new Response(),
});
const origin = `http://127.0.0.1:${probe.port}`;
await probe.stop(true);
const logs: string[] = [];
const server = spawn(
	process.execPath,
	[
		'run',
		'--cwd',
		'apps/messages',
		'dev',
		'--host',
		'127.0.0.1',
		'--port',
		new URL(origin).port,
	],
	{
		cwd: join(import.meta.dir, '../../..'),
		detached: true,
		env: {
			...process.env,
			PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	},
);
server.stdout.on('data', (chunk) => logs.push(String(chunk)));
server.stderr.on('data', (chunk) => logs.push(String(chunk)));
const browser = await chromium.launch({ headless: true });
const artifacts = await mkdtemp(join(tmpdir(), 'epicenter-messages-smoke-'));
try {
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		try {
			if ((await fetch(origin, { signal: AbortSignal.timeout(500) })).ok) {
				ready = true;
				break;
			}
		} catch {}
		await Bun.sleep(200);
	}
	assert(ready, logs.join(''));
	const context = await browser.newContext({
		viewport: { width: 1200, height: 800 },
	});
	const unexpected: string[] = [];
	await context.route('**/*', (route) => {
		const url = new URL(route.request().url());
		if (
			(url.protocol === 'http:' || url.protocol === 'https:') &&
			url.origin !== origin
		) {
			unexpected.push(url.origin);
			return route.abort();
		}
		return route.continue();
	});
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(origin);
	await page.getByRole('button', { name: /Maya Chen/ }).click();
	await page
		.getByLabel('Message', { exact: true })
		.fill('A fictional draft kept through reload.');
	await page
		.getByRole('button', { name: /Maya Chen/ })
		.getByText('Draft: A fictional draft kept through reload.')
		.waitFor();
	await page.reload();
	await page.getByRole('button', { name: /Maya Chen/ }).click();
	assert.equal(
		await page.getByLabel('Message', { exact: true }).inputValue(),
		'A fictional draft kept through reload.',
	);
	await page
		.getByRole('button', { name: 'Send demo reply', exact: true })
		.click();
	await page.getByText('Demo message sent.', { exact: true }).waitFor();
	await page
		.getByRole('list', { name: 'Messages', exact: true })
		.getByText('A fictional draft kept through reload.', { exact: true })
		.waitFor();
	assert.equal(
		await page.getByLabel('Message', { exact: true }).inputValue(),
		'',
	);
	await page
		.getByRole('button', { name: 'Simulate incoming', exact: true })
		.click();
	await page
		.getByRole('list', { name: 'Messages', exact: true })
		.getByText('Demo incoming message: Saturday at ten works for me.', {
			exact: true,
		})
		.waitFor();
	await page
		.getByLabel('Message', { exact: true })
		.fill('Keep this after an uncertain send.');
	await page
		.getByRole('button', { name: 'Simulate send failure', exact: true })
		.click();
	await page
		.getByRole('button', { name: 'Send demo reply', exact: true })
		.click();
	await page
		.getByRole('button', { name: 'I checked: keep as draft', exact: true })
		.waitFor();
	await page.reload();
	await page.getByRole('button', { name: /Maya Chen/ }).click();
	await page
		.getByRole('button', { name: 'I checked: keep as draft', exact: true })
		.waitFor();
	assert.equal(
		await page
			.getByRole('button', { name: 'Send demo reply', exact: true })
			.isDisabled(),
		true,
	);
	await page.screenshot({ path: join(artifacts, 'desktop.png') });
	await page
		.getByRole('button', { name: 'I checked: keep as draft', exact: true })
		.click();
	await page
		.getByRole('button', { name: /Maya Chen/ })
		.getByText('Draft: Keep this after an uncertain send.')
		.waitFor();
	assert.equal(
		await page.getByLabel('Message', { exact: true }).inputValue(),
		'Keep this after an uncertain send.',
	);
	await page.getByRole('button', { name: /Community garden/ }).click();
	const photo = page.getByRole('button', {
		name: 'View photo: Seedlings ready to collect',
		exact: true,
	});
	await photo
		.getByRole('img')
		.evaluate((image: HTMLImageElement) => image.decode());
	await page.getByLabel('Message', { exact: true }).waitFor();
	await page.screenshot({ path: join(artifacts, 'photo-conversation.png') });
	await photo.click();
	const viewer = page.getByRole('dialog', {
		name: 'Seedlings ready to collect',
		exact: true,
	});
	await viewer.waitFor();
	assert(
		await viewer
			.getByRole('img')
			.evaluate((image: HTMLImageElement) => image.naturalWidth > 0),
	);
	await page.screenshot({
		path: join(artifacts, 'photo-viewer.png'),
		animations: 'disabled',
	});
	await page.keyboard.press('Escape');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await page
		.getByLabel('Filter conversations', { exact: true })
		.fill('Nobody matches');
	await page
		.getByText('No matching conversations in the loaded chats.', {
			exact: true,
		})
		.waitFor();
	await page.getByLabel('Filter conversations', { exact: true }).fill('Noah');
	await page.getByRole('button', { name: /Noah Patel/ }).click();
	await page.getByText('Weekend route.txt', { exact: true }).waitFor();
	const download = page.waitForEvent('download');
	await page
		.getByRole('link', { name: 'Download sample file', exact: true })
		.click();
	const file = await download;
	assert.equal(file.suggestedFilename(), 'weekend-route.txt');
	const downloadedPath = await file.path();
	assert(downloadedPath);
	assert(
		(await Bun.file(downloadedPath).text()).includes(
			'This file is sample data',
		),
	);
	await page.getByLabel('Message', { exact: true }).waitFor();
	await page.screenshot({ path: join(artifacts, 'mobile.png') });
	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth > innerWidth,
		),
		false,
	);
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await page.getByLabel('Filter conversations', { exact: true }).fill('garden');
	await page.getByRole('button', { name: /Community garden/ }).click();
	await page
		.getByRole('button', {
			name: 'View photo: Seedlings ready to collect',
			exact: true,
		})
		.click();
	await viewer.waitFor();
	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth > innerWidth,
		),
		false,
	);
	await page.screenshot({
		path: join(artifacts, 'mobile-photo-viewer.png'),
		animations: 'disabled',
	});
	await page.keyboard.press('Escape');
	assert.deepEqual(unexpected, []);
	assert.deepEqual(errors, []);
	console.log(`Messages browser checks passed. Screenshots: ${artifacts}`);
} finally {
	await browser.close();
	if (server.pid) process.kill(-server.pid, 'SIGTERM');
}
