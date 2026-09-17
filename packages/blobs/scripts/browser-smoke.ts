import { webkit } from 'playwright';

const bundle = await Bun.build({
	entrypoints: [new URL('../src/browser.ts', import.meta.url).pathname],
	target: 'browser',
	format: 'esm',
});
if (!bundle.success) {
	throw new AggregateError(
		bundle.logs,
		'Could not bundle the browser blob store.',
	);
}
const source = await bundle.outputs[0]?.text();
if (!source) throw new Error('Browser blob bundle was empty.');

const server = Bun.serve({
	port: 0,
	routes: {
		'/': new Response('<!doctype html><title>Blob smoke</title>'),
		'/blobs.js': new Response(source, {
			headers: { 'content-type': 'text/javascript' },
		}),
	},
});

const browser = await webkit.launch();
try {
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${server.port}`);
	const result = await page.evaluate(async () => {
		const moduleUrl = '/blobs.js';
		const { eraseBlobStore, createBrowserBlobStore, createBrowserBlobSources } =
			await import(moduleUrl);
		const fail = (error: unknown): never => {
			throw new Error(
				typeof error === 'object' && error !== null
					? JSON.stringify(error)
					: String(error),
			);
		};
		const id = 'blob_abcdefghijklmnopqrstu';
		const scope = { appId: `so.epicenter.smoke-${crypto.randomUUID()}` };
		const input = new Blob(['webkit bytes'], { type: 'audio/wav' });
		const first = createBrowserBlobStore(scope);
		const put = await first.put(id, input);
		if (put.error) fail(put.error);

		const collision = await first.put(id, new Blob(['replacement']));
		if (collision.error?.name !== 'BlobAlreadyExists') {
			throw new Error('Immutable replacement was not refused.');
		}
		const destinationId = 'blob_123456789012345678901';
		const copied = await first.copy(id, destinationId);
		if (copied.error) fail(copied.error);
		const copyCollision = await first.copy(id, destinationId);
		if (copyCollision.error?.name !== 'BlobAlreadyExists') {
			throw new Error('COPY replaced an immutable destination.');
		}

		// Open a new store instance to prove persistence crosses application reload.
		const reopened = createBrowserBlobStore(scope);
		const stat = await reopened.stat(id);
		if (stat.error) fail(stat.error);
		if (stat.data.size !== input.size || stat.data.contentType !== input.type) {
			throw new Error('Persisted metadata changed after reopen.');
		}
		const stored = await reopened.get(id);
		if (stored.error) fail(stored.error);
		if ((await stored.data.text()) !== 'webkit bytes') {
			throw new Error('Persisted bytes changed after reopen.');
		}
		const batch = await reopened.statMany([id, 'blob_zzzzzzzzzzzzzzzzzzzzz']);
		if (
			batch.length !== 2 ||
			batch[0].data?.size !== input.size ||
			batch[1].error?.name !== 'BlobNotFound'
		) {
			throw new Error(
				'Batched metadata lost its input order or missing result.',
			);
		}

		const sources = createBrowserBlobSources(reopened);
		const opened = await sources.open(id);
		if (opened.error) fail(opened.error);
		if (
			(await fetch(opened.data.url).then((response) => response.text())) !==
			'webkit bytes'
		) {
			throw new Error('Object URL did not expose the stored bytes.');
		}
		opened.data[Symbol.dispose]();
		let revoked = false;
		try {
			await fetch(opened.data.url);
		} catch {
			revoked = true;
		}
		if (!revoked) throw new Error('Disposed object URL remained readable.');

		const deleted = await reopened.delete(id);
		if (deleted.error) fail(deleted.error);
		const missing = await reopened.get(id);
		if (missing.error?.name !== 'BlobNotFound') {
			throw new Error('Deleted bytes remained readable.');
		}
		const independent = await reopened.get(destinationId);
		if (independent.error) fail(independent.error);
		if (
			(await independent.data.text()) !== 'webkit bytes' ||
			independent.data.type !== 'audio/wav'
		) {
			throw new Error('COPY lost bytes or metadata after source deletion.');
		}
		const missingCopy = await reopened.copy(id, 'blob_zzzzzzzzzzzzzzzzzzzzz');
		if (missingCopy.error?.name !== 'BlobNotFound') {
			throw new Error('COPY did not report its missing source.');
		}
		const erased = await eraseBlobStore(scope);
		if (erased.error) fail(erased.error);
		return { size: stat.data.size, contentType: stat.data.contentType };
	});
	process.stdout.write(
		`Browser blob smoke passed on WebKit (${result.size} bytes, ${result.contentType}).\n`,
	);
} finally {
	await browser.close();
	server.stop(true);
}
