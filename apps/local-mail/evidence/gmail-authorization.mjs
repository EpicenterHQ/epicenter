/**
 * Production Gmail popup protocol, PKCE builder, and connected route under
 * real browser clicks. Consent URLs are local fixtures; no token exchange.
 * An unactivated timer control identifies automation popup-policy limitations.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(
	new URL('../../../packages/data/package.json', import.meta.url),
);
const { chromium, webkit } = require('playwright');
const { build } = require('vite');
const uiRequire = createRequire(new URL('../ui/package.json', import.meta.url));
const { svelte } = uiRequire('@sveltejs/vite-plugin-svelte');
const sveltePackage = uiRequire('svelte/package.json');
const svelteRoot = dirname(uiRequire.resolve('svelte/package.json'));
const aliases = Object.entries(sveltePackage.exports).flatMap(
	([key, value]) => {
		const path =
			typeof value === 'string' ? value : (value.browser ?? value.default);
		return path
			? [
					{
						find: new RegExp(
							`^${key === '.' ? 'svelte' : `svelte/${key.slice(2)}`}$`,
						),
						replacement: join(svelteRoot, path),
					},
				]
			: [];
	},
);
const temporary = await mkdtemp(join(tmpdir(), 'gmail-authorization-'));
const root = new URL('../ui/evidence/gmail-authorization/', import.meta.url)
	.pathname;
const observations = [];
const built = await build({
	root,
	configFile: false,
	logLevel: 'warn',
	plugins: [svelte({ configFile: false })],
	resolve: { alias: aliases },
	build: {
		target: 'esnext',
		outDir: join(temporary, 'web'),
		rollupOptions: {
			input: {
				main: join(root, 'index.html'),
				consent: join(root, 'authorize.html'),
				callback: join(root, 'connected/index.html'),
			},
		},
	},
});
const bundles = Array.isArray(built) ? built : [built];
if (
	bundles.some((bundle) =>
		bundle.output.some(
			(item) =>
				item.type === 'chunk' &&
				Object.keys(item.modules).some(
					(id) =>
						id.includes('/lib/application.') ||
						id.includes('/packages/app/src/'),
				),
		),
	)
)
	throw new Error('Callback evidence unexpectedly imported an App owner.');
observations.push(
	'Callback bundles the actual connected route; module graph opens no primary App',
);
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		return new Response(
			Bun.file(
				join(
					temporary,
					'web',
					path === '/'
						? 'index.html'
						: path === '/connected'
							? 'connected/index.html'
							: path,
				),
			),
		);
	},
});
const foreign = Bun.serve({
	port: 0,
	fetch() {
		return new Response('<!doctype html><title>Other origin</title>', {
			headers: { 'content-type': 'text/html' },
		});
	},
});
const origin = `http://localhost:${server.port}`;
const otherOrigin = `http://localhost:${foreign.port}`;
const engine = process.argv.includes('--webkit') ? webkit : chromium;
const browser = await engine.launch({
	ignoreDefaultArgs: ['--disable-popup-blocking'],
});
const context = await browser.newContext();
await context.route('**/*', (route) => {
	const url = route.request().url();
	return url.startsWith(origin) || url.startsWith(otherOrigin)
		? route.continue()
		: route.abort();
});
const page = await context.newPage();
const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};
try {
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
			window.opener.postMessage({ type: 'local-mail-gmail-return', url }, '*'),
		`${origin}/wrong-path?code=fake`,
	);
	await assertPending('Wrong callback path was accepted');
	await popup.evaluate(
		(url) =>
			window.opener.postMessage({ type: 'local-mail-gmail-return', url }, '*'),
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
			window.opener.postMessage({ type: 'local-mail-gmail-return', url }, '*'),
		returned,
	);
	await assertPending('Foreign message origin was accepted');
	observations.push(
		'Same-origin wrong source, foreign message/URL origins, wrong path, malformed URL are ignored',
	);
	await popup.goto(returned).catch((error) => {
		if (!popup.isClosed()) throw error;
	});
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
	await page.waitForFunction(() => true);
	assert(popup.isClosed(), 'Successful callback left consent popup open');
	observations.push(
		'Real click after PKCE await returns actual connected-route callback and closes popup; primary survives',
	);
	const cancelled = await start();
	assert(cancelled, 'Cancel fixture popup blocked');
	await page
		.getByRole('button', { name: 'Cancel connection', exact: true })
		.click();
	await page.waitForFunction(
		'document.querySelector("#status").textContent === "failed"',
	);
	assert(
		(await page.evaluate('evidence.result')) === 'Gmail connection cancelled.',
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
			`BLOCKER: six-second cold preparation loses popup permission (activation=${activation}): ${await page.evaluate('evidence.result')}`,
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
	console.log(
		JSON.stringify(
			{
				engine: engine.name(),
				observations,
				scope:
					'Production browser authorization, PKCE builder, and connected route; synthetic consent URL; no Gmail token exchange',
			},
			null,
			2,
		),
	);
} finally {
	await browser.close();
	server.stop(true);
	foreign.stop(true);
	await rm(temporary, { recursive: true, force: true });
}
