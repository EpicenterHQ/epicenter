// Drives a served Todos web build in Chromium and prints what it sees.
// bun .spike-probe/probe.ts <mode> <url>
//   mode: wait | throw | real
import { chromium, type Page } from 'playwright';

const [mode, base = 'http://localhost:5199'] = process.argv.slice(2);
const TOKEN_KEY = 'so.epicenter.todos.oauth:https://api.epicenter.so';
const grant = (principalId: string) =>
	JSON.stringify({
		tokens: {
			'https://git.epicenter.so': {
				accessToken: `fake-${principalId}`,
				expiresAt: Date.now() + 24 * 3600_000,
			},
		},
		principalId,
		generation: 'g1',
	});

const browser = await chromium.launch();
const context = await browser.newContext();
const external: string[] = [];
// Nothing leaves localhost: record and refuse every other request.
await context.route(
	(url) => url.hostname !== 'localhost',
	(route) => {
		external.push(`${route.request().method()} ${route.request().url()}`);
		return route.abort();
	},
);

function watch(page: Page, name: string) {
	page.on('console', (m) => console.log(`[${name} console.${m.type()}] ${m.text()}`));
	page.on('pageerror', (e) => console.log(`[${name} pageerror] ${e.message}`));
	page.on('framenavigated', (f) => {
		if (f === page.mainFrame()) console.log(`[${name} navigated] ${f.url()}`);
	});
}

const body = (page: Page) =>
	page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 160));
const html = (page: Page) =>
	page.evaluate(() => document.body.firstElementChild?.innerHTML.length ?? -1);

if (mode === 'wait' || mode === 'throw') {
	const page = await context.newPage();
	watch(page, 'p');
	const start = Date.now();
	await page.goto(base, { waitUntil: 'commit' });
	for (const at of [300, 1000, 2000, 2800, 3500, 4500]) {
		await page.waitForTimeout(Math.max(0, at - (Date.now() - start)));
		console.log(`t=${at}ms bodyChars=${await html(page)} text="${await body(page)}"`);
	}
}

if (mode === 'real') {
	// 1. Signed out: the world throws StartupFailed; the error page offers sign-in.
	const a = await context.newPage();
	watch(a, 'A');
	await a.goto(base);
	await a.getByRole('button', { name: 'Sign in' }).waitFor();
	console.log(`signed out: "${await body(a)}"`);
	await a.getByRole('button', { name: 'Sign in' }).click();
	await a.waitForTimeout(800);
	console.log(`after Sign in, requests refused: ${JSON.stringify(external.splice(0))}`);

	// 2. Signed in (a stored grant): the page renders over the repository.
	await a.goto(base);
	await a.evaluate(([k, v]) => localStorage.setItem(k, v), [TOKEN_KEY, grant('p1')]);
	await a.goto(base);
	await a.getByRole('button', { name: 'Sign out' }).waitFor();
	await a.waitForTimeout(500);
	console.log(`signed in: "${await body(a)}"`);

	// 3. Another tab, the same account: both pages live.
	const b = await context.newPage();
	watch(b, 'B');
	await b.goto(base);
	await b.getByRole('button', { name: 'Sign out' }).waitFor();
	await a.evaluate(() => {
		(window as unknown as { marker: number }).marker = 1;
	});
	await b.evaluate(() => {
		(window as unknown as { marker: number }).marker = 1;
	});

	// 4. Another account in another tab: A reloads over it; B, the writer, does not.
	await b.evaluate(([k, v]) => localStorage.setItem(k, v), [TOKEN_KEY, grant('p2')]);
	await a.waitForTimeout(1000);
	console.log(
		`after B wrote another account: A marker=${await a.evaluate(() => (window as unknown as { marker?: number }).marker)} B marker=${await b.evaluate(() => (window as unknown as { marker?: number }).marker)} A="${await body(a)}"`,
	);
	// Settled: nothing reloads again.
	await a.evaluate(() => {
		(window as unknown as { marker: number }).marker = 9;
	});
	await a.waitForTimeout(2000);
	console.log(
		`2s later: A marker=${await a.evaluate(() => (window as unknown as { marker?: number }).marker)} B marker=${await b.evaluate(() => (window as unknown as { marker?: number }).marker)}`,
	);
	external.splice(0);

	// 5. Sign out in B: revoke is sent, then B reloads signed out, and A reloads too.
	await a.evaluate(() => {
		(window as unknown as { marker: number }).marker = 2;
	});
	await b.evaluate(() => {
		(window as unknown as { marker: number }).marker = 3;
	});
	await b.getByRole('button', { name: 'Sign out' }).click();
	await b.getByRole('button', { name: 'Sign in' }).waitFor();
	await a.getByRole('button', { name: 'Sign in' }).waitFor();
	console.log(`after sign-out, requests refused: ${JSON.stringify(external.splice(0))}`);
	console.log(
		`B marker=${await b.evaluate(() => (window as unknown as { marker?: number }).marker)} B="${await body(b)}"`,
	);
	console.log(
		`A marker=${await a.evaluate(() => (window as unknown as { marker?: number }).marker)} A="${await body(a)}"`,
	);
}

await browser.close();
