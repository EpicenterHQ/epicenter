/** What every browser test does: launch a persistent profile and open the harness in a tab. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, BrowserType, Page } from 'playwright';
import type {} from './harness.js';
import type {} from './replica-harness.js';
import type {} from './api-harness.js';

export const TIMEOUT = 60_000;

/**
 * A repository name no other test uses. Playwright's WebKit shares one
 * origin's OPFS across persistent profiles (Web Locks and BroadcastChannel
 * stay separate), so two profiles naming one repository would open one
 * SQLite file; each profile, and each test, takes its own name.
 */
export const uniqueName = (base: string) => `${base}-${crypto.randomUUID().slice(0, 8)}`;

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

/** Load the harness in `page` (a new tab by default). */
export async function loadTab(context: BrowserContext, site: string, { page }: { page?: Page } = {}) {
	const opened = page ?? (await context.newPage());
	opened.on('pageerror', (error) => console.error('page error:', error));
	await opened.goto(site);
	await opened.waitForFunction(() => globalThis.harness !== undefined);
	return opened;
}

/** Load the harness in `page` (a new tab by default) and open the repository `name`. */
export async function openTab(
	context: BrowserContext,
	site: string,
	name: string,
	{ page, server }: { page?: Page; server?: string } = {},
) {
	const opened = await loadTab(context, site, { page });
	await reopen(opened, name, server);
	return opened;
}

/** After a reload: wait for the harness and open the repository again; answers whether this tab owns it. */
export async function reopen(page: Page, name: string, server?: string) {
	await page.waitForFunction(() => globalThis.harness !== undefined);
	return page.evaluate(([name, server]) => harness.open(name, server), [name, server] as const);
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
