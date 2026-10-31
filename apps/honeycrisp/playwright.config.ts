/**
 * Honeycrisp end to end, in Chromium and WebKit:
 *
 *   bun x playwright test -c apps/honeycrisp/playwright.config.ts
 *   bun x playwright test -c apps/honeycrisp/playwright.config.ts --project=webkit
 *
 * `globalSetup` starts `e2e/stack.ts`: a disposable Postgres, the local API
 * with temporary Git and LFS stores, and the built app on its registered
 * port (5175, which must be free). Both engines run in a persistent
 * profile, the only kind in which WebKit opens OPFS.
 */
import { defineConfig } from 'playwright/test';

export default defineConfig({
	testDir: './e2e',
	globalSetup: './e2e/global-setup.ts',
	timeout: 120_000,
	expect: { timeout: 30_000 },
	// The steps of one project share a browser profile and a repository, in order.
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		{ name: 'webkit', use: { browserName: 'webkit' } },
	],
});
