/**
 * The recorder demo end to end, in Chromium and WebKit:
 *
 *   bun x playwright test -c apps/recorder-demo/playwright.config.ts
 *   bun x playwright test -c apps/recorder-demo/playwright.config.ts --project=webkit
 *
 * `globalSetup` starts `e2e/stack.ts`: a disposable Postgres, the local API
 * with temporary Git and LFS stores, and the built demo on its registered
 * port (5214, which must be free). Each project records through a different
 * microphone: Chromium's fake capture device, and WebKit's `?fixture=tone`
 * oscillator, since WebKit under Playwright has none. Both run in a
 * persistent profile, the only kind in which WebKit opens OPFS.
 */
import { defineConfig } from 'playwright/test';
import type { DemoOptions } from './e2e/demo.spec.ts';

export default defineConfig<DemoOptions>({
	testDir: './e2e',
	globalSetup: './e2e/global-setup.ts',
	timeout: 120_000,
	expect: { timeout: 30_000 },
	// The steps of one project share a browser profile and a repository, in order.
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	projects: [
		{
			name: 'chromium',
			use: {
				browserName: 'chromium',
				microphone: 'device',
				launchOptions: {
					args: [
						'--use-fake-device-for-media-stream',
						'--use-fake-ui-for-media-stream',
					],
				},
			},
		},
		{
			name: 'webkit',
			use: { browserName: 'webkit', microphone: 'tone' },
		},
	],
});
