/**
 * The recorder demo end to end, in Chromium and WebKit:
 *
 *   bun x playwright test -c apps/recorder-demo/playwright.config.ts
 *   bun x playwright test -c apps/recorder-demo/playwright.config.ts --project=webkit
 *
 * `webServer` builds the demo into `dist/` and serves it with `vite
 * preview` on `http://localhost:5214`, which must be free. The demo never
 * signs in, so no API runs. Both projects record from the same microphone,
 * a generated tone the suite installs in the page (`fakeMicrophone`), since
 * WebKit under Playwright has no capture device. Both run in a persistent
 * profile, the only kind in which WebKit opens OPFS.
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
		command: 'bun run build --logLevel warn && bun run preview',
		url: 'http://localhost:5214/contract.json',
		reuseExistingServer: false,
		timeout: 180_000,
		stdout: 'pipe',
	},
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		{ name: 'webkit', use: { browserName: 'webkit' } },
	],
});
