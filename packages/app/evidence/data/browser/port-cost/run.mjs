import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('THROW:', e.message));
await page.goto('file://' + process.argv[2]);
await page.waitForFunction(
	() => {
		const t = document.getElementById('out')?.textContent ?? '';
		return t.includes('DONE') || t.includes('FAILED');
	},
	null,
	{ timeout: 600000 },
);
console.log(await page.textContent('#out'));
await browser.close();
