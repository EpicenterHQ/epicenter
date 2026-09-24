import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';

const port = Number(process.env.LOCAL_MAIL_TEST_PORT ?? 41770);
export const origins = {
	routes: `http://localhost:${port}`,
	queries: `http://localhost:${port + 1}`,
	gmail: `http://localhost:${port + 2}`,
	foreign: `http://localhost:${port + 3}`,
};

export { expect };
export const test = base.extend({
	persistentOrigin: [undefined, { option: true }],
	context: async (
		{
			playwright,
			browserName,
			persistentOrigin,
			browser,
			contextOptions,
			viewport,
			headless,
			launchOptions,
		},
		use,
	) => {
		if (!persistentOrigin) {
			const context = await browser.newContext({ ...contextOptions, viewport });
			try {
				await use(context);
			} finally {
				await context.close();
			}
			return;
		}
		if (![origins.routes, origins.queries].includes(persistentOrigin))
			throw new Error(
				'Persistent storage cleanup requires a Local Mail test origin',
			);
		const profile = await mkdtemp(join(tmpdir(), 'local-mail-browser-'));
		let context;
		try {
			context = await playwright[browserName].launchPersistentContext(profile, {
				...launchOptions,
				...contextOptions,
				viewport,
				headless,
			});
			// macOS WebKit can retain OPFS across different temporary profiles.
			// Clear this synthetic origin once, before any application code runs.
			// Do not clear on reload: the journeys must prove durable reopening.
			const reset = await context.newPage();
			const resetUrl = `${persistentOrigin}/__test-storage-reset`;
			await reset.route(resetUrl, (route) =>
				route.fulfill({
					contentType: 'text/html',
					body: '<!doctype html><title>Test storage reset</title>',
				}),
			);
			await reset.goto(resetUrl);
			await reset.evaluate(async () => {
				const root = await navigator.storage.getDirectory();
				for await (const name of root.keys())
					await root.removeEntry(name, { recursive: true });
			});
			await reset.close();
			await use(context);
		} finally {
			await context?.close();
			await rm(profile, { recursive: true, force: true });
		}
	},
});
