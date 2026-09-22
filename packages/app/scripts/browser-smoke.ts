import { chromium } from 'playwright';

import { createServer } from 'vite';

// The complete browser runtime uses real IndexedDB and its SQLite worker.
// Chromium supplies synthetic microphone input to the real MediaRecorder.
const server = await createServer({
	configFile: false,
	optimizeDeps: {
		entries: [
			'packages/app/src/index.ts',
			'packages/app/src/open.ts',
			'packages/app/src/blobs.ts',
			'packages/app/src/recorder.ts',
			'packages/device/src/browser-sqlite.worker.ts',
		],
	},
	root: new URL('../../../', import.meta.url).pathname,
	server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({
	args: [
		'--use-fake-device-for-media-stream',
		'--use-fake-ui-for-media-stream',
		'--autoplay-policy=no-user-gesture-required',
	],
});
try {
	const page = await browser.newPage();
	await page.exposeFunction('disconnectForAcceptance', () =>
		page.context().setOffline(true),
	);
	await page.goto(server.resolvedUrls!.local[0]!);
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
		const appModule = '/packages/app/src/index.ts';
		const dataModule = '/packages/app/src/data/definition/index.ts';
		const openModule = '/packages/app/src/open.ts';
		const { openLocal }: typeof import('../src/open.js') = await import(
			openModule
		);
		const { defineApp }: typeof import('../src/index.js') = await import(
			appModule
		);
		const { defineTable, field }: typeof import('@epicenter/app/definition') =
			await import(dataModule);
		const application = defineApp({
			tables: { recordings: defineTable({ audioBlobId: field.string() }) },
			kv: {},
			id: 'so.epicenter.recording-smoke',
		});
		const app = await bounded('open local', openLocal(application));
		const { openLocalBlobs }: typeof import('../src/blobs.js') = await import(
			'/packages/app/src/blobs.ts'
		);
		const { createRecorder }: typeof import('../src/recorder.js') =
			await import('/packages/app/src/recorder.ts');
		const blobs = await openLocalBlobs({ id: application.id });
		const recorder = createRecorder({ blobs });
		await (
			globalThis as unknown as { disconnectForAcceptance(): Promise<void> }
		).disconnectForAcceptance();
		const table = app.tables.recordings;
		const started = await bounded('start', recorder.start({}));
		if (started.error) throw new Error(JSON.stringify(started.error));
		const rejected = await recorder.start({});
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
		if (table.ids().length !== 0)
			throw new Error('Capture created a row before save');
		const row = table.create({ audioBlobId: stopped.data.blobId });
		const bytes = await bounded('read', blobs.get(stopped.data.blobId));
		if (bytes.error) throw new Error(JSON.stringify(bytes.error));
		const playback = await blobs.open(stopped.data.blobId);
		if (playback.error) throw new Error(JSON.stringify(playback.error));
		const audio = new Audio(playback.data.url);
		await bounded('offline play', audio.play());
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (audio.currentTime <= 0)
			throw new Error('Offline player did not advance.');
		audio.pause();
		playback.data[Symbol.dispose]();
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
		const next = await bounded('restart', recorder.start({}));
		if (next.error) throw new Error(JSON.stringify(next.error));
		const cancelled = await bounded('cancel', next.data.cancel());
		if (cancelled.error) throw new Error(JSON.stringify(cancelled.error));
		if (table.ids().length !== 1) throw new Error('Cancel created a row');
		await bounded('close resources', Promise.all([app.close(), blobs.close()]));
		const reopened = await bounded(
			'reopen blobs',
			openLocalBlobs({ id: application.id }),
		);
		const persisted = await bounded(
			'persisted read',
			reopened.get(stopped.data.blobId),
		);
		if (persisted.error) throw new Error(JSON.stringify(persisted.error));
		const digest = (blob: Blob) =>
			blob
				.arrayBuffer()
				.then((buffer) => crypto.subtle.digest('SHA-256', buffer))
				.then((hash) => new Uint8Array(hash).join(','));
		if ((await digest(persisted.data)) !== (await digest(bytes.data)))
			throw new Error('Reopened recording bytes differ');
		await bounded('close reopened app', reopened.close());
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
			reopened: true,
			scope: 'local',
			offlinePlayback: true,
		};
	});
	console.log(JSON.stringify(result));
} finally {
	await browser.close();
	await server.close();
}
