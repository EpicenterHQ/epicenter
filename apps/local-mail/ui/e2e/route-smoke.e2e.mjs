/** Actual built SvelteKit routes, App and OPFS; synthetic auth, no live Gmail or desktop host. */
import assert from 'node:assert/strict';
import { test, origins } from './fixtures.mjs';
import { currentLibraryResponse } from '../evidence/current-library.js';

test.use({
	persistentOrigin: origins.routes,
	viewport: { width: 1280, height: 900 },
});
test('application startup, draft protection and durable reopen', async ({
	context,
	page,
	request,
}, testInfo) => {
	const origin = origins.routes;
	const api = 'https://api.epicenter.so';
	const response = await request.get(`${origin}/__evidence`);
	assert(response.ok(), 'Browser build metadata unavailable');
	const build = await response.json();
	const { applicationPath } = build;
	const observations = [];
	const tabStates = [];
	const observe = (message) => observations.push(message);
	const name = page.getByLabel('Name', { exact: true });
	const sql = page.getByLabel('SQL', { exact: true });
	await context.routeWebSocket('wss://api.epicenter.so/**', (socket) =>
		socket.close({
			code: 1000,
			reason: 'Synthetic fixture has no sync service',
		}),
	);
	await context.route(`${api}/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const headers = {
			'access-control-allow-origin': origin,
			'access-control-allow-headers':
				'authorization,content-type,x-epicenter-principal',
			'access-control-allow-methods': 'GET,POST,OPTIONS',
		};
		if (request.method() === 'OPTIONS')
			return route.fulfill({ status: 204, headers });
		if (url.pathname === '/api/session')
			return route.fulfill({
				json: { principalId: 'route-smoke-person' },
				headers,
			});
		if (url.pathname.endsWith('/current')) {
			const response = await currentLibraryResponse(
				new Request(request.url(), {
					method: request.method(),
					body: request.postDataBuffer(),
				}),
			);
			return route.fulfill({
				status: response.status,
				body: Buffer.from(await response.arrayBuffer()),
				headers: { ...headers, ...Object.fromEntries(response.headers) },
			});
		}
		return route.fulfill({
			status: 503,
			body: 'Synthetic route smoke has no remote service.',
			headers,
		});
	});
	await context.addInitScript(() => {
		const evidence = { workers: [], databases: [] };
		globalThis.routeSmoke = evidence;
		const WorkerConstructor = window.Worker;
		window.Worker = class extends WorkerConstructor {
			constructor(url, options) {
				evidence.workers.push(String(url));
				super(url, options);
			}
		};
		const open = indexedDB.open.bind(indexedDB);
		indexedDB.open = (name, version) => {
			evidence.databases.push(String(name));
			return version === undefined ? open(name) : open(name, version);
		};
	});
	page.setDefaultTimeout(20_000);
	const requests = [];
	const errors = [];
	page.on('request', (request) =>
		requests.push(new URL(request.url()).pathname),
	);
	page.on('pageerror', (error) => errors.push(error.message));
	// Do not silently accept a beforeunload prompt during persistence checks.
	page.on('dialog', (dialog) => dialog.dismiss());
	const noResources = async (label) => {
		const activity = await page.evaluate(() => globalThis.routeSmoke);
		assert(
			activity.workers.length === 0 && activity.databases.length === 0,
			`${label} opened resources: ${JSON.stringify(activity)}`,
		);
	};
	const inspectTabs = async (label) => {
		const state = await page.evaluate(async () => {
			const buttons = [
				...document.querySelectorAll('[aria-label="Mail views"] button'),
			];
			await Promise.all(
				buttons
					.flatMap((button) => button.getAnimations())
					.map((animation) => animation.finished.catch(() => undefined)),
			);
			const panel = document.querySelector(
				'section[aria-label="Saved queries"]',
			);
			return {
				buttons: buttons.map((button) => ({
					text: button.textContent.trim(),
					classes: button.className,
					background: getComputedStyle(button).backgroundColor,
					hover: button.matches(':hover'),
					focus: button === document.activeElement,
					pressed: button.getAttribute('aria-pressed'),
				})),
				queryHidden: Boolean(panel?.closest('[hidden]')),
				queryVisible: Boolean(panel?.getClientRects().length),
			};
		});
		for (const button of state.buttons) {
			const selected =
				button.text === 'Saved queries'
					? state.queryVisible
					: state.queryHidden;
			assert(
				button.classes.includes(
					`cn-button-variant-${selected ? 'secondary' : 'ghost'}`,
				),
				`${label}: ${button.text} variant disagrees with the displayed panel`,
			);
			assert(
				button.pressed === String(selected),
				`${label}: ${button.text} aria-pressed disagrees with the displayed panel`,
			);
		}
		tabStates.push({ label, ...state });
		return state;
	};

	await test.step('callbacks and preload open no primary library', async () => {
		await page.goto(`${origin}/connected`);
		await page
			.getByText('Open Local Mail and connect Gmail again.', { exact: false })
			.waitFor();
		await noResources('Gmail callback');
		assert(
			!requests.includes(applicationPath),
			'Gmail callback imported the application chunk',
		);
		observe(
			'Gmail callback opens no application resources or application module',
		);

		await page.evaluate(
			(api) =>
				localStorage.setItem(
					`so.epicenter.local-mail.auth.persisted:${api}`,
					JSON.stringify({
						token: 'synthetic-route-token',
						principalId: 'route-smoke-person',
					}),
				),
			api,
		);
		requests.length = 0;
		await page.goto(`${origin}/auth/callback`);
		await page.locator('div.text-destructive').waitFor();
		await noResources('Epicenter auth callback');
		assert(
			!requests.includes(applicationPath),
			'Auth callback imported the application chunk',
		);
		observe('Auth callback with cached identity opens no primary library');

		requests.length = 0;
		await page.goto(`${origin}/connected`);
		await page
			.getByText('Open Local Mail and connect Gmail again.', { exact: false })
			.waitFor();
		await page.evaluate(() => {
			const link = document.createElement('a');
			link.href = '/';
			link.textContent = 'Preload Local Mail';
			link.setAttribute('data-sveltekit-preload-code', 'hover');
			link.setAttribute('data-sveltekit-preload-data', 'hover');
			document.body.append(link);
		});
		const loadedMain = page.waitForResponse((response) =>
			/\/_app\/immutable\/nodes\/2\./.test(new URL(response.url()).pathname),
		);
		await page.getByRole('link', { name: 'Preload Local Mail' }).hover();
		await loadedMain;
		await noResources('Primary-route preload');
		assert(
			!requests.includes(applicationPath),
			'Primary-route preload imported the application module',
		);
		observe(
			'SvelteKit hover preloads the main route code without opening its App',
		);
	});
	await test.step('signed-out boot and ready-gated query saving', async () => {
		await page.evaluate(
			(api) =>
				localStorage.removeItem(
					`so.epicenter.local-mail.auth.persisted:${api}`,
				),
			api,
		);
		await page.goto(origin);
		await page
			.getByRole('button', { name: 'Sign in with Epicenter', exact: true })
			.waitFor();
		await noResources('Signed-out primary route');
		observe('Signed-out primary route shows sign-in without acquiring storage');

		await page.evaluate(
			(api) =>
				localStorage.setItem(
					`so.epicenter.local-mail.auth.persisted:${api}`,
					JSON.stringify({
						token: 'synthetic-route-token',
						principalId: 'route-smoke-person',
					}),
				),
			api,
		);
		await page.reload();
		await page
			.getByRole('button', { name: 'Saved queries', exact: true })
			.waitFor({ timeout: 30_000 })
			.catch(async (error) => {
				console.error(
					JSON.stringify(
						{
							body: await page.locator('body').innerText(),
							errors,
							requests: requests.slice(-15),
							activity: await page.evaluate(() => globalThis.routeSmoke),
						},
						null,
						2,
					),
				);
				throw error;
			});
		const activity = await page.evaluate(() => globalThis.routeSmoke);
		assert(
			activity.workers.some((url) => url.includes('browser-sqlite')),
			'Mounted App never opened its production SQLite worker',
		);
		await inspectTabs('Initial mailbox');
		await page
			.getByRole('button', { name: 'Saved queries', exact: true })
			.click();
		await name.waitFor();
		await inspectTabs('Opened saved queries');
		await name.fill('Actual route saved query');
		await sql.fill('unfinished SQL from the real route');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await page
			.getByRole('status')
			.filter({ hasText: 'Saved to this device.' })
			.waitFor();
		observe(
			'Mounted primary route opens its App, passes readiness, renders MailShell, and saves invalid SQL',
		);
	});
	await test.step('drafts survive navigation and durable reopen', async () => {
		// Inspect the already-mounted public application export in its actual bundle.
		// This introduces no production hook and never imports it on a callback/preload.
		await page.evaluate(async (path) => {
			const module = await import(path);
			globalThis.routeApplication = Object.values(module).find(
				(value) =>
					value &&
					typeof value === 'object' &&
					'departure' in value &&
					'app' in value,
			);
			if (!globalThis.routeApplication)
				throw new Error(
					'Application export could not be found in built module.',
				);
		}, applicationPath);
		await sql.fill('dirty SQL kept after canceled departure');
		await page.getByRole('button', { name: 'Mailbox', exact: true }).click();
		const mailboxState = await inspectTabs(
			'Returned to mailbox with dirty query',
		);
		assert(
			mailboxState.queryHidden && !mailboxState.queryVisible,
			'Mailbox did not hide the query panel',
		);
		await page
			.getByRole('button', { name: 'Saved queries', exact: true })
			.click();
		await name.waitFor();
		assert(
			(await sql.inputValue()) === 'dirty SQL kept after canceled departure',
			'Tab switching discarded the query draft',
		);
		await inspectTabs('Returned to saved queries with preserved draft');
		observe(
			'Mailbox hides the query panel; returning to Saved queries preserves the dirty draft',
		);
		await page.evaluate(() => {
			globalThis.routeSmoke.departure = 'pending';
			void globalThis.routeApplication.departure
				.go(() => {
					globalThis.routeSmoke.departure = 'departed';
				})
				.catch(() => {
					globalThis.routeSmoke.departure = 'refused';
				});
		});
		await page.getByText('Discard this draft?', { exact: true }).waitFor();
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		await page.waitForFunction(
			() => globalThis.routeSmoke.departure === 'refused',
		);
		assert(
			(await sql.inputValue()) === 'dirty SQL kept after canceled departure',
			'Canceled departure lost the draft',
		);
		assert(
			(await page.evaluate(
				() => globalThis.routeApplication.departure.state.phase,
			)) === 'open',
			'Canceled preflight closed the App',
		);
		observe(
			'Real route → MailShell → editor preflight refuses departure and retains the dirty draft',
		);
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await page
			.getByRole('status')
			.filter({ hasText: 'Saved to this device.' })
			.waitFor();
		await page.evaluate(() => globalThis.routeApplication.departure.close());
		assert(
			await page.evaluate(
				() => globalThis.routeApplication.departure.canReopen,
			),
			'Document cleanup did not release resources',
		);
		await page.reload();
		await page
			.getByRole('button', { name: 'Saved queries', exact: true })
			.waitFor();
		await page
			.getByRole('button', { name: 'Saved queries', exact: true })
			.click();
		await page
			.getByRole('button', { name: 'Actual route saved query', exact: true })
			.click();
		assert(
			(await sql.inputValue()) === 'dirty SQL kept after canceled departure',
			'Actual route failed durable reopen',
		);
		observe(
			'Document closure releases resources and a new primary document reopens the persisted query',
		);
	});
	await test.step('connection navigation preserves query drafts', async () => {
		// Saved-query readiness does not imply that the separate mail registry opened.
		await page
			.getByText('Connect a Gmail account', { exact: true })
			.waitFor({ state: 'attached' });
		await page.evaluate(async (path) => {
			const module = await import(path);
			const application = Object.values(module).find(
				(value) =>
					value &&
					typeof value === 'object' &&
					'departure' in value &&
					'app' in value,
			);
			const opened = await application.app.device.sqlite.open('local');
			if (opened.error) throw new Error(opened.error.message);
			const seeded = await opened.data.batch([
				{
					sql: "INSERT INTO accounts VALUES ('connection-check', 'connection@example.com', '2026-09-09')",
				},
				{
					sql: "INSERT INTO last_pass VALUES ('connection-check', '2026-09-09', '[]', 'signin', 'ReauthRequired', 'Reconnect Gmail')",
				},
			]);
			if (seeded.error) throw new Error(seeded.error.message);
		}, applicationPath);
		await page.reload();
		await page
			.getByRole('button', { name: 'Saved queries', exact: true })
			.click();
		await page
			.getByRole('button', { name: 'Actual route saved query', exact: true })
			.click();
		await sql.fill('dirty draft retained while connecting Gmail');
		await page
			.getByRole('button', { name: 'connection@example.com', exact: true })
			.click();
		await page
			.getByRole('menuitem', { name: 'Connect another account', exact: true })
			.click();
		await page
			.getByText('Connect another Gmail account', { exact: true })
			.waitFor();
		await inspectTabs('Connect another account reveals mailbox');
		await page
			.getByRole('button', { name: 'Saved queries', exact: true })
			.click();
		assert(
			(await sql.inputValue()) ===
				'dirty draft retained while connecting Gmail',
			'Connection navigation discarded the query draft',
		);
		observe(
			'Connect another account from Saved queries reveals its panel and preserves the dirty draft',
		);
		await page
			.getByRole('button', { name: 'Sync: Reconnect to sync', exact: true })
			.click();
		await page
			.getByRole('button', { name: 'Reconnect Gmail', exact: true })
			.click();
		await page.keyboard.press('Escape');
		await page
			.getByText('Connect another Gmail account', { exact: true })
			.waitFor();
		await inspectTabs('Reconnect Gmail reveals mailbox');
		await page
			.getByRole('button', { name: 'Saved queries', exact: true })
			.click();
		assert(
			(await sql.inputValue()) ===
				'dirty draft retained while connecting Gmail',
			'Reconnect navigation discarded the query draft',
		);
		observe(
			'Reconnect Gmail from Saved queries reveals its panel and preserves the dirty draft',
		);
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await page
			.getByRole('status')
			.filter({ hasText: 'Saved to this device.' })
			.waitFor();
	});
	assert(errors.length === 0, `Uncaught browser errors: ${errors.join('; ')}`);
	await testInfo.attach('route-evidence', {
		body: JSON.stringify({ build, observations, tabStates }),
		contentType: 'application/json',
	});
});
