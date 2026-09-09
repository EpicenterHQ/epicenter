/**
 * Prove cache retirement against native IndexedDB in Chromium and WebKit.
 * Run from repo root: bun packages/data/evidence/browser/current-cache.ts [--webkit]
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { build } from 'vite';
import type { CacheProbe } from './current-cache/main.js';

declare global {
	interface Window {
		probe: CacheProbe;
	}
}
const engine = process.argv.includes('--webkit') ? webkit : chromium;
const directory = mkdtempSync(join(tmpdir(), 'current-cache-proof-'));
let checks = 0;
await build({
	root: new URL('./current-cache/', import.meta.url).pathname,
	logLevel: 'warn',
	build: {
		target: 'esnext',
		outDir: join(directory, 'dist'),
		emptyOutDir: true,
	},
});
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		return new Response(
			Bun.file(join(directory, 'dist', path === '/' ? 'index.html' : path)),
		);
	},
});
const browser = await engine.launchPersistentContext(
	join(directory, 'profile'),
);
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (error) => {
		errors.push(error.message);
		console.error(error);
	});
	page.on('console', (message) => {
		if (message.type() === 'error') console.error(message.text());
	});
	await page.goto(`http://localhost:${server.port}`);
	await page.waitForFunction(() => !!window.probe);
	async function reload() {
		await page.reload();
		await page.waitForFunction(() => !!window.probe);
		return await page.evaluate(() => window.probe.open());
	}
	assert.equal(await page.evaluate(() => window.probe.open()), null);
	checks++;
	await page.evaluate(() => window.probe.install());
	await page.evaluate(() => window.probe.append());
	const cached = await reload();
	assert.deepEqual(
		cached && {
			generation: cached.generation,
			cursor: cached.cursor,
			rows: cached.rows,
			outbox: cached.outbox,
		},
		{ generation: 1, cursor: 7, rows: 2, outbox: 1 },
	);
	checks++;
	assert.equal(await page.evaluate(() => window.probe.installRefused()), true);
	checks++;
	// The raw connection stays open through successful invalidation.
	await page.evaluate(async () => {
		await window.probe.openRaw();
		window.probe.pauseNextTransaction();
		window.probe.startAppend();
	});
	const fenced = await page.evaluate(() => window.probe.startDiscard());
	assert.deepEqual(fenced, {
		same: true,
		lateCommitRefused: true,
		lateInstallRefused: true,
	});
	checks++;
	assert.equal(await page.evaluate(() => window.probe.settled()), false);
	checks++;
	assert.equal(await page.evaluate(() => window.probe.release()), 'ok');
	checks++;
	assert.deepEqual(await page.evaluate(() => window.probe.rawState()), {
		generation: null,
		rows: 0,
	});
	checks++;
	assert.equal(await reload(), null);
	checks++;
	await page.evaluate(() => window.probe.install(2));
	await page.evaluate(() => window.probe.abortNext('header', 'clear'));
	assert.equal(await page.evaluate(() => window.probe.discard()), true);
	checks++;
	assert.equal(await page.evaluate(() => window.probe.appendRefused()), true);
	checks++;
	assert.equal(await page.evaluate(() => window.probe.installRefused()), true);
	checks++;
	await page.evaluate(() => window.probe.openRaw());
	assert.deepEqual(await page.evaluate(() => window.probe.rawState()), {
		generation: 2,
		rows: 1,
	});
	checks++;
	assert.equal(await page.evaluate(() => window.probe.discard()), false);
	checks++;
	assert.equal(await reload(), null);
	checks++;
	await page.evaluate(() => window.probe.abortNext('header', 'put'));
	assert.equal(await page.evaluate(() => window.probe.installRefused()), true);
	checks++;
	assert.equal(await reload(), null);
	checks++;
	const installedBytes = await page.evaluate(() => window.probe.install(3));
	const installed = await reload();
	assert.deepEqual(
		installed && {
			generation: installed.generation,
			cursor: installed.cursor,
			rows: installed.rows,
			outbox: installed.outbox,
		},
		{ generation: 3, cursor: 7, rows: 1, outbox: 0 },
	);
	checks++;
	assert.deepEqual(installed?.bytes, installedBytes);
	checks++;
	// Before an invalidation commits, an interrupted transaction retains a complete prior cache.
	await page.evaluate(() => window.probe.abortNext('header', 'clear'));
	assert.equal(await page.evaluate(() => window.probe.discard()), true);
	checks++;
	assert.equal((await reload())?.generation, 3);
	checks++;
	// Real document interruption while invalidation's native transaction is still active.
	await page.evaluate(() => window.probe.pauseNextTransaction());
	await page.evaluate(() => window.probe.startDiscard());
	assert.equal(await page.evaluate(() => window.probe.settled()), false);
	checks++;
	assert.equal((await reload())?.generation, 3);
	checks++;
	await page.evaluate(() => window.probe.discard());
	assert.equal(await reload(), null);
	checks++;
	// A baseline and header written by an uncommitted installation also roll back together.
	await page.evaluate(() => {
		window.probe.pauseNextTransaction();
		void window.probe.install(4).catch(() => {});
	});
	assert.equal(await reload(), null);
	checks++;

	assert.equal(
		await page.evaluate(() => window.probe.emptyInstallRefused()),
		true,
	);
	checks++;
	const expectedBytes = await page.evaluate(() =>
		window.probe.installMutableInput(),
	);
	const stableInput = await reload();
	assert.deepEqual(stableInput, {
		generation: 5,
		cursor: 9,
		rows: 1,
		outbox: 0,
		bytes: expectedBytes,
	});
	checks++;

	assert.deepEqual(errors, []);
	checks++;
	console.log(`${engine.name()}: ${checks} current-cache checks passed`);
} finally {
	await browser.close();
	server.stop(true);
	rmSync(directory, { recursive: true, force: true });
}
