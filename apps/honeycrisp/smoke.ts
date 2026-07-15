import { browserWorkspaceDatabaseName } from '@epicenter/workspace/sqlite/browser';
import { chromium } from 'playwright';
import { honeycrispWorkspaceDefinition } from './src/versions/v1/definition.js';

const port = 5179;
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
	throw new Error('Honeycrisp preview did not start');
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
	await page.getByText('No note selected').waitFor();
	await page.keyboard.press('Meta+n');
	const editor = page.locator('.ProseMirror');
	await editor.waitFor();
	await editor.fill('Persisted rich text');
	await page.getByText('Persisted rich text').first().waitFor();

	const expectedDatabaseName = await browserWorkspaceDatabaseName(
		honeycrispWorkspaceDefinition,
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
			`Honeycrisp OPFS database is missing: ${storage.opfs.join(', ')}`,
		);
	}
	if (
		!storage.indexedDb.some(
			(name) =>
				name.startsWith(
					`${honeycrispWorkspaceDefinition.workspaceId}.notes.`,
				) &&
				name.includes('.body.') &&
				name.endsWith('.standalone'),
		)
	) {
		throw new Error(
			`Honeycrisp note document is missing: ${storage.indexedDb.join(', ')}`,
		);
	}

	await page.reload();
	await page.getByText('Persisted rich text').first().waitFor();
	await page.locator('.ProseMirror').getByText('Persisted rich text').waitFor();
	if (errors.length > 0) {
		throw new Error(`Honeycrisp browser errors: ${errors.join('; ')}`);
	}
	await context.close();
} finally {
	await browser?.close();
	server.kill();
	await server.exited;
}
