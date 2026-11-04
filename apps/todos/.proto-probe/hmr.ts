// PROTOTYPE. Edits each option's files under `vite dev` and reports whether the
// page reloaded and whether the world reopened.
// bun .proto-probe/hmr.ts [base]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5299';
const app = join(import.meta.dir, '..');
const browser = await chromium.launch();

const cases: [string, string[]][] = [
	['a', ['src/lib/proto/a/ListA.svelte', 'src/lib/proto/a/app.ts']],
	['c', ['src/lib/proto/c/ListC.svelte', 'src/routes/proto/c/+layout.svelte', 'src/lib/proto/c/world.ts']],
	['f', ['src/lib/proto/f/ListF.svelte', 'src/lib/proto/f/app.ts']],
];

for (const [option, files] of cases) {
	const page = await browser.newPage();
	await page.goto(`${base}/proto/${option}`);
	await page.getByTestId('ready').waitFor({ timeout: 60_000 });
	for (const file of files) {
		await page.evaluate(() => {
			(window as unknown as { marker: number }).marker = 1;
		});
		const before = await page.evaluate(() => (globalThis as { __opens?: number }).__opens ?? 0);
		const path = join(app, file);
		const original = await readFile(path, 'utf8');
		const edit = file.endsWith('.ts') ? '\n// edited\n' : '\n<span hidden>edited</span>\n';
		await writeFile(path, original + edit);
		await page.waitForTimeout(2500);
		const sameDocument = await page.evaluate(
			() => (window as unknown as { marker?: number }).marker === 1,
		);
		const after = await page.evaluate(() => (globalThis as { __opens?: number }).__opens ?? 0);
		const shown = await page.evaluate(() =>
			document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 60),
		);
		console.log(
			`${option}: edit ${file} -> ${sameDocument ? 'hot update' : 'FULL RELOAD'}, opens ${before} -> ${after}, shows "${shown}"`,
		);
		await writeFile(path, original);
		await page.waitForTimeout(2500);
	}
	await page.close();
}
await browser.close();
