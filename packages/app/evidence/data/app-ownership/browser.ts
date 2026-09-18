/**
 * Run: bun packages/app/evidence/data/app-ownership/browser.ts [--webkit]
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
	// WebKit may acknowledge page closure before releasing that page's Web Locks.
	await first.waitForFunction(async () => {
		const { held } = await navigator.locks.query();
		return !held?.some((lock) =>
			lock.name?.includes('so.epicenter.admission-evidence'),
		);
	});
	assert.equal(await call(first, 'openEvidence'), 'ready');
	assert.equal(await call(first, 'closeEvidence'), 'closed');
	// Known storage rolls back cleanly after hydration fails.
	const rolledBack = await page();
	await call(rolledBack, 'setOpeningFailure', true);
	assert.equal(await call(rolledBack, 'openEvidence'), 'StorageFailed');
	assert.equal(await call(rolledBack, 'cleanupAttemptsEvidence'), 1);
	assert.equal(await call(first, 'openEvidence'), 'ready');
	assert.equal(await call(first, 'closeEvidence'), 'closed');
	await rolledBack.close();
	// Hydration fails after acquiring storage; unsafe rollback retains admission.
	const failed = await page();
	await call(failed, 'setOpeningFailure', true);
	await call(failed, 'setCleanupFailure', true);
	assert.equal(await call(failed, 'openEvidence'), 'AggregateError');
	assert.equal(await call(failed, 'cleanupAttemptsEvidence'), 1);
	assert.ok(
		((await call(failed, 'openingErrorsEvidence')) as string[]).includes(
			'StorageFailed',
		),
	);
	assert.equal(await call(first, 'openEvidence'), 'AlreadyOpen');
	await failed.close();
	await first.waitForFunction(async () => {
		const { held } = await navigator.locks.query();
		return !held?.some((lock) =>
			lock.name?.includes('so.epicenter.admission-evidence'),
		);
	});
	assert.equal(await call(first, 'openEvidence'), 'ready');
	assert.equal(await call(first, 'closeEvidence'), 'closed');
	// No public cancel API: destroying the page ends an unfinished acquisition.
	const blocked = await page();
	await call(blocked, 'setOpeningBlocked', true);
	await blocked.evaluate(() => {
		void (
			globalThis as unknown as { openEvidence(): Promise<unknown> }
		).openEvidence();
	});
	await first.waitForFunction(async () => {
		const { held } = await navigator.locks.query();
		return held?.some((lock) =>
			lock.name?.includes('so.epicenter.admission-evidence'),
		);
	});
	assert.equal(await call(first, 'openEvidence'), 'AlreadyOpen');
	await blocked.close();
	await first.waitForFunction(async () => {
		const { held } = await navigator.locks.query();
		return !held?.some((lock) =>
			lock.name?.includes('so.epicenter.admission-evidence'),
		);
	});
	assert.equal(await call(first, 'openEvidence'), 'ready');
	assert.equal(await call(first, 'closeEvidence'), 'closed');
	console.log(
		`${engine.name()}: ${await call(first, 'memoryCoexistenceEvidence')}`,
	);
	console.log(
		`${engine.name()}: duplicate refusal, handoff, persistence, terminal cleanup retention and page teardown release passed`,
	);
} finally {
	await browser?.close();
	server?.stop(true);
	await rm(temporary, { recursive: true, force: true });
}
