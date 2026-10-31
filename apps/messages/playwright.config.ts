/**
 * Messages end to end, in Chromium and WebKit:
 *
 *   bun x playwright test -c apps/messages/playwright.config.ts
 *
 * `webServer` builds Messages and serves it with its own local program
 * (`e2e/serve.ts`, over `scripts/serve.ts`) on `http://127.0.0.1:5189`,
 * which must be free, with a fake Beeper behind it. Messages never signs
 * in, so no API runs. Both engines run in a persistent profile, the only
 * kind in which WebKit opens OPFS.
 */
import { defineConfig } from 'playwright/test';

export default defineConfig({
	testDir: './e2e',
	timeout: 120_000,
	expect: { timeout: 30_000 },
	// The steps of one project share a browser profile, in order.
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	webServer: {
		command: 'bun --no-install e2e/serve.ts',
		url: 'http://127.0.0.1:5189/contract.json',
		reuseExistingServer: false,
		timeout: 180_000,
		stdout: 'pipe',
	},
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		{ name: 'webkit', use: { browserName: 'webkit' } },
	],
});
