import { browserWorkspaceDatabaseName } from '@epicenter/workspace/sqlite/browser';
import { chromium } from 'playwright';
import { todosWorkspaceDefinition } from './src/versions/v1/definition.js';

const port = 5177;
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		'bun',
		'x',
		'vite',
		'preview',
		'--host',
		'127.0.0.1',
		'--port',
		String(port),
	],
	{
		cwd: import.meta.dir,
		stdout: 'ignore',
		stderr: 'inherit',
	},
);

async function waitForServer(): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await fetch(origin);
			if (response.ok) return;
		} catch {
			// Preview is still starting.
		}
		await Bun.sleep(50);
	}
	throw new Error('Todos preview did not start');
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	await waitForServer();
	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));

	await page.goto(origin);
	await page.getByLabel('Task title').fill('Persist through SQLite reload');
	await page.getByRole('button', { name: 'Add' }).click();
	await page.getByText('Persist through SQLite reload').waitFor();

	const expectedDatabaseName = await browserWorkspaceDatabaseName(
		todosWorkspaceDefinition,
		{ kind: 'local' },
	);
	const entries = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const [name] of root as FileSystemDirectoryHandle &
			AsyncIterable<[string, FileSystemHandle]>) {
			names.push(name);
		}
		return names;
	});
	if (!entries.includes(expectedDatabaseName)) {
		throw new Error(`Todos OPFS database is missing: ${entries.join(', ')}`);
	}

	await page.reload();
	await page.getByText('Persist through SQLite reload').waitFor();
	if (errors.length > 0) {
		throw new Error(`Todos browser errors: ${errors.join('; ')}`);
	}
	await context.close();
} finally {
	await browser?.close();
	server.kill();
	await server.exited;
}
