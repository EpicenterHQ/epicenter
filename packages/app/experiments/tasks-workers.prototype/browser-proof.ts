// Exercise the published real Svelte UI after prove.ts, using only synthetic data.
import { chromium } from 'playwright';
import { api } from './source.js';
const origin = process.argv[2] ?? 'http://localhost:8799';
const token = Bun.env.TASKS_PROTOTYPE_TOKEN;
if (!token) throw new Error('Set TASKS_PROTOTYPE_TOKEN');
const browser = await chromium.launch({
	headless: true,
	...(Bun.env.CHROMIUM_EXECUTABLE
		? { executablePath: Bun.env.CHROMIUM_EXECUTABLE }
		: {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
const failed: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
	if (response.status() >= 400)
		failed.push(`${response.status()} ${response.url()}`);
});
const checks: string[] = [];
function check(condition: unknown, label: string) {
	if (!condition) throw new Error(label);
	checks.push(label);
	console.log('PASS ' + label);
}
const session = await page.request.post(`${origin}/session`, {
	data: { token },
});
check(session.ok(), 'Prototype browser session established');
await page.goto(origin);
await page
	.getByRole('heading', { name: 'Tasks in Workers', exact: true })
	.waitFor();
const title = `Browser proof ${Date.now()}`;
await page.getByRole('textbox', { name: 'New task', exact: true }).fill(title);
await page.getByRole('button', { name: 'Add task', exact: true }).click();
const displayed = `Cloud: ${title}`;
const link = page.getByRole('link', { name: displayed, exact: true });
await link.waitFor();
check(
	await link.isVisible(),
	'Edited Svelte UI calls edited action and renders returned task',
);
const href = await link.getAttribute('href');
const path = href!
	.replace(/^#\//, '')
	.split('/')
	.map(decodeURIComponent)
	.join('/');
await link.click();
await page.getByRole('textbox', { name: 'Title', exact: true }).waitFor();
check(
	(await page
		.getByRole('textbox', { name: 'Title', exact: true })
		.inputValue()) === displayed,
	'Task detail route loads stored task',
);
await page.getByRole('checkbox', { name: 'Mark done', exact: true }).click();
await page
	.getByRole('checkbox', { name: 'Mark not done', exact: true })
	.waitFor();
await page.waitForFunction(() => !document.querySelector('fieldset[disabled]'));
await page.reload();
await page
	.getByRole('checkbox', { name: 'Mark not done', exact: true })
	.waitFor();
check(
	await page
		.getByRole('checkbox', { name: 'Mark not done', exact: true })
		.isChecked(),
	'Completion survives browser reload',
);
await page.screenshot({
	path: 'evidence/cloudflare-task-detail.png',
	fullPage: true,
});
await page.goto(new URL('./', page.url().split('#')[0]).href);
await page
	.getByRole('heading', { name: 'Tasks in Workers', exact: true })
	.waitFor();
await page.screenshot({
	path: 'evidence/cloudflare-tasks-desktop.png',
	fullPage: true,
});
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({
	path: 'evidence/cloudflare-tasks-mobile.png',
	fullPage: true,
});
check(errors.length === 0, 'No browser JavaScript errors');
check(failed.length === 0, 'No failed app or asset HTTP responses');
const status: any = (await api(origin, '/admin/status')).value;
const answer = await api(origin, `/tasks~${status.active}/delete`, { path });
check(answer.response.ok, 'Synthetic browser task cleaned up');
const report = {
	origin,
	completed: new Date().toISOString(),
	checks,
	errors,
	failed,
	active: status.active,
};
await Bun.write('evidence/browser-proof.json', JSON.stringify(report, null, 2));
await browser.close();
