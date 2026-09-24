/**
 * Where a browser will let a synchronous write to durable storage happen.
 *
 * Run: `bun run evidence/browser/sync-access-handle.ts`
 *
 * This settles where a browser store's DURABLE LOG lives, and nothing else. Be
 * careful with the answer: it was briefly read as meaning a page cannot host the
 * store at all, which is false. `apps/sync-lab/ui/main.ts` is `createLocalStore` over
 * sqlite-wasm `:memory:` on a browser main thread, deployed and working. The
 * store needs a synchronous HANDLE, not synchronous DURABILITY, and every read a
 * person makes comes from the `Y.Doc` in memory rather than from SQLite.
 *
 * What the answer does decide is whether the durable log can sit in the page
 * beside the in-memory database or has to sit behind a port. sqlite-wasm's only
 * durable backing in a browser is the origin private file system, reached
 * through `FileSystemFileHandle.createSyncAccessHandle`.
 *
 * MDN says it is "only available in Dedicated Web Workers". That is not a
 * measurement. This is.
 *
 * CONTROL: the worker arm must SUCCEED. If both arms report the handle missing,
 * the probe found a browser with no OPFS at all, or an insecure origin, and it
 * has measured its own harness rather than the platform.
 */
import { chromium } from 'playwright';

const PAGE = `<!doctype html><meta charset="utf-8"><title>sync access handle</title>`;

/**
 * Ask one JavaScript context whether it can take a sync access handle.
 *
 * Returns what the context saw rather than a boolean, because "the property is
 * missing" and "the call threw" are different answers and only the first one
 * means the capability is absent by design.
 */
const PROBE = `async () => {
	const root = await navigator.storage.getDirectory();
	const file = await root.getFileHandle('epicenter-probe', { create: true });
	if (typeof file.createSyncAccessHandle !== 'function') {
		return { available: false, reason: 'createSyncAccessHandle is not a function' };
	}
	try {
		const handle = await file.createSyncAccessHandle();
		// Actually write through it. A handle that exists and refuses every write
		// would answer this question the same way as one that is missing.
		const wrote = handle.write(new TextEncoder().encode('epicenter'), { at: 0 });
		handle.flush();
		handle.close();
		return { available: true, bytesWritten: wrote };
	} catch (cause) {
		return { available: false, reason: String(cause) };
	}
}`;

const browser = await chromium.launch();
try {
	const context = await browser.newContext();
	const page = await context.newPage();
	// `localhost` over `http` is a secure context, which OPFS requires. Fulfilled
	// by routing rather than by a server, so nothing has to be started.
	await page.route('http://localhost/**', (route) =>
		route.fulfill({ contentType: 'text/html', body: PAGE }),
	);
	await page.goto('http://localhost/');

	const onTheMainThread = await page.evaluate(`(${PROBE})()`);

	const inADedicatedWorker = await page.evaluate(`
		new Promise((resolve) => {
			const source = 'self.onmessage = async () => { try { self.postMessage(await (' + ${JSON.stringify(PROBE)} + ')()) } catch (cause) { self.postMessage({ available: false, reason: String(cause) }) } }';
			const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
			worker.onmessage = (event) => { worker.terminate(); resolve(event.data) };
			worker.postMessage(null);
		})
	`);

	console.log('context           available  detail');
	for (const [where, result] of [
		['main thread', onTheMainThread],
		['dedicated worker', inADedicatedWorker],
	] as const) {
		const { available, ...detail } = result as {
			available: boolean;
			[key: string]: unknown;
		};
		console.log(
			`${where.padEnd(18)}${String(available).padEnd(11)}${JSON.stringify(detail)}`,
		);
	}

	const worker = inADedicatedWorker as { available: boolean };
	if (!worker.available) {
		throw new Error(
			'CONTROL FAILED: the dedicated worker could not take a sync access handle either, so this run measured the harness rather than the platform',
		);
	}
	const main = onTheMainThread as { available: boolean };
	console.log(
		main.available
			? '\nA page can hold its own durable log, so no worker is needed for one.'
			: '\nSQLite cannot hold a durable log from the page, so anything that needs one\nneeds a worker. Epicenter Data does not: its durable record is IndexedDB\n(ADR-0280). This bounds an APP-owned SQLite instead (ADR-0312).',
	);
} finally {
	await browser.close();
}
