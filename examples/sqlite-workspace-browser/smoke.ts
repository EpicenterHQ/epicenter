import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { asPrincipalId } from '@epicenter/identity';
import {
	createBunRecords,
	type Env,
	mountRecordsApp,
} from '@epicenter/server/bun';
import { Hono } from 'hono';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { workspaceDefinition as versionOneDefinition } from './src/versions/v1/definition.js';
import { workspaceDefinition as versionTwoDefinition } from './src/versions/v2/definition.js';

const port = 5198;
const origin = `http://127.0.0.1:${port}`;
const versionOnePath = '/previous/v1/';
const recordsDirectory = mkdtempSync(join(tmpdir(), 'epicenter-records-'));
const records = createBunRecords({
	dir: recordsDirectory,
	sha256: async (value) => createHash('sha256').update(value).digest('hex'),
});
const openedAuthorityWorkspaceIds = new Set<string>();
const observedSyncPaths: string[] = [];
const recordsBackend = {
	...records.records,
	async open(
		partition: Parameters<typeof records.records.open>[0],
		request: Parameters<typeof records.records.open>[1],
	) {
		openedAuthorityWorkspaceIds.add(partition.workspaceId);
		return records.records.open(partition, request);
	},
};
const recordsApp = new Hono<Env>();
recordsApp.use('*', async (c, next) => {
	observedSyncPaths.push(new URL(c.req.url).pathname);
	await next();
	c.header('access-control-allow-origin', origin);
	c.header('access-control-allow-methods', 'POST, OPTIONS');
	c.header('access-control-allow-headers', 'content-type');
	c.header('cross-origin-resource-policy', 'cross-origin');
});
recordsApp.options('*', (c) => c.body(null, 204));
mountRecordsApp(recordsApp, {
	resolveRecords: () => recordsBackend,
	auth: async (c, next) => {
		c.set('principal', { id: asPrincipalId('browser-smoke') });
		await next();
	},
});
const recordsServer = Bun.serve({
	port: 5199,
	fetch: recordsApp.fetch,
});
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

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

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
	throw new Error('Vite preview did not start');
}

const browserErrors: string[] = [];
function observeErrors(page: Page): void {
	page.on('pageerror', (error) => browserErrors.push(error.message));
}

async function waitForState(page: Page, state: string): Promise<void> {
	await page.waitForFunction(
		(expected) => document.body.dataset.state === expected,
		state,
	);
}

async function opfsEntries(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const [name] of root as FileSystemDirectoryHandle &
			AsyncIterable<[string, FileSystemHandle]>) {
			names.push(name);
		}
		return names.toSorted();
	});
}

async function pollFor<T>(
	read: () => Promise<T>,
	accept: (value: T) => boolean,
) {
	let value = await read();
	for (let attempt = 0; attempt < 200 && !accept(value); attempt++) {
		await Bun.sleep(10);
		value = await read();
	}
	return value;
}

function versionTwoSyncRequestCount(): number {
	return observedSyncPaths.filter((path) =>
		path.startsWith(`/api/records/${versionTwoDefinition.workspaceId}/`),
	).length;
}

function collectCurrentJavaScript(html: string): Map<string, string> {
	const sources = new Map<string, string>();
	const pending = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(
		([, source]) => source,
	);

	while (pending.length > 0) {
		const source = pending.pop();
		if (!source) continue;
		const relativePath = source.startsWith('/') ? source.slice(1) : source;
		if (sources.has(relativePath)) continue;
		const outputPath = join(import.meta.dir, 'dist', relativePath);
		if (!existsSync(outputPath)) continue;
		const contents = readFileSync(outputPath, 'utf8');
		sources.set(relativePath, contents);
		for (const [, reference] of contents.matchAll(/["']([^"']+\.js)["']/g)) {
			const referencedPath = reference.startsWith('/')
				? reference.slice(1)
				: join(dirname(relativePath), reference);
			if (!sources.has(referencedPath)) pending.push(referencedPath);
		}
	}

	return sources;
}

async function proveVersionOneReplication(
	browser: Browser,
): Promise<BrowserContext[]> {
	const contextA = await browser.newContext();
	const contextB = await browser.newContext();
	const pageA = await contextA.newPage();
	const pageB = await contextB.newPage();
	for (const page of [pageA, pageB]) {
		observeErrors(page);
		await page.goto(`${origin}${versionOnePath}?replica`);
		await waitForState(page, 'ready');
	}
	const created = await pageA.evaluate(() =>
		window.versionOneSmoke.create({ title: 'Version 1 synchronized' }),
	);
	const replicated = await pollFor(
		() => pageB.evaluate((id) => window.versionOneSmoke.get(id), created.id),
		(row) => row?.title === created.title,
	);
	assert(
		replicated?.title === created.title,
		'Version one replicas did not converge',
	);
	await pageA.evaluate(() => window.versionOneSmoke.dispose());
	await pageB.evaluate(() => window.versionOneSmoke.dispose());
	return [contextA, contextB];
}

async function proveVersionTwoReplication(
	browser: Browser,
): Promise<BrowserContext[]> {
	const contextA = await browser.newContext();
	const contextB = await browser.newContext();
	const pageA = await contextA.newPage();
	const pageB = await contextB.newPage();
	for (const page of [pageA, pageB]) {
		observeErrors(page);
		const requestsBeforeGate = versionTwoSyncRequestCount();
		await page.goto(`${origin}/?replica`);
		await waitForState(page, 'gate');
		assert(
			versionTwoSyncRequestCount() === requestsBeforeGate,
			'Fresh current build contacted sync before consent',
		);
		assert(
			(await opfsEntries(page)).length === 0,
			'Fresh current build created OPFS storage before consent',
		);
		const persistedKvDatabases = await page.evaluate(async () =>
			(await indexedDB.databases()).map(({ name }) => name),
		);
		assert(
			persistedKvDatabases.length === 0,
			`KV storage existed before consent: ${JSON.stringify(persistedKvDatabases)}`,
		);
	}
	for (const page of [pageA, pageB]) {
		await page.getByRole('button', { name: 'Start current version' }).click();
		await waitForState(page, 'ready');
	}
	const created = await pageA.evaluate(() =>
		window.versionTwoSmoke.create({
			title: 'Version 2 synchronized',
			archived: false,
		}),
	);
	const replicated = await pollFor(
		() => pageB.evaluate((id) => window.versionTwoSmoke.get(id), created.id),
		(row) => row?.title === created.title,
	);
	assert(
		replicated?.title === created.title,
		'Version two replicas did not converge',
	);
	await pageA.evaluate(() => window.versionTwoSmoke.dispose());
	await pageA.reload();
	await waitForState(pageA, 'ready');
	const reopened = await pageA.evaluate(
		(id) => window.versionTwoSmoke.get(id),
		created.id,
	);
	assert(
		reopened?.title === created.title,
		'Initialized version two replica did not reopen',
	);
	await pageA.evaluate(() => window.versionTwoSmoke.dispose());
	await pageB.evaluate(() => window.versionTwoSmoke.dispose());
	return [contextA, contextB];
}

let browser: Browser | undefined;
const contexts: BrowserContext[] = [];

try {
	const assets = readdirSync(join(import.meta.dir, 'dist', 'assets'));
	assert(
		assets.some((name) => name.endsWith('.wasm')),
		'Production build did not emit SQLite WASM',
	);
	assert(
		assets.some((name) => name.includes('sqlite3-opfs-async-proxy')),
		'Production build did not emit the OPFS async proxy',
	);
	const currentHtml = readFileSync(
		join(import.meta.dir, 'dist', 'index.html'),
		'utf8',
	);
	const currentJavaScript = collectCurrentJavaScript(currentHtml);
	const currentBundle = [...currentJavaScript.values()].join('\n');
	assert(
		currentBundle.includes('dataVersion:2') &&
			currentBundle.includes('archived'),
		'Current bundle did not author the version two records schema',
	);
	assert(
		!currentBundle.includes(versionOneDefinition.recordsDescriptor) &&
			!currentBundle.includes('versionOneSmoke'),
		'Current bundle contains the historical version records schema',
	);
	for (const worker of [
		'replica-inspector.worker',
		'standalone-inspector.worker',
		'standalone.worker',
		'replica.worker',
	]) {
		assert(
			[...currentJavaScript.keys()].some((source) => source.includes(worker)),
			`Current bundle traversal missed ${worker}`,
		);
	}
	for (const source of [
		'src/versions/v2/main.ts',
		'src/versions/v2/definition.ts',
		'src/versions/v2/workspace.ts',
		'src/versions/v2/replica-inspector.worker.ts',
		'src/versions/v2/standalone-inspector.worker.ts',
		'src/versions/v2/standalone.worker.ts',
		'src/versions/v2/replica.worker.ts',
	]) {
		const sourceText = readFileSync(join(import.meta.dir, source), 'utf8');
		assert(
			!/(?:from\s+|import\()["'][^"']*g1\//.test(sourceText),
			`Current version source imports historical code: ${source}`,
		);
	}

	await waitForServer();
	browser = await chromium.launch({ headless: true });

	const lifecycleContext = await browser.newContext();
	contexts.push(lifecycleContext);
	const versionOne = await lifecycleContext.newPage();
	observeErrors(versionOne);
	await versionOne.goto(`${origin}${versionOnePath}`);
	await waitForState(versionOne, 'ready');
	const originalVersionOneRow = await versionOne.evaluate(() =>
		window.versionOneSmoke.create({ title: 'Existing version one row' }),
	);
	const versionOneBeforeStart = await versionOne.evaluate(() =>
		window.versionOneSmoke.list(),
	);
	const entriesWithOnlyVersionOne = await opfsEntries(versionOne);
	assert(
		entriesWithOnlyVersionOne.includes(
			`${versionOneDefinition.workspaceId}.sqlite3`,
		),
		'Version one SQLite file was not initialized',
	);
	assert(
		!entriesWithOnlyVersionOne.includes(
			`${versionTwoDefinition.workspaceId}.sqlite3`,
		),
		'Version two SQLite file existed before its build loaded',
	);

	const current = await lifecycleContext.newPage();
	observeErrors(current);
	await current.goto(origin);
	await waitForState(current, 'gate');
	assert(
		JSON.stringify(await opfsEntries(current)) ===
			JSON.stringify(entriesWithOnlyVersionOne),
		'Current build changed OPFS storage before consent',
	);
	await current.reload();
	await waitForState(current, 'gate');
	assert(
		JSON.stringify(await opfsEntries(current)) ===
			JSON.stringify(entriesWithOnlyVersionOne),
		'Reloading the gate changed OPFS storage before consent',
	);
	await current
		.getByRole('link', { name: 'Continue with previous version' })
		.click();
	await current.waitForURL(`${origin}${versionOnePath}`);
	await waitForState(current, 'ready');
	assert(
		(
			await current.evaluate(
				(id) => window.versionOneSmoke.get(id),
				originalVersionOneRow.id,
			)
		)?.title === originalVersionOneRow.title,
		'Continue did not open version one',
	);
	assert(
		JSON.stringify(await opfsEntries(current)) ===
			JSON.stringify(entriesWithOnlyVersionOne),
		'Continue changed OPFS storage or initialized version two',
	);
	await current.evaluate(() => window.versionOneSmoke.dispose());
	await current.close();

	const currentAfterContinue = await lifecycleContext.newPage();
	observeErrors(currentAfterContinue);
	await currentAfterContinue.goto(origin);
	await waitForState(currentAfterContinue, 'gate');
	await currentAfterContinue
		.getByRole('button', { name: 'Start current version' })
		.click();
	await waitForState(currentAfterContinue, 'ready');
	const versionOneAfterStart = await versionOne.evaluate(() =>
		window.versionOneSmoke.list(),
	);
	assert(
		JSON.stringify(versionOneAfterStart) ===
			JSON.stringify(versionOneBeforeStart),
		'Starting version two changed version one records',
	);

	const versionTwoRow = await currentAfterContinue.evaluate(() =>
		window.versionTwoSmoke.create({
			title: 'Independent version two row',
			archived: false,
		}),
	);
	assert(
		(await versionOne.evaluate(
			(id) => window.versionOneSmoke.get(id),
			versionTwoRow.id,
		)) === null,
		'Version one could read a version two record',
	);
	const laterVersionOneRow = await versionOne.evaluate(() =>
		window.versionOneSmoke.create({
			title: 'Version one stays writable',
		}),
	);
	assert(
		(await currentAfterContinue.evaluate(
			(id) => window.versionTwoSmoke.get(id),
			laterVersionOneRow.id,
		)) === null,
		'Version two could read a version one record',
	);

	const versionOneIdentity = await versionOne.evaluate(() =>
		window.versionOneSmoke.identity(),
	);
	const versionTwoIdentity = await currentAfterContinue.evaluate(() =>
		window.versionTwoSmoke.identity(),
	);
	for (const key of [
		'workspaceId',
		'kvDocumentGuid',
		'childDocumentGuid',
		'declaredBlobIdentity',
	] as const) {
		assert(
			versionOneIdentity[key] !== versionTwoIdentity[key],
			`Version identity did not differ for ${key}`,
		);
	}
	assert(
		versionOneIdentity.childDocumentGuid.includes(
			versionOneIdentity.workspaceId,
		) &&
			versionTwoIdentity.childDocumentGuid.includes(
				versionTwoIdentity.workspaceId,
			),
		'Child-document guid roots did not use their version-specific workspace ids',
	);

	await currentAfterContinue.evaluate(() => window.versionTwoSmoke.dispose());
	await currentAfterContinue.reload();
	await waitForState(currentAfterContinue, 'ready');
	assert(
		(
			await currentAfterContinue.evaluate(
				(id) => window.versionTwoSmoke.get(id),
				versionTwoRow.id,
			)
		)?.title === versionTwoRow.title,
		'Version two did not persist across reload',
	);

	const invalidContext = await browser.newContext();
	contexts.push(invalidContext);
	const invalidPage = await invalidContext.newPage();
	observeErrors(invalidPage);
	await invalidPage.goto(origin);
	await waitForState(invalidPage, 'gate');
	await invalidPage.evaluate(async (filename) => {
		const root = await navigator.storage.getDirectory();
		await root.getFileHandle(filename, { create: true });
	}, `${versionTwoDefinition.workspaceId}.sqlite3`);
	await invalidPage.reload();
	await waitForState(invalidPage, 'invalid');
	assert(
		!(await invalidPage.getByRole('button').allTextContents()).some((label) =>
			label.includes('Start current'),
		),
		'Invalid current storage still offered initialization',
	);

	contexts.push(...(await proveVersionOneReplication(browser)));
	contexts.push(...(await proveVersionTwoReplication(browser)));

	assert(
		JSON.stringify([...openedAuthorityWorkspaceIds].toSorted()) ===
			JSON.stringify(
				[
					versionOneDefinition.workspaceId,
					versionTwoDefinition.workspaceId,
				].toSorted(),
			),
		`Record authority opened unexpected workspaces: ${JSON.stringify([...openedAuthorityWorkspaceIds])}`,
	);
	const authorityDatabases = readdirSync(recordsDirectory).filter((name) =>
		name.endsWith('.sqlite'),
	);
	assert(
		authorityDatabases.length === 2,
		`Expected two independent authority databases: ${JSON.stringify(authorityDatabases)}`,
	);
	for (const workspaceId of openedAuthorityWorkspaceIds) {
		assert(
			observedSyncPaths.some((path) =>
				path.startsWith(`/api/records/${workspaceId}/`),
			),
			`No data-version-blind sync request was observed for ${workspaceId}`,
		);
	}
	assert(
		browserErrors.length === 0,
		`Browser errors: ${browserErrors.join('; ')}`,
	);
} finally {
	for (const context of contexts) await context.close();
	await browser?.close();
	recordsServer.stop(true);
	records.close();
	rmSync(recordsDirectory, { recursive: true, force: true });
	server.kill();
	await server.exited;
}
