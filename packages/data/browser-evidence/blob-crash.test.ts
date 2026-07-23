/**
 * Real browser process-kill evidence for the cross-medium blob publication
 * law. The worker owns production OPFS files plus OPFS SQLite and is terminated
 * after the exact stage, promotion, membership, and Discard cleanup boundaries.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import {
	type BrowserContext,
	type BrowserType,
	chromium,
	type Page,
	webkit,
} from 'playwright';

import type {
	BlobCaptureBoundary,
	BlobCrashState,
	BlobDiscardBoundary,
	BrowserBlobCrashDriver,
} from './blob-crash-contract.js';

const evidenceDirectory = import.meta.dirname;
const distributionDirectory = resolve(evidenceDirectory, 'blob-crash-dist');
const profileDirectory = mkdtempSync(
	resolve(tmpdir(), 'epicenter-browser-blob-crash-'),
);
setDefaultTimeout(60_000);

const build = Bun.spawnSync(
	['bun', 'x', 'vite', 'build', '--config', 'blob-crash-vite.config.ts'],
	{ cwd: evidenceDirectory, stderr: 'inherit', stdout: 'inherit' },
);
if (!build.success) throw new Error('Browser blob crash evidence build failed');

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const pathname =
			url.pathname === '/' ? '/blob-crash-index.html' : url.pathname;
		const target = resolve(
			distributionDirectory,
			`.${decodeURIComponent(pathname)}`,
		);
		if (
			target !== distributionDirectory &&
			!target.startsWith(`${distributionDirectory}${sep}`)
		) {
			return new Response('Forbidden', { status: 403 });
		}
		const file = Bun.file(target);
		if (!(await file.exists()) || !statSync(target).isFile()) {
			return new Response('Not found', { status: 404 });
		}
		return new Response(file, {
			headers: {
				'Cross-Origin-Embedder-Policy': 'require-corp',
				'Cross-Origin-Opener-Policy': 'same-origin',
			},
		});
	},
});

const engines = [
	['Chromium', chromium],
	['WebKit', webkit],
] as const;
const contexts = new Map<string, BrowserContext>();

declare global {
	interface Window {
		browserBlobCrashEvidence: BrowserBlobCrashDriver;
	}
}

async function openEngine(
	engine: BrowserType,
	name: string,
): Promise<BrowserContext> {
	const context = await engine.launchPersistentContext(
		resolve(profileDirectory, name.toLowerCase()),
		{ headless: true },
	);
	return context;
}

async function openEvidencePage(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	page.setDefaultTimeout(30_000);
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.waitForFunction(
		() => window.browserBlobCrashEvidence !== undefined,
	);
	return page;
}

beforeAll(async () => {
	for (const [name, engine] of engines) {
		contexts.set(name, await openEngine(engine, name));
	}
});

afterAll(async () => {
	await Promise.allSettled(
		[...contexts.values()].map((context) => context.close()),
	);
	server.stop(true);
	rmSync(profileDirectory, { force: true, recursive: true });
});

function requireContext(name: string): BrowserContext {
	const context = contexts.get(name);
	if (context === undefined)
		throw new Error(`${name} blob evidence context is absent`);
	return context;
}

async function cleanup(page: Page): Promise<void> {
	await page
		.evaluate(() => window.browserBlobCrashEvidence.close(true))
		.catch(() => undefined);
}

async function openFixture(
	page: Page,
	id: string,
	initialize: boolean,
): Promise<void> {
	await page.evaluate(
		({ id, initialize }) =>
			window.browserBlobCrashEvidence.open(id, initialize),
		{ id, initialize },
	);
}

async function seed(page: Page): Promise<void> {
	await page.evaluate(() => window.browserBlobCrashEvidence.seed());
}

async function capture(page: Page, text: string): Promise<string> {
	return page.evaluate(
		(value) => window.browserBlobCrashEvidence.capture(value),
		text,
	);
}

async function crashCapture(
	page: Page,
	text: string,
	boundary: BlobCaptureBoundary,
): Promise<void> {
	await page.evaluate(
		({ boundary, text }) =>
			window.browserBlobCrashEvidence.crashCapture(text, boundary),
		{ boundary, text },
	);
}

async function discard(page: Page, sweep: boolean): Promise<void> {
	await page.evaluate(
		(shouldSweep) =>
			window.browserBlobCrashEvidence.discard({ sweep: shouldSweep }),
		sweep,
	);
}

async function crashDiscard(
	page: Page,
	boundary: BlobDiscardBoundary,
): Promise<void> {
	await page.evaluate(
		(value) => window.browserBlobCrashEvidence.crashDiscard(value),
		boundary,
	);
}

async function sweep(page: Page): Promise<void> {
	await page.evaluate(() => window.browserBlobCrashEvidence.sweep());
}

async function readState(page: Page): Promise<BlobCrashState> {
	return page.evaluate(() => window.browserBlobCrashEvidence.state());
}

function assertHealthy(state: BlobCrashState): void {
	expect(state.integrity).toBe('ok');
	expect(state.stagingFiles).toBe(0);
}

for (const [engineName] of engines) {
	for (const boundary of [
		'afterStage',
		'afterPromote',
		'afterMembership',
	] as const satisfies readonly BlobCaptureBoundary[]) {
		test(`${engineName} reopens a process kill ${boundary}`, async () => {
			const id = crypto.randomUUID();
			let page = await openEvidencePage(requireContext(engineName));
			try {
				await openFixture(page, id, true);
				await seed(page);
				await crashCapture(page, boundary, boundary);
				await page.close();
				page = await openEvidencePage(requireContext(engineName));
				await openFixture(page, id, false);
				const state = await readState(page);
				assertHealthy(state);
				expect(state.recordState).toBe('live');
				if (boundary === 'afterMembership') {
					expect(state.blob.kind).toBe('owed');
					expect(state.contentFiles).toBe(1);
					expect(state.text).toBe(boundary);
				} else {
					expect(state.blob).toEqual({ kind: 'absent' });
					expect(state.contentFiles).toBe(0);
					expect(state.text).toBeNull();
				}
			} finally {
				await cleanup(page);
				await page.close().catch(() => undefined);
			}
		});
	}

	for (const boundary of [
		'afterAttachment',
		'afterSweep',
	] as const satisfies readonly BlobDiscardBoundary[]) {
		test(`${engineName} reopens a Discard process kill ${boundary}`, async () => {
			const id = crypto.randomUUID();
			let page = await openEvidencePage(requireContext(engineName));
			try {
				await openFixture(page, id, true);
				await seed(page);
				await capture(page, 'discarded bytes');
				await crashDiscard(page, boundary);
				await page.close();
				page = await openEvidencePage(requireContext(engineName));
				await openFixture(page, id, false);
				const state = await readState(page);
				assertHealthy(state);
				expect(state.attachment).toEqual({
					attachment: {
						deploymentId: 'https://api.epicenter.so/',
						principalId: 'browser-blob-evidence',
					},
					kind: 'attached',
				});
				expect(state.recordState).toBeNull();
				expect(state.blob).toEqual({ kind: 'absent' });
				expect(state.contentFiles).toBe(0);
				expect(state.text).toBeNull();
			} finally {
				await cleanup(page);
				await page.close().catch(() => undefined);
			}
		});
	}

	for (const [description, replacement] of [
		['equal digest', 'old bytes'],
		['different digest', 'new bytes'],
	] as const) {
		test(`${engineName} delayed Discard cleanup retains ${description} rehydration`, async () => {
			const id = crypto.randomUUID();
			const page = await openEvidencePage(requireContext(engineName));
			try {
				await openFixture(page, id, true);
				await seed(page);
				await capture(page, 'old bytes');
				await discard(page, false);
				await seed(page);
				await capture(page, replacement);
				await sweep(page);
				const state = await readState(page);
				assertHealthy(state);
				expect(state.recordState).toBe('live');
				expect(state.blob.kind).toBe('owed');
				expect(state.contentFiles).toBe(1);
				expect(state.text).toBe(replacement);
			} finally {
				await cleanup(page);
				await page.close().catch(() => undefined);
			}
		});
	}
}
