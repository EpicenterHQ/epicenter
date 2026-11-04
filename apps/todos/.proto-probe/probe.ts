// PROTOTYPE. Drives the /proto/* options in Chromium and prints what a person sees.
// bun .proto-probe/probe.ts [base]
import { type BrowserContext, chromium, type Page } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5186';
const browser = await chromium.launch();

function watch(page: Page, name: string) {
	page.on('console', (m) => {
		if (m.text().startsWith('[open') || m.type() === 'error')
			console.log(`  [${name} console.${m.type()}] ${m.text().slice(0, 200)}`);
	});
	page.on('pageerror', (e) => console.log(`  [${name} pageerror] ${e.message.slice(0, 200)}`));
	page.on('framenavigated', (f) => {
		if (f === page.mainFrame()) console.log(`  [${name} document load] ${f.url()}`);
	});
}
const text = (page: Page) =>
	page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 140));
const opens = (page: Page) =>
	page.evaluate(() => (globalThis as { __opens?: number }).__opens ?? 0);
const mark = (page: Page) =>
	page.evaluate(() => {
		(window as unknown as { marker: number }).marker = 1;
	});
const marked = (page: Page) =>
	page.evaluate(() => (window as unknown as { marker?: number }).marker === 1);

async function fresh(name: string): Promise<[BrowserContext, Page]> {
	const context = await browser.newContext();
	const page = await context.newPage();
	watch(page, name);
	return [context, page];
}

async function waiting(option: string) {
	console.log(`\n== ${option}: open takes 1500ms`);
	const [context, page] = await fresh(option);
	const start = Date.now();
	await page.goto(`${base}/proto/${option}?delay=1500`, { waitUntil: 'commit' });
	for (const at of [400, 1000, 2500]) {
		await page.waitForTimeout(Math.max(0, at - (Date.now() - start)));
		console.log(`  t=${at}ms "${await text(page)}"`);
	}
	await context.close();
}

async function failing(option: string, retries: string[]) {
	console.log(`\n== ${option}: first open fails`);
	const [context, page] = await fresh(option);
	await page.goto(`${base}/proto/${option}?fail=1`);
	await page.waitForTimeout(800);
	console.log(`  shown: "${await text(page)}" opens=${await opens(page)}`);
	await mark(page);
	for (const name of retries) {
		const button = page.getByRole('button', { name });
		if ((await button.count()) === 0) {
			console.log(`  no "${name}" button`);
			continue;
		}
		await button.click();
		await page.waitForTimeout(800);
		console.log(
			`  after "${name}": "${await text(page)}" opens=${await opens(page)} sameDocument=${await marked(page)}`,
		);
	}
	await context.close();
}

async function unrelatedInvalidate() {
	console.log('\n== b: an unrelated invalidateAll after the world opened');
	const [context, page] = await fresh('b');
	await page.goto(`${base}/proto/b`);
	await page.getByTestId('ready').waitFor();
	console.log(`  before: opens=${await opens(page)}`);
	await page.getByRole('button', { name: 'Unrelated invalidateAll' }).click();
	await page.waitForTimeout(800);
	console.log(`  after: opens=${await opens(page)} "${await text(page)}"`);
	await context.close();
}

async function navigating(option: string) {
	console.log(`\n== ${option}: client navigation from /proto/other, open takes 1500ms`);
	const [context, page] = await fresh(option);
	await page.goto(`${base}/proto/other`);
	await page.getByTestId('other').waitFor();
	const start = Date.now();
	await page.getByRole('link', { name: `to ${option}` }).click();
	for (const at of [400, 2500]) {
		await page.waitForTimeout(Math.max(0, at - (Date.now() - start)));
		console.log(`  t=${at}ms url=${new URL(page.url()).pathname} "${await text(page)}"`);
	}
	await context.close();
}

/** Every text the body shows while navigating between two pages that both await the world. */
async function flicker() {
	console.log('\n== f: navigate f one -> f two -> f one; every body text in between');
	const [context, page] = await fresh('f');
	await page.goto(`${base}/proto/f?delay=500`);
	await page.getByTestId('ready').waitFor();
	await page.evaluate(() => {
		const seen: string[] = [];
		(window as unknown as { seen: string[] }).seen = seen;
		const record = () => {
			const t = document.body.innerText.replace(/\s+/g, ' ').trim();
			if (seen.at(-1) !== t) seen.push(t);
		};
		new MutationObserver(record).observe(document.body, {
			subtree: true,
			childList: true,
			characterData: true,
		});
	});
	await mark(page);
	await page.getByRole('link', { name: 'f two' }).click();
	await page.waitForTimeout(500);
	await page.getByRole('link', { name: 'f one' }).click();
	await page.waitForTimeout(500);
	const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
	console.log(`  opens=${await opens(page)} sameDocument=${await marked(page)}`);
	for (const t of seen) console.log(`  saw "${t.slice(0, 120)}"`);
	await context.close();
}

/** Where a read of the world works: a `.svelte.ts` helper, a later child, a handler, a toast. */
async function reach(option: 'c' | 'f') {
	console.log(`\n== ${option}: reading the world from a helper, a later child, a handler, a toast`);
	const [context, page] = await fresh(option);
	await page.goto(`${base}/proto/${option}`);
	await page.getByTestId('ready').waitFor();
	for (const name of ['Show later child', 'Read in handler', 'Toast reader']) {
		const button = page.getByRole('button', { name });
		if ((await button.count()) === 0) continue;
		await button.click();
		await page.waitForTimeout(600);
		console.log(`  after "${name}": "${await text(page)}"`);
	}
	await context.close();
}

const only = process.argv[3]?.split(',');
const run = (name: string) => only === undefined || only.includes(name);

if (run('wait'))
	for (const option of (process.env.OPTIONS?.split(',') ?? ['a', 'b', 'c', 'd', 'cn', 'cn2', 'dn', 'f', 'r'])) await waiting(option);
if (run('reach')) for (const option of ['c', 'f'] as const) await reach(option);
if (run('flicker')) await flicker();
if (run('fail')) {
	await failing('f', ['Retry']);
	await failing('r', ['Retry']);
	await failing('a', ['Retry invalidateAll', 'Retry goto', 'Reload']);
	await failing('b', ['Retry invalidateAll']);
	await failing('c', ['Retry']);
	await failing('d', ['Retry']);
}
if (run('invalidate')) await unrelatedInvalidate();
if (run('nav')) for (const option of ['a', 'c']) await navigating(option);

await browser.close();
