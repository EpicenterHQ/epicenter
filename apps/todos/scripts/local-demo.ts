/**
 * Reproducible browser proof of the public local Folder path. Start
 * `bun dev:todos:ui` from the repository root, then run
 * `bun run --cwd apps/todos demo:local`. Playwright creates an isolated
 * browser context; it never opens the operator's existing Todos profile.
 */
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:5186/';
const folderModule =
	'/@fs' +
	fileURLToPath(
		new URL('../../../packages/folder/src/next/browser.ts', import.meta.url),
	);
const source =
	'---\ntitle: Seed\ndone: false\nextra: keep\n# source note\n---\nNotes from a file\n';
const malformed = '---\ntitle: [broken\n---\nrepair this\n';

function assert(
	condition: boolean | undefined,
	message: string,
): asserts condition {
	if (!condition) throw new Error(message);
}

const browser = await chromium.launch({ headless: true });
try {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 850 },
	});
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(url);
	await page.getByLabel('New todo title').waitFor();
	assert(
		(await page.evaluate(() => indexedDB.databases())).length === 1,
		'Expected one IndexedDB database',
	);

	await page.getByLabel('New todo title').fill('Milk');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await page
		.getByRole('textbox', { name: 'Title', exact: true })
		.fill('Oat milk');
	await page.getByLabel('Notes').fill('Two litres');
	await page.getByLabel('Notes').blur();
	await page.getByRole('checkbox', { name: 'Done' }).click();
	await page.waitForFunction(() =>
		document
			.querySelector('[data-testid="status-summary"]')
			?.getAttribute('aria-label')
			?.includes('Saved on this device'),
	);

	const other = await context.newPage();
	other.on('pageerror', (error) => errors.push(error.message));
	await other.goto(url);
	await other.getByText('Oat milk', { exact: true }).first().click();
	await other.getByLabel('Notes').fill('Two litres\nfrom tab two');
	await other.getByLabel('Notes').blur();
	await page.waitForFunction(() =>
		document
			.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]')
			?.value.includes('from tab two'),
	);
	await context.setOffline(true);
	await page
		.getByRole('textbox', { name: 'Title', exact: true })
		.fill('Oat milk offline');
	await page.getByRole('textbox', { name: 'Title', exact: true }).blur();
	await page.waitForFunction(() =>
		document
			.querySelector('[data-testid="status-summary"]')
			?.getAttribute('aria-label')
			?.includes('Saved on this device'),
	);
	await context.setOffline(false);
	await page.reload();
	assert(
		(await page
			.getByRole('textbox', { name: 'Title', exact: true })
			.inputValue()) === 'Oat milk offline',
		'Reopen lost the title',
	);
	assert(
		(await page.getByLabel('Notes').inputValue()).includes('from tab two'),
		'Reopen lost the other tab’s edit',
	);

	await page.getByLabel('New todo title').fill('Bread');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByText('Bread', { exact: true }).first().waitFor();
	const adjacent = await page.evaluate(async (module) => {
		const { openFolder } = await import(/* @vite-ignore */ module);
		const opened = await openFolder({ tables: { todos: { type: 'object' } } });
		if (opened.error) throw opened.error;
		try {
			const id = opened.data.tables.todos
				.rows()
				.find(
					(row: { fields: { title?: string } }) =>
						row.fields.title === 'Oat milk offline',
				)?.id;
			if (!id) throw new Error('Missing todo for adjacent file check');
			const path = `todos/${id}/attachment.txt`;
			const saved = await opened.data.write(path, 'Keep this file');
			if (saved.error) throw saved.error;
			return path;
		} finally {
			await opened.data.close();
		}
	}, folderModule);
	await page.getByText('Oat milk offline', { exact: true }).first().click();
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete', exact: true })
		.click();
	await page
		.getByText('Oat milk offline', { exact: true })
		.first()
		.waitFor({ state: 'detached' });
	await page.reload();
	await page.getByText('Bread', { exact: true }).first().waitFor();
	assert(
		(await page.getByText('Bread', { exact: true }).count()) > 0,
		'Delete removed the other todo',
	);
	assert(
		(await page.getByText('Oat milk offline', { exact: true }).count()) === 0,
		'Deleted todo reappeared',
	);
	assert(
		(await page.evaluate(
			async ({ module, path }) => {
				const { openFolder } = await import(/* @vite-ignore */ module);
				const opened = await openFolder({ tables: {} });
				if (opened.error) throw opened.error;
				try {
					return opened.data.file(path)?.data;
				} finally {
					await opened.data.close();
				}
			},
			{ module: folderModule, path: adjacent },
		)) === 'Keep this file',
		'Delete removed the adjacent file',
	);

	// Seed a file through the package's public browser entry. The app reads it
	// through the same origin's Folder handle and its supplied schema.
	await page.evaluate(
		async ({ module, text }) => {
			const { openFolder } = await import(/* @vite-ignore */ module);
			const opened = await openFolder({
				tables: {
					todos: {
						type: 'object',
						properties: {
							title: { type: 'string' },
							done: { type: 'boolean' },
						},
						required: ['title', 'done'],
					},
				},
			});
			if (opened.error) throw opened.error;
			try {
				const saved = await opened.data.write('todos/seed.md', text);
				if (saved.error) throw saved.error;
			} finally {
				await opened.data.close();
			}
		},
		{ module: folderModule, text: source },
	);
	await page.getByText('Seed', { exact: true }).first().click();
	await page
		.getByRole('textbox', { name: 'Title', exact: true })
		.fill('Edited seed');
	await page.getByRole('textbox', { name: 'Title', exact: true }).blur();
	await page.waitForFunction(() =>
		document
			.querySelector('[data-testid="status-summary"]')
			?.getAttribute('aria-label')
			?.includes('Saved on this device'),
	);
	const readSeed = () =>
		page.evaluate(async (module) => {
			const { openFolder } = await import(/* @vite-ignore */ module);
			const opened = await openFolder({ tables: {} });
			if (opened.error) throw opened.error;
			try {
				return opened.data.file('todos/seed.md')?.data;
			} finally {
				await opened.data.close();
			}
		}, folderModule);
	const preserved = await readSeed();
	assert(
		preserved?.includes('title: Edited seed') &&
			preserved.includes('extra: keep') &&
			!preserved.includes('# source note'),
		'Editing did not write canonical frontmatter',
	);

	await page.evaluate(
		async ({ module, text }) => {
			const { openFolder } = await import(/* @vite-ignore */ module);
			const opened = await openFolder({ tables: {} });
			if (opened.error) throw opened.error;
			try {
				const saved = await opened.data.write('todos/broken.md', text);
				if (saved.error) throw saved.error;
			} finally {
				await opened.data.close();
			}
		},
		{ module: folderModule, text: malformed },
	);
	await page.getByRole('button', { name: 'Show', exact: true }).click();
	assert(
		(await page.getByLabel('Text of todos/broken.md').innerText()) ===
			malformed,
		'Repairable source was hidden',
	);
	await page.getByText('Edited seed', { exact: true }).first().click();

	await page.evaluate(() => {
		Reflect.set(window, 'originalPut', IDBObjectStore.prototype.put);
		IDBObjectStore.prototype.put = () => {
			throw new DOMException('Disk is full', 'QuotaExceededError');
		};
	});
	await page
		.getByRole('textbox', { name: 'Title', exact: true })
		.fill('Draft survives failure');
	await page.getByRole('textbox', { name: 'Title', exact: true }).blur();
	await page.getByText('Could not save todos/seed.md').waitFor();
	assert(
		(await page
			.getByRole('textbox', { name: 'Title', exact: true })
			.inputValue()) === 'Edited seed',
		'Failed save did not return to the disk title',
	);
	await page.getByRole('button', { name: 'Copy your text' }).waitFor();
	assert(
		!(await readSeed())?.includes('Draft survives failure'),
		'Failed save reached storage',
	);
	await page.evaluate(() => {
		Reflect.set(
			IDBObjectStore.prototype,
			'put',
			Reflect.get(window, 'originalPut'),
		);
	});
	await page
		.getByRole('textbox', { name: 'Title', exact: true })
		.fill('Draft saved on retry');
	await page.waitForFunction(() =>
		document
			.querySelector('[data-testid="status-summary"]')
			?.getAttribute('aria-label')
			?.includes('Saved on this device'),
	);
	assert(
		(await readSeed())?.includes('title: Draft saved on retry'),
		'Next edit did not store the title',
	);
	const databases = await page.evaluate(() => indexedDB.databases());
	assert(
		databases.some((database) => database.name === 'epicenter.folder.default'),
		'New repository engine did not store the work',
	);
	assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
	await page.screenshot({
		path: '/tmp/epicenter-todos-local-demo.png',
		fullPage: true,
	});
	console.log(
		JSON.stringify(
			{
				url,
				checks: [
					'fresh local open',
					'add/edit/complete/delete',
					'adjacent file retained',
					'reopen',
					'two tabs',
					'offline edit',
					'unknown fields and canonical frontmatter',
					'malformed source visible',
					'failed save and next edit',
				],
				database: 'epicenter.folder.default',
				screenshot: '/tmp/epicenter-todos-local-demo.png',
				browserErrors: errors,
			},
			null,
			2,
		),
	);
	await context.close();
} finally {
	await browser.close();
}
