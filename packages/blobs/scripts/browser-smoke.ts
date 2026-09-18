import { chromium, webkit } from 'playwright';

const bundle = await Bun.build({
	entrypoints: [new URL('./browser-smoke-entry.ts', import.meta.url).pathname],
	target: 'browser',
	format: 'esm',
});
if (!bundle.success)
	throw new AggregateError(bundle.logs, 'Could not bundle flat blob fixture.');
const source = await bundle.outputs[0]!.text();
const server = Bun.serve({
	port: 0,
	routes: {
		'/': new Response(
			'<!doctype html><title>Isolated flat blob verification</title>',
		),
		'/blobs.js': new Response(source, {
			headers: { 'content-type': 'text/javascript' },
		}),
	},
});

// Whole browser process tree RSS, including renderer/storage processes. This is
// an observation, not a claim that the engine performs no disk I/O or allocation.
async function residentKiB(root: number) {
	const proc = Bun.spawn(['ps', '-axo', 'pid=,ppid=,rss='], { stdout: 'pipe' });
	const rows = (await new Response(proc.stdout).text())
		.trim()
		.split('\n')
		.map((line) => line.trim().split(/\s+/).map(Number));
	const included = new Set([root]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, parent] of rows)
			if (included.has(parent!) && !included.has(pid!)) {
				included.add(pid!);
				changed = true;
			}
	}
	return rows.reduce(
		(sum, [pid, , rss]) => sum + (included.has(pid!) ? rss! : 0),
		0,
	);
}

try {
	for (const engine of [webkit, chromium]) {
		const browser = await engine.launch();
		try {
			const page = await browser.newPage();
			page.on('console', (message) =>
				console.error(engine.name(), message.text()),
			);
			page.on('pageerror', (error) => console.error(engine.name(), error));
			console.error(engine.name(), 'recording');
			await page.goto(`http://127.0.0.1:${server.port}`);
			const recorded = await page.evaluate(async () => {
				const moduleUrl = '/blobs.js';
				const { createBrowserBlobStore, createBrowserRecording } = await import(
					moduleUrl
				);
				const scope = { appId: `so.epicenter.flat-${crypto.randomUUID()}` };
				const context = new AudioContext();
				await Promise.race([
					context.resume(),
					new Promise((_, reject) =>
						setTimeout(
							() => reject(new Error('AudioContext resume timed out.')),
							10_000,
						),
					),
				]);
				console.log('AudioContext resumed');
				const oscillator = context.createOscillator();
				const output = context.createMediaStreamDestination();
				oscillator.connect(output);
				oscillator.start();
				// Substitute only microphone acquisition: MediaRecorder, App Stop,
				// publication, and playback are the actual browser implementations.
				Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
					configurable: true,
					value: async () => output.stream,
				});
				const store = createBrowserBlobStore(scope);
				let producerType = '';
				const owner = createBrowserRecording(scope.appId, {
					write(id: Parameters<typeof store.put>[0], blob: Blob) {
						producerType = blob.type;
						return store.put(id, blob);
					},
				});
				const started = await owner.value.start({});
				if (started.error) throw new Error(JSON.stringify(started.error));
				await new Promise((resolve) => setTimeout(resolve, 500));
				const saved = await started.data.stop();
				if (saved.error) throw new Error(JSON.stringify(saved.error));
				const id = saved.data.blobId;
				await owner.close();
				oscillator.stop();
				await context.close();
				const loaded = await store.get(id);
				if (loaded.error) throw new Error(JSON.stringify(loaded.error));
				const blob = loaded.data;
				if (!blob.size) throw new Error('Recorder produced no audio.');
				const collision = await store.put(id, blob);
				if (collision.error?.name !== 'BlobAlreadyExists')
					throw new Error('Replacement was not refused.');
				return { scope, id, producerType, size: blob.size };
			});
			await page.reload();
			console.error(engine.name(), 'playback');
			const playback = await page.evaluate(async ({ scope, id, size }) => {
				const moduleUrl = '/blobs.js';
				const {
					createBrowserBlobStore,
					createBrowserBlobSources,
					createAppBlobs,
				} = await import(moduleUrl);
				const store = createBrowserBlobStore(scope);
				const stat = await store.stat(id);
				if (stat.error || stat.data.size !== size)
					throw new Error('Recording did not persist through document reload.');
				const appBlobs = createAppBlobs({
					local: store,
					sources: createBrowserBlobSources(store),
				});
				const opened = await appBlobs.value.open(id);
				if (opened.error) throw new Error(JSON.stringify(opened.error));
				const audio = new Audio(opened.data.url);
				audio.muted = true;
				await audio.play();
				await new Promise<void>((resolve, reject) => {
					audio.onended = () => resolve();
					audio.onerror = () =>
						reject(new Error('Saved recording failed playback.'));
					setTimeout(() => reject(new Error('Playback timeout.')), 10_000);
				});
				audio.removeAttribute('src');
				audio.load();
				opened.data[Symbol.dispose]();
				let revoked = false;
				try {
					await fetch(opened.data.url);
				} catch {
					revoked = true;
				}
				if (!revoked)
					throw new Error('Released playback URL remained readable.');
				await appBlobs.close();
				return stat.data;
			}, recorded);
			console.error(engine.name(), 'populate');
			const count = Number(Bun.env.FLAT_BLOB_COUNT ?? 64);
			const bytesPerBlob = Number(Bun.env.FLAT_BLOB_BYTES ?? 4 * 1024 * 1024);
			await page.evaluate(
				async ({ scope, count, bytesPerBlob }) => {
					const moduleUrl = '/blobs.js';
					const { createBrowserBlobStore, generateBlobId } = await import(
						moduleUrl
					);
					const store = createBrowserBlobStore(scope);
					const bytes = new Uint8Array(bytesPerBlob);
					for (let i = 0; i < bytes.length; i += 65536)
						crypto.getRandomValues(
							bytes.subarray(i, Math.min(i + 65536, bytes.length)),
						);
					const blob = new Blob([bytes]);
					for (let i = 0; i < count; i++) {
						const result = await store.put(generateBlobId('bin'), blob);
						if (result.error) throw new Error(JSON.stringify(result.error));
					}
				},
				{ scope: recorded.scope, count, bytesPerBlob },
			);
			await page.reload();
			const beforeKiB = await residentKiB(process.pid);
			const listing = await page.evaluate(
				async ({ scope, count, expectedBytes }) => {
					const moduleUrl = '/blobs.js';
					const { createBrowserBlobStore } = await import(moduleUrl);
					const store = createBrowserBlobStore(scope);
					// Forbid value-reading APIs during stat/list, including index values.
					const forbid = () => {
						throw new Error('Metadata operation requested a record value.');
					};
					IDBObjectStore.prototype.get = forbid;
					IDBObjectStore.prototype.getAll = forbid;
					IDBObjectStore.prototype.openCursor = forbid;
					IDBIndex.prototype.get = forbid;
					IDBIndex.prototype.getAll = forbid;
					IDBIndex.prototype.openCursor = forbid;
					let cursor: string | undefined;
					let seen = 0,
						bytes = 0;
					const started = performance.now();
					do {
						const result = await store.list({ cursor, limit: 7 });
						if (result.error) throw new Error(JSON.stringify(result.error));
						for (const item of result.data.items) {
							const stat = await store.stat(item.id);
							if (stat.error || stat.data.size !== item.size)
								throw new Error('stat/list disagreement.');
							seen++;
							bytes += item.size;
						}
						cursor = result.data.nextCursor;
					} while (cursor);
					if (seen !== count + 1 || bytes !== expectedBytes)
						throw new Error('Listing lost records or sizes.');
					return {
						count: seen,
						bytes,
						milliseconds: performance.now() - started,
					};
				},
				{
					scope: recorded.scope,
					count,
					expectedBytes: count * bytesPerBlob + recorded.size,
				},
			);
			const afterKiB = await residentKiB(process.pid);
			console.log(
				JSON.stringify({
					engine: engine.name(),
					recording: recorded,
					playback,
					listing,
					memory: {
						beforeKiB,
						afterKiB,
						deltaKiB: afterKiB - beforeKiB,
						scope: 'whole harness and browser process tree RSS',
					},
				}),
			);
		} finally {
			await browser.close();
		}
	}
} finally {
	server.stop(true);
}
