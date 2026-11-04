// PROTOTYPE. Option (s), synchronous open with readiness as a value, against
// option (c) as reviewed (cr) and the earlier (r), in Chromium.
// bun .proto-probe/sync.ts [base] [only,...]
import { type BrowserContext, chromium, type Page } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5199';
const only = process.argv[3]?.split(',');
const run = (name: string) => only === undefined || only.includes(name);
const browser = await chromium.launch();

const text = (page: Page) =>
	page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 140));
const counts = (page: Page) =>
	page.evaluate(() => {
		const g = globalThis as { __opens?: number; __closed?: number; __models?: number; __modelsClosed?: number };
		return `opens=${g.__opens ?? 0} closed=${g.__closed ?? 0} models=${g.__models ?? 0} modelsClosed=${g.__modelsClosed ?? 0}`;
	});

async function fresh(name: string): Promise<[BrowserContext, Page]> {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (e) => console.log(`  [${name} pageerror] ${e.message.slice(0, 160)}`));
	page.on('console', (m) => {
		if (m.type() === 'error') console.log(`  [${name} console.error] ${m.text().slice(0, 160)}`);
	});
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

async function failing(option: string, fails: number) {
	console.log(`\n== ${option}: first ${fails} open(s) fail, then Retry until ready`);
	const [context, page] = await fresh(option);
	await page.goto(`${base}/proto/${option}?fail=${fails}`);
	await page.waitForTimeout(800);
	console.log(`  shown: "${await text(page)}" ${await counts(page)}`);
	for (let i = 0; i < fails; i++) {
		await page.getByRole('button', { name: 'Retry' }).click();
		await page.waitForTimeout(800);
		console.log(`  after Retry ${i + 1}: "${await text(page)}" ${await counts(page)}`);
	}
	await context.close();
}

async function boom(option: string) {
	console.log(`\n== ${option}: the page has a render bug`);
	const [context, page] = await fresh(option);
	await page.goto(`${base}/proto/${option}?boom=1`);
	await page.waitForTimeout(1000);
	console.log(`  shown: "${await text(page)}" ${await counts(page)}`);
	for (const name of ['Retry', 'Retry page']) {
		const button = page.getByRole('button', { name, exact: true });
		if ((await button.count()) === 0) continue;
		await button.click();
		await page.waitForTimeout(800);
		console.log(`  after "${name}": "${await text(page)}" ${await counts(page)}`);
	}
	await context.close();
}

async function peek() {
	console.log('\n== s: a component outside <Opening> reads the client while opening');
	const [context, page] = await fresh('s');
	await page.goto(`${base}/proto/s?peek=1&delay=800`);
	await page.waitForTimeout(300);
	console.log(`  t=300ms "${await text(page)}"`);
	await page.waitForTimeout(1200);
	console.log(`  t=1500ms "${await text(page)}"`);
	await context.close();
}

async function roundTrip(option: string) {
	console.log(`\n== ${option}: navigate in, out to /proto/other, back in, twice`);
	const [context, page] = await fresh(option);
	await page.goto(`${base}/proto/other`);
	await page.getByTestId('other').waitFor();
	for (let i = 0; i < 2; i++) {
		await page.getByRole('link', { name: `to ${option}`, exact: true }).click();
		await page.getByTestId('ready').waitFor();
		await page.goBack();
		await page.getByTestId('other').waitFor();
	}
	await page.waitForTimeout(300);
	console.log(`  after two visits: ${await counts(page)}`);
	await context.close();
}

async function models() {
	console.log('\n== s: modelChoices() persists itself with no place argument');
	const [context, page] = await fresh('s');
	await page.goto(`${base}/proto/s`);
	await page.getByTestId('ready').waitFor();
	console.log(`  before: "${await page.getByTestId('model').innerText()}"`);
	await page.getByRole('button', { name: 'Choose small' }).click();
	await page.reload();
	await page.getByTestId('ready').waitFor();
	console.log(`  after reload: "${await page.getByTestId('model').innerText()}"`);
	await context.close();
}

if (run('wait')) for (const o of ['cr', 's']) await waiting(o);
if (run('fail')) for (const o of ['cr', 's']) await failing(o, 2);
if (run('boom')) for (const o of ['r', 'cr', 'ck', 's']) await boom(o);
if (run('peek')) await peek();
if (run('trip')) for (const o of ['cr', 's']) await roundTrip(o);
if (run('models')) await models();
await browser.close();
