/** What every browser test does: launch a persistent profile and open the harness in a tab. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, BrowserType, Page } from 'playwright';
import type {} from './harness.js';

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

/** Load the harness in `page` (a new tab by default) and open the repository `name`. */
export async function openTab(
	context: BrowserContext,
	site: string,
	name: string,
	{ page, server }: { page?: Page; server?: string } = {},
) {
	const opened = page ?? (await context.newPage());
	opened.on('pageerror', (error) => console.error('page error:', error));
	await opened.goto(site);
	await reopen(opened, name, server);
	return opened;
}

/** After a reload: wait for the harness and open the repository again. */
export async function reopen(page: Page, name: string, server?: string) {
	await page.waitForFunction(() => globalThis.harness !== undefined);
	await page.evaluate(([name, server]) => harness.open(name, server), [name, server] as const);
}
