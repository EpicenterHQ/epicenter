import { chromium } from 'playwright';

import { createServer } from 'vite';

// The complete browser runtime uses real IndexedDB and its SQLite worker.
// Chromium supplies synthetic microphone input to the real MediaRecorder.
const server = await createServer({
	configFile: false,
	optimizeDeps: {
		entries: [
			'packages/app/src/index.ts',
			'packages/device/src/browser-sqlite.worker.ts',
		],
	},
	root: new URL('../../../', import.meta.url).pathname,
	server: { host: '127.0.0.1', port: 0 },
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
		const dataModule = '/packages/data/src/definition/index.ts';
		const { defineApplication }: typeof import('../src/index.js') =
			await import(appModule);
		const {
			defineData,
			defineTable,
			field,
		}: typeof import('@epicenter/data/definition') = await import(dataModule);
		const application = defineApplication({
			appId: 'so.epicenter.recording-smoke',
			definition: defineData({
				id: 'so.epicenter.recording-smoke',
				tables: { recordings: defineTable({ audio: field.attachment() }) },
				kv: {},
			}),
		});
		const app = application.openLocal();
		const ready = await bounded('app ready', app.ready);
		if (ready.error) throw new Error(JSON.stringify(ready.error));
		await (
			globalThis as unknown as { disconnectForAcceptance(): Promise<void> }
		).disconnectForAcceptance();
		const row = app.tables.recordings.create({ audio: null });
		const into = app.tables.recordings.attachment(row.id);
		const started = await bounded('start', app.recording.start({ into }));
		if (started.error) throw new Error(JSON.stringify(started.error));
		const rejected = await app.recording.start({ into });
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
		const bytes = await bounded('read', into.read());
		if (bytes.error) throw new Error(JSON.stringify(bytes.error));
		const playback = await into.source();
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
		const nextRow = app.tables.recordings.create({ audio: null });
		const nextInto = app.tables.recordings.attachment(nextRow.id);
		const next = await bounded(
			'restart',
			app.recording.start({ into: nextInto }),
		);
		if (next.error) throw new Error(JSON.stringify(next.error));
		const cancelled = await bounded('cancel', next.data.cancel());
		if (cancelled.error) throw new Error(JSON.stringify(cancelled.error));
		const absent = await nextInto.read();
		if (absent.error?.name !== 'Unavailable')
			throw new Error('Cancel published audio');
		await bounded('close app', app.close());
		const reopened = application.openLocal();
		const reopenedReady = await bounded('reopen ready', reopened.ready);
		if (reopenedReady.error)
			throw new Error(JSON.stringify(reopenedReady.error));
		const persisted = await bounded(
			'persisted read',
			reopened.tables.recordings.attachment(row.id).read(),
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
