// PROTOTYPE. Edits (cr) and (s) files under `vite dev`: did the page reload,
// did the folder reopen, was the old one closed, and what does it show.
// bun .proto-probe/hmr-sync.ts [base]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5299';
const app = join(import.meta.dir, '..');
const browser = await chromium.launch();

const cases: [string, string[]][] = [
	['cr', ['src/lib/proto/cr/app.ts', 'src/routes/proto/cr/+layout.svelte', 'src/routes/proto/cr/+page.svelte']],
	['s', ['src/lib/proto/s/app.ts', 'src/routes/proto/s/+layout.svelte', 'src/routes/proto/s/+page.svelte']],
];
const counts = () => {
	const g = globalThis as { __opens?: number; __closed?: number };
	return `opens=${g.__opens ?? 0} closed=${g.__closed ?? 0}`;
};

for (const [option, files] of cases) {
	const page = await browser.newPage();
	page.on('pageerror', (e) => console.log(`  [${option} pageerror] ${e.message.slice(0, 160)}`));
	await page.goto(`${base}/proto/${option}`);
	await page.getByTestId('ready').waitFor({ timeout: 60_000 });
	for (const file of files) {
		await page.evaluate(() => {
			(window as unknown as { marker: number }).marker = 1;
		});
		const before = await page.evaluate(counts);
		const path = join(app, file);
		const original = await readFile(path, 'utf8');
		const edit = file.endsWith('.ts') ? '\n// edited\n' : '\n<span hidden>edited</span>\n';
		await writeFile(path, original + edit);
		await page.waitForTimeout(2500);
		const same = await page.evaluate(() => (window as unknown as { marker?: number }).marker === 1);
		const after = await page.evaluate(counts);
		const shown = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 60));
		console.log(`${option}: edit ${file} -> ${same ? 'hot update' : 'FULL RELOAD'}, ${before} -> ${after}, shows "${shown}"`);
		await writeFile(path, original);
		await page.waitForTimeout(2500);
	}
	await page.close();
}
await browser.close();
