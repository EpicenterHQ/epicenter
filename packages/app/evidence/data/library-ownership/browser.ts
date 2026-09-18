/**
 * Run: bun packages/app/evidence/data/library-ownership/browser.ts [--webkit]
 * Real App readiness and teardown retain one browser admission boundary across
 * duplicate opens, repeated page reloads, immediate replacement, and failed cleanup.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page, webkit } from 'playwright';
import { build } from 'vite';

const temporary = await mkdtemp(join(tmpdir(), 'epicenter-app-admission-'));
const outDir = join(temporary, 'web');
const engine = process.argv.includes('--webkit') ? webkit : chromium;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser:
	| Awaited<ReturnType<typeof engine.launchPersistentContext>>
	| undefined;
async function call(page: Page, method: string, argument?: unknown) {
	return page.evaluate(
		async ({ method, argument }) => {
			const api = globalThis as unknown as Record<
				string,
				(value?: unknown) => unknown
			>;
			return api[method]!(argument);
		},
		{ method, argument },
	);
}
try {
	await build({
		configFile: false,
		root: import.meta.dir,
		logLevel: 'warn',
		worker: { format: 'es' },
		build: { target: 'esnext', outDir, emptyOutDir: true },
	});
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const file = Bun.file(join(outDir, path === '/' ? 'index.html' : path));
			return (await file.exists())
				? new Response(file)
				: new Response('missing', { status: 404 });
		},
	});
	browser = await engine.launchPersistentContext(join(temporary, 'profile'));
	const origin = `http://localhost:${server.port}`;
	async function page() {
		const opened = await browser!.newPage();
		opened.setDefaultTimeout(15_000);
		await opened.goto(origin);
		await opened.waitForFunction(
			'typeof globalThis.openEvidence === "function"',
		);
		return opened;
	}
	const first = await page();
	assert.equal(await call(first, 'openEvidence'), 'ready');
	await call(first, 'writeEvidence');
	const second = await page();
	assert.equal(await call(second, 'openEvidence'), 'AlreadyOpen');
	assert.equal(await call(second, 'closeEvidence'), 'closed');
	assert.deepEqual(await call(first, 'readEvidence'), ['retained']);
	for (let iteration = 0; iteration < 50; iteration++) {
		assert.equal(await call(first, 'closeEvidence'), 'closed');
		assert.equal(
			await call(first, 'openEvidence'),
			'ready',
			`immediate replacement ${iteration}`,
		);
	}
	console.log(`${engine.name()}: 50 immediate replacements passed`);
	for (let iteration = 0; iteration < 50; iteration++) {
		await first.reload();
		await first.waitForFunction(
			'typeof globalThis.openEvidence === "function"',
		);
		assert.equal(
			await call(first, 'openEvidence'),
			'ready',
			`reload ${iteration}`,
		);
	}
	console.log(`${engine.name()}: 50 reloads passed`);
	assert.deepEqual(await call(first, 'readEvidence'), ['retained']);
	assert.equal(await call(first, 'closeEvidence'), 'closed');
	assert.equal(await call(second, 'openEvidence'), 'ready');
	assert.deepEqual(await call(second, 'readEvidence'), ['retained']);
	await call(second, 'setCleanupFailure', true);
	assert.equal(await call(second, 'closeEvidence'), 'cleanup-failed');
	assert.equal(await call(first, 'openEvidence'), 'AlreadyOpen');
	assert.equal(await call(first, 'closeEvidence'), 'closed');
	await call(second, 'setCleanupFailure', false);
	assert.equal(await call(second, 'closeEvidence'), 'cleanup-failed');
	assert.equal(await call(first, 'openEvidence'), 'AlreadyOpen');
	await second.close();
	assert.equal(await call(first, 'openEvidence'), 'ready');
	assert.equal(await call(first, 'closeEvidence'), 'closed');
	console.log(
		`${engine.name()}: duplicate refusal, handoff, persistence, terminal cleanup retention and page teardown release passed`,
	);
} finally {
	await browser?.close();
	server?.stop(true);
	await rm(temporary, { recursive: true, force: true });
}
