import { browserWorkspaceDatabaseName } from '@epicenter/workspace/sqlite/browser';
import { chromium } from 'playwright';
import { vocabWorkspaceDefinition } from './src/versions/v1/definition.js';

const port = 5178;
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
	throw new Error('Vocab preview did not start');
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
	await page.getByPlaceholder('Entry').fill('persisted phrase');
	await page.getByRole('button', { name: 'Add entry' }).click();
	await page.getByText('persisted phrase').waitFor();
	await page
		.getByRole('button', { name: 'Toggle pronunciation readings' })
		.click();
	await page.getByText('Show readings', { exact: true }).waitFor();
	await page.getByText('New Chat').first().waitFor();

	const expectedDatabaseName = await browserWorkspaceDatabaseName(
		vocabWorkspaceDefinition,
		{ kind: 'local' },
	);
	const storage = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const opfs: string[] = [];
		for await (const [name] of root as FileSystemDirectoryHandle &
			AsyncIterable<[string, FileSystemHandle]>) {
			opfs.push(name);
		}
		const indexedDb = (await indexedDB.databases())
			.map((database) => database.name)
			.filter((name): name is string => typeof name === 'string');
		return { opfs, indexedDb };
	});
	if (!storage.opfs.includes(expectedDatabaseName)) {
		throw new Error(
			`Vocab OPFS database is missing: ${storage.opfs.join(', ')}`,
		);
	}
	const kvDatabase = `${vocabWorkspaceDefinition.kvDocumentGuid}.standalone`;
	if (!storage.indexedDb.includes(kvDatabase)) {
		throw new Error(
			`Vocab KV database is missing: ${storage.indexedDb.join(', ')}`,
		);
	}
	if (
		!storage.indexedDb.some(
			(name) =>
				name.startsWith(
					`${vocabWorkspaceDefinition.workspaceId}.conversations.`,
				) &&
				name.includes('.messages.') &&
				name.endsWith('.standalone'),
		)
	) {
		throw new Error(
			`Vocab conversation document is missing: ${storage.indexedDb.join(', ')}`,
		);
	}

	await page.reload();
	await page.getByText('persisted phrase').waitFor();
	await page.getByText('Show readings', { exact: true }).waitFor();
	if (errors.length > 0) {
		throw new Error(`Vocab browser errors: ${errors.join('; ')}`);
	}
	await context.close();
} finally {
	await browser?.close();
	server.kill();
	await server.exited;
}
