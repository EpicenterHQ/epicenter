/**
 * Messages end to end, in Chromium and WebKit:
 *
 *   bun x playwright test -c apps/messages/playwright.config.ts
 *
 * `webServer` builds Messages and serves it with its own local program
 * (`e2e/serve.ts`, over `scripts/serve.ts`) on ports 5189 and 5191,
 * which must be free, with the real send owner over separate scratch Messages
 * folder and a fake Beeper behind it. Messages never signs in, so no API
 * runs. Both engines run in a persistent profile, the only kind in which
 * WebKit opens OPFS, where an earlier Messages kept drafts.
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
	webServer: ['chromium', 'webkit'].map((browser) => ({
		command: `MESSAGES_E2E_BROWSER=${browser} bun --no-install e2e/serve.ts`,
		url: `http://127.0.0.1:${browser === 'chromium' ? 5189 : 5191}/contract.json`,
		reuseExistingServer: false,
		timeout: 180_000,
		stdout: 'pipe' as const,
	})),
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		{ name: 'webkit', use: { browserName: 'webkit' } },
	],
});
