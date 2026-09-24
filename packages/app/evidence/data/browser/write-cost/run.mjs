import { chromium } from 'playwright';

const file = process.argv[2];
const configs = JSON.parse(process.argv[3]);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE THROW:', e.message));
await page.goto('file://' + file);
await page.waitForFunction(
	() => document.getElementById('status')?.textContent === 'ready',
	null,
	{ timeout: 20000 },
);
for (const cfg of configs) {
	await page.evaluate((c) => {
		for (const [k, v] of Object.entries(c)) {
			const el = document.getElementById(k);
			if (el) el.value = String(v);
		}
		document.getElementById('status').textContent = 'queued';
	}, cfg);
	await page.waitForSelector('#run:not([disabled])');
	await page.click('#run');
	await page.waitForFunction(
		() => {
			const s = document.getElementById('status')?.textContent;
			return s === 'done' || s?.startsWith('failed');
		},
		null,
		{ timeout: 900000 },
	);
	console.log('\n================================================');
	console.log('CONFIG:', JSON.stringify(cfg));
	console.log(
		'STATUS:',
		await page.textContent('#status'),
		'|',
		await page.textContent('#baseline'),
	);
	for (const sel of ['#disk', '#wire']) {
		const rows = await page.$$eval(sel + ' tr', (trs) =>
			trs.map((tr) =>
				[...tr.children]
					.map((c) => c.innerText.replace(/\n/g, ' · ').trim())
					.join('\t'),
			),
		);
		console.log('--- ' + sel.slice(1) + ' ---');
		console.log(rows.join('\n'));
	}
}
await browser.close();
