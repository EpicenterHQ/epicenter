/** Run after bun dev:honeycrisp:ui. Uses disposable browser contexts and a fake authority. */
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

for (const engine of [chromium, webkit]) {
	const browser = await engine.launch();
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		page.setDefaultTimeout(15000);
		const errors = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto('http://localhost:5175/');
		await page.getByText('Sign in to open your notes.').waitFor();
		assert.deepEqual(
			await page.evaluate(async () => await indexedDB.databases()),
			[],
		);
		await page.evaluate(() =>
			localStorage.setItem(
				'so.epicenter.honeycrisp.auth.persisted:http://localhost:8787',
				JSON.stringify({
					token: 'disposable-test',
					principalId: 'page-review',
				}),
			),
		);
		await page.route('http://localhost:8787/**', async (route) => {
			const url = route.request().url();
			const json = url.endsWith('/api/session')
				? { principalId: 'page-review', email: 'page-review@example.test' }
				: route.request().method() === 'GET'
					? { generations: [] }
					: { generation: 1, position: 0 };
			await route.fulfill({ status: 200, json });
		});
		await page.reload();
		await page.waitForTimeout(3000);

		await page.getByRole('button', { name: 'New note', exact: true }).click();
		await page
			.locator('[contenteditable=true]')
			.fill('Departure keeps the final edit');
		await page.evaluate(() => {
			window.__pageMarker = 'old';
		});
		await page.getByRole('button', { name: 'Account', exact: true }).click();
		await page.getByRole('button', { name: 'Sign out', exact: true }).click();
		await page.getByText('Sign in to open your notes.').waitFor();
		assert.equal(await page.evaluate(() => !window.__pageMarker), true);
		await page.evaluate(() =>
			localStorage.setItem(
				'so.epicenter.honeycrisp.auth.persisted:http://localhost:8787',
				JSON.stringify({
					token: 'disposable-test',
					principalId: 'page-review',
				}),
			),
		);
		await page.reload();
		await page.waitForFunction(() =>
			document.body.innerText.includes('Departure keeps the final edit'),
		);
		const note = page
			.getByText('Departure keeps the final edit', { exact: true })
			.first();
		await note.waitFor();
		assert.deepEqual(errors, []);
		console.log(
			`${engine.name()}: final edit survives full-page sign-out and reopening.`,
		);
	} catch (error) {
		for (const context of browser.contexts())
			for (const page of context.pages())
				console.error(
					'Failure at',
					page.url(),
					await page.locator('body').innerText(),
				);
		throw error;
	} finally {
		await browser.close();
	}
}
