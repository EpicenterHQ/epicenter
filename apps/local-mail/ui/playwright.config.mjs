import { defineConfig } from '@playwright/test';

const port = Number(process.env.LOCAL_MAIL_TEST_PORT ?? 41770);

export default defineConfig({
	testDir: './e2e',
	// Keep browser journeys out of the parent's Bun test discovery.
	testMatch: '**/*.e2e.mjs',
	timeout: 120_000,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	reporter: [['list'], ['html', { open: 'never' }]],
	use: {
		headless: true,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		{ name: 'webkit', use: { browserName: 'webkit' } },
	],
	webServer: {
		command: 'bun e2e/server.mjs',
		url: `http://localhost:${port}/__evidence`,
		timeout: 120_000,
		reuseExistingServer: false,
		gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
	},
});
