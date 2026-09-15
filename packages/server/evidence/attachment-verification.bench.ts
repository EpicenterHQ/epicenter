/**
 * Measures the provisional finalization hash through actual workerd HTTP reads.
 * This is runtime cost evidence, not authenticated publication acceptance.
 * Run from packages/server: bun evidence/attachment-verification.bench.ts
 */
import { Miniflare } from 'miniflare';
import { createServer } from 'node:http';
import { once } from 'node:events';

const chunk = new Uint8Array(65_536).fill(19);
let maxQueuedSourceBytes = 0;
const source = createServer((request, response) => {
	void (async () => {
		let remaining = Number(
			new URL(request.url!, 'http://localhost').searchParams.get('size'),
		);
		response.setHeader('content-type', 'audio/wav');
		while (remaining > 0) {
			const length = Math.min(remaining, chunk.length);
			const writable = response.write(chunk.subarray(0, length));
			maxQueuedSourceBytes = Math.max(
				maxQueuedSourceBytes,
				response.writableLength,
			);
			remaining -= length;
			if (!writable) await once(response, 'drain');
		}
		response.end();
	})().catch((cause) => response.destroy(cause));
});
source.listen(0, '127.0.0.1');
await once(source, 'listening');
const address = source.address();
if (!address || typeof address === 'string')
	throw new Error('Expected HTTP address');
const sourceURL = `http://127.0.0.1:${address.port}/`;
const built = await Bun.build({
	entrypoints: [
		new URL('../src/store-sync/attachment-transfer.ts', import.meta.url)
			.pathname,
	],
	target: 'node',
	external: ['node:crypto'],
	write: false,
});
if (!built.success) throw new Error(String(built.logs));
const bundle = (await built.outputs[0]!.text()).replaceAll(
	'catch {',
	'catch (cause) { console.error(cause);',
);
const script =
	bundle +
	`
let stats = { bytes: 0, maxChunk: 0 };
let wantedSize = 0;
const transfer = createAttachmentTransfer({
  library: 'library',
  authority: {
    attachments: { read() { return { status: 'missing' }; }, publish() { return 'accepted'; } },
    bind() { return { admission() { return { error: null }; } }; }
  },
  store: { async presignGet() { return '${sourceURL}?size=' + wantedSize; } },
  fetch: async (url, init) => {
    const response = await fetch(url, init);
    const reader = response.body.getReader();
    return new Response(new ReadableStream({
      async pull(controller) {
        const part = await reader.read();
        if (part.done) { controller.close(); return; }
        stats.bytes += part.value.length;
        stats.maxChunk = Math.max(stats.maxChunk, part.value.length);
        controller.enqueue(part.value);
      },
      cancel(reason) { return reader.cancel(reason); }
    }), { headers: response.headers, status: response.status });
  }
});
export default {
  async fetch(request) {
    if (request.method === 'GET') return Response.json(stats);
    const content = await request.json();
    wantedSize = content.size;
    return transfer(new Request(request.url, {
      method: 'PUT', body: JSON.stringify({ generation: 1, content })
    }), 'recordings', 'aaaaaaaaaaaaaaaaaaaaaaaa');
  }
};`;
const runtime = new Miniflare({
	modules: true,
	compatibilityDate: '2026-04-01',
	compatibilityFlags: ['nodejs_compat'],
	inspectorPort: 0,
	script,
});
await runtime.ready;
const inspectorURL = await runtime.getInspectorURL();
inspectorURL.protocol = 'http:';
const targets = (await (
	await fetch(new URL('/json', inspectorURL))
).json()) as { id: string; webSocketDebuggerUrl: string }[];
const target = targets.find(({ id }) => id.startsWith('core:user:'));
if (!target) throw new Error('No application worker inspector');
const inspector = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
	inspector.onopen = () => resolve();
	inspector.onerror = reject;
});
let requestId = 0;
let samples = 0;
let sampledPeakAllocatedBytes = 0;
inspector.onmessage = (event) => {
	const message = JSON.parse(String(event.data)) as {
		result?: {
			totalSize: number;
			embedderHeapUsedSize: number;
			backingStorageSize: number;
		};
	};
	if (!message.result) return;
	samples++;
	const { totalSize, embedderHeapUsedSize, backingStorageSize } =
		message.result;
	sampledPeakAllocatedBytes = Math.max(
		sampledPeakAllocatedBytes,
		totalSize + embedderHeapUsedSize + backingStorageSize,
	);
};
const sampling = setInterval(
	() =>
		inspector.send(
			JSON.stringify({ id: ++requestId, method: 'Runtime.getHeapUsage' }),
		),
	100,
);
try {
	for (const size of [172_800_044, 5 * 1024 ** 3]) {
		samples = 0;
		sampledPeakAllocatedBytes = 0;
		const hash = new Bun.CryptoHasher('sha256');
		for (let offset = 0; offset < size; offset += chunk.length)
			hash.update(chunk.subarray(0, Math.min(chunk.length, size - offset)));
		const content = {
			sha256: hash.digest('hex'),
			size,
			contentType: 'audio/wav',
		};
		const begin = performance.now();
		const responses = await Promise.all(
			[1, 2].map(() =>
				runtime.dispatchFetch('http://localhost/verify', {
					method: 'PUT',
					body: JSON.stringify(content),
				}),
			),
		);
		console.log(
			JSON.stringify({
				size,
				concurrent: 2,
				status: responses.map((response) => response.status),
				maxQueuedSourceBytes,
				samples,
				sampledPeakAllocatedBytes,
				elapsedMs: Math.round(performance.now() - begin),
				stats: await (
					await runtime.dispatchFetch('http://localhost/stats')
				).json(),
			}),
		);
		if (responses.some((response) => response.status !== 204))
			throw new Error('Verification failed');
	}
} finally {
	clearInterval(sampling);
	inspector.close();
	await runtime.dispose();
	const closed = new Promise<void>((resolve, reject) =>
		source.close((error) => (error ? reject(error) : resolve())),
	);
	source.closeAllConnections();
	await closed;
}
