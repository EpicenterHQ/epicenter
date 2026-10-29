/** What every browser test does: launch a persistent profile and open a harness page in a tab. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, BrowserType, Page } from 'playwright';
import type {} from './replica-harness.js';
import type {} from './api-harness.js';

export const TIMEOUT = 60_000;

/** A persistent profile, as a person's browser has, removed by `cleanup`. */
export async function launchProfile(browser: BrowserType) {
	const dir = await mkdtemp(join(tmpdir(), 'repository-browser-'));
	const context = await browser.launchPersistentContext(dir, { headless: true });
	return {
		context,
		async cleanup() {
			await context.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** Load the replica host's harness in `page` (a new tab by default). */
export async function loadReplicaPage(context: BrowserContext, site: string, { page }: { page?: Page } = {}) {
	const opened = page ?? (await context.newPage());
	opened.on('pageerror', (error) => console.error('page error:', error));
	await opened.goto(new URL('replica', site).href);
	await opened.waitForFunction(() => globalThis.replicas !== undefined);
	return opened;
}

/** Load the repository API's page in `page` (a new tab by default). */
export async function loadApiPage(context: BrowserContext, site: string, { page }: { page?: Page } = {}) {
	const opened = page ?? (await context.newPage());
	opened.on('pageerror', (error) => console.error('page error:', error));
	await opened.goto(new URL('/api', site).href);
	await opened.waitForFunction(() => globalThis.api !== undefined);
	return opened;
}
