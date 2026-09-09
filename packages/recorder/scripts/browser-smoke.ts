import { chromium } from 'playwright';

// Chromium's synthetic microphone exercises real MediaRecorder and IndexedDB
// without opening the person's microphone or requiring a permission click.
const bundle = await Bun.build({
	entrypoints: [new URL('../src/browser.ts', import.meta.url).pathname],
	target: 'browser',
	format: 'esm',
});
if (!bundle.success)
	throw new AggregateError(bundle.logs, 'Bundle recording smoke');
const source = await bundle.outputs[0]?.text();
if (!source) throw new Error('Empty recording bundle');
const blobs = await Bun.build({
	entrypoints: [
		new URL('../../blobs/src/browser.ts', import.meta.url).pathname,
	],
	target: 'browser',
	format: 'esm',
});
if (!blobs.success) throw new AggregateError(blobs.logs, 'Bundle blob smoke');
const server = Bun.serve({
	port: 0,
	routes: {
		'/': new Response('<!doctype html><title>Recording smoke</title>'),
		'/recording.js': new Response(source, {
			headers: { 'content-type': 'text/javascript' },
		}),
		'/blobs.js': new Response(await blobs.outputs[0]!.text(), {
			headers: { 'content-type': 'text/javascript' },
		}),
	},
});
const browser = await chromium.launch({
	args: [
		'--use-fake-device-for-media-stream',
		'--use-fake-ui-for-media-stream',
	],
});
try {
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${server.port}`);
	const result = await page.evaluate(async () => {
		async function bounded<T>(
			label: string,
			operation: Promise<T>,
		): Promise<T> {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					operation,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error(`Timed out: ${label}`)),
							10000,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		}
		const recorderModule = '/recording.js';
		const blobModule = '/blobs.js';
		const { createBrowserRecording }: typeof import('../src/browser.js') =
			await import(recorderModule);
		const {
			createBrowserBlobStore,
		}: typeof import('@epicenter/blobs/browser') = await import(blobModule);
		const appId = 'so.epicenter.recording-smoke';
		const recorder = createBrowserRecording(appId, null);
		const started = await bounded('start', recorder.value.start());
		if (started.error) throw new Error(JSON.stringify(started.error));
		const rejected = await recorder.value.start();
		if (rejected.error?.name !== 'AlreadyRecording')
			throw new Error('Competing capture admitted');
		let meterTicks = 0;
		const unlevel = started.data.onLevel(() => {
			meterTicks++;
		});
		await new Promise((resolve) => setTimeout(resolve, 350));
		const stopped = await bounded('stop', started.data.stop());
		unlevel();
		if (stopped.error) throw new Error(JSON.stringify(stopped.error));
		const store = createBrowserBlobStore({ appId, principalId: 'local' });
		const bytes = await bounded('read', store.get(stopped.data.audioBlobId));
		if (bytes.error) throw new Error(JSON.stringify(bytes.error));
		const context = new AudioContext();
		const decoded = await bounded(
			'decode',
			context.decodeAudioData(await bytes.data.arrayBuffer()),
		);
		await bounded('close decoder', context.close());
		if (
			decoded.duration <= 0 ||
			stopped.data.byteLength !== bytes.data.size ||
			meterTicks === 0
		) {
			throw new Error('Recording could not be decoded or metered');
		}
		const next = await bounded('restart', recorder.value.start());
		if (next.error) throw new Error(JSON.stringify(next.error));
		const cancelled = await bounded('cancel', next.data.cancel());
		if (cancelled.error) throw new Error(JSON.stringify(cancelled.error));
		const absent = await store.stat(next.data.audioBlobId);
		if (absent.error?.name !== 'BlobNotFound')
			throw new Error('Cancel published audio');
		await bounded('close recorder', recorder.close());
		const ticksAfterStop = meterTicks;
		await new Promise((resolve) => setTimeout(resolve, 50));
		if (meterTicks !== ticksAfterStop)
			throw new Error('Meter leaked after stop');
		return {
			byteLength: bytes.data.size,
			contentType: bytes.data.type,
			decodedDuration: decoded.duration,
			meterTicks,
			cancelled: true,
		};
	});
	console.log(JSON.stringify(result));
} finally {
	await browser.close();
	server.stop(true);
}
