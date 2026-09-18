/** Production PKCE and Gmail popup callbacks with synthetic consent; no token exchange or normal-profile permission proof. */
import assert from 'node:assert/strict';
import { expect, origins, test } from './fixtures.mjs';

test.use({
	launchOptions: { ignoreDefaultArgs: ['--disable-popup-blocking'] },
});
test('Gmail consent callback validation and cancellation', async ({
	context,
	page,
}, testInfo) => {
	const origin = origins.gmail;
	const otherOrigin = origins.foreign;
	const observations = [
		'Callback build excludes the primary App owner (checked by the build server)',
	];
	await context.route('**/*', (route) => {
		const url = new URL(route.request().url());
		return [origin, otherOrigin].includes(url.origin)
			? route.continue()
			: route.abort();
	});
	await page.goto(origin);
	const primary = await page.evaluate('evidence.primary');
	const start = async (delay = 0) => {
		await page.locator('#delay').fill(String(delay));
		const popup = page
			.waitForEvent('popup', { timeout: delay + 5000 })
			.catch(() => null);
		await page
			.getByRole('button', { name: 'Connect Gmail', exact: true })
			.click();
		await page.waitForFunction(
			'document.querySelector("#status").textContent !== "preparing"',
		);
		return popup;
	};
	await test.step('validate popup sources and return through the actual callback', async () => {
		const popup = await start();
		assert(
			popup,
			`PKCE-await click failed to open popup: ${await page.evaluate('evidence.result')}`,
		);
		await popup.waitForLoadState();
		const state = await page.evaluate('evidence.state');
		const returned = `${origin}/connected?code=fixture-code&state=${state}`;
		const assertPending = async (message) => {
			await page.waitForTimeout(100);
			assert(
				(await page.locator('#status').textContent()) === 'pending',
				message,
			);
		};
		await page.evaluate(
			(url) =>
				window.postMessage(
					{ type: 'local-mail-gmail-return', url },
					location.origin,
				),
			returned,
		);
		await assertPending(
			'A same-origin message from the primary was accepted as popup callback',
		);
		await popup.evaluate(
			(url) =>
				window.opener.postMessage(
					{ type: 'local-mail-gmail-return', url },
					'*',
				),
			`${origin}/wrong-path?code=fake`,
		);
		await assertPending('Wrong callback path was accepted');
		await popup.evaluate(
			(url) =>
				window.opener.postMessage(
					{ type: 'local-mail-gmail-return', url },
					'*',
				),
			`${otherOrigin}/connected?code=fake`,
		);
		await assertPending('Foreign URL origin was accepted');
		await popup.evaluate(() =>
			window.opener.postMessage(
				{ type: 'local-mail-gmail-return', url: 'not a URL' },
				'*',
			),
		);
		await assertPending('Malformed callback URL was accepted');
		await popup.goto(otherOrigin);
		await popup.evaluate(
			(url) =>
				window.opener.postMessage(
					{ type: 'local-mail-gmail-return', url },
					'*',
				),
			returned,
		);
		await assertPending('Foreign message origin was accepted');
		observations.push(
			'Same-origin wrong source, foreign message/URL origins, wrong path, malformed URL are ignored',
		);
		// The callback closes this window. Trigger its redirect without asking
		// Playwright to return a navigation Response from the disappearing page.
		await popup.evaluate((url) => {
			setTimeout(() => location.assign(url), 0);
		}, returned);
		await page.waitForFunction(
			'document.querySelector("#status").textContent === "returned"',
		);
		assert(
			(await page.evaluate('evidence.result')) === returned,
			'Callback URL or state changed',
		);
		assert(
			(await page.evaluate('evidence.primary')) === primary,
			'Primary document was replaced',
		);
		await expect
			.poll(() => popup.isClosed(), {
				message: 'Successful callback left consent popup open',
			})
			.toBe(true);
		observations.push(
			'Real click after PKCE await returns actual connected-route callback and closes popup; primary survives',
		);
	});
	await test.step('recover from cancellation and a closed consent window', async () => {
		const cancelled = await start();
		assert(cancelled, 'Cancel fixture popup blocked');
		await page
			.getByRole('button', { name: 'Cancel connection', exact: true })
			.click();
		await page.waitForFunction(
			'document.querySelector("#status").textContent === "failed"',
		);
		assert(
			(await page.evaluate('evidence.result')) ===
				'Gmail connection cancelled.',
			'Abort did not reject with cancellation',
		);
		assert(cancelled.isClosed(), 'Abort left popup open');
		const closed = await start();
		assert(closed, 'Close fixture popup blocked');
		await closed.close();
		await page.waitForFunction(
			'document.querySelector("#status").textContent === "failed"',
		);
		assert(
			(await page.evaluate('evidence.result')) ===
				'Gmail connection window closed.',
			'Closing popup did not reject',
		);
		observations.push(
			'Abort and manually closed popup reject, close popup, and allow another attempt',
		);
	});
	await test.step('explain callbacks without an opener', async () => {
		const standalone = await context.newPage();
		await standalone.goto(`${origin}/connected?code=orphan`);
		await standalone
			.getByText(
				'Open Local Mail and connect Gmail again. This window did not start a connection.',
			)
			.waitFor();
		await standalone.close();
		observations.push(
			'Standalone actual callback route reports missing opener without opening a library',
		);
	});
	await test.step('record the limits of automated popup permissions', async () => {
		const cold = await start(6000);
		const activation = await page.evaluate('evidence.activation');
		if (cold) {
			await page
				.getByRole('button', { name: 'Cancel connection', exact: true })
				.click();
			observations.push(
				`Six-second cold preparation opened popup (activation=${activation})`,
			);
		} else {
			assert(
				(await page.locator('#status').textContent()) === 'failed',
				'Cold popup missing without visible refusal',
			);
			observations.push(
				`LIMITATION: six-second cold preparation loses popup permission (activation=${activation}): ${await page.evaluate('evidence.result')}`,
			);
		}
		const unactivated = await context.newPage();
		const unactivatedPopup = unactivated
			.waitForEvent('popup', { timeout: 3000 })
			.catch(() => null);
		await unactivated.goto(`${origin}/?autostart`);
		const uncontrolled = await unactivatedPopup;
		if (uncontrolled) {
			observations.push(
				'LIMITATION: browser automation also permits an unactivated timer popup; cold-popup permission is not proven for normal browser profiles',
			);
			await unactivated
				.getByRole('button', { name: 'Cancel connection', exact: true })
				.click();
		} else {
			assert(
				(await unactivated.locator('#status').textContent()) === 'failed',
				'No-gesture control did not settle',
			);
			observations.push('Popup blocker rejects the unactivated timer control');
		}
		await unactivated.close();
	});
	await testInfo.attach('gmail-evidence', {
		body: JSON.stringify({ observations }),
		contentType: 'application/json',
	});
});
