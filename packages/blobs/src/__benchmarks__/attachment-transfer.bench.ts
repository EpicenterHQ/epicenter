/** Run each size in a fresh process to compare incremental RSS with file size. */
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unwrap } from 'wellcrafted/result';
import { attachmentStorageId } from '../attachment-key.js';
import { createBunBlobStore } from '../bun.js';

const size = Number(Bun.argv[2] ?? 172_800_044);
if (!Number.isSafeInteger(size) || size < 0 || size > 5 * 1024 ** 3)
	throw new Error('Invalid size');
const chunk = new Uint8Array(64 * 1024).fill(42);
const hash = createHash('sha256');
for (let offset = 0; offset < size; offset += chunk.length)
	hash.update(chunk.subarray(0, Math.min(chunk.length, size - offset)));
const expected = { sha256: hash.digest('hex'), size, contentType: 'audio/wav' };
const directory = await mkdtemp(join(tmpdir(), 'attachment-memory-'));
const fixturePath = join(directory, 'http-fixture');
const fixture = await open(fixturePath, 'wx');
for (let offset = 0; offset < size; offset += chunk.length)
	await fixture.write(chunk.subarray(0, Math.min(chunk.length, size - offset)));
await fixture.close();
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	maxRequestBodySize: size + 1,
	async fetch(request) {
		if (request.method === 'PUT') {
			const reader = request.body!.getReader();
			while (!(await reader.read()).done) {
				/* Drain without retaining bytes. */
			}
			return new Response(null, { status: 204 });
		}
		return new Response(Bun.file(fixturePath), {
			headers: { 'content-type': expected.contentType },
		});
	},
});
Bun.gc(true);
const baseline = process.memoryUsage.rss();
let peak = baseline;
const interval = setInterval(() => {
	peak = Math.max(peak, process.memoryUsage.rss());
}, 2);
const started = performance.now();
try {
	const store = createBunBlobStore({ directory });
	const id = attachmentStorageId('recordings', 'a'.repeat(24));
	const signal = new AbortController().signal;
	unwrap(
		await store.attachments.download(
			id,
			expected,
			{ url: server.url.href },
			signal,
		),
	);
	console.log(
		JSON.stringify({ phase: 'download', rss: process.memoryUsage.rss(), peak }),
	);
	unwrap(
		await store.attachments.upload(
			id,
			expected,
			{
				url: server.url.href,
				requiredHeaders: {
					'content-type': expected.contentType,
					'if-none-match': '*',
				},
			},
			signal,
		),
	);
	peak = Math.max(peak, process.memoryUsage.rss());
	console.log(
		JSON.stringify({
			size,
			baselineRss: baseline,
			peakRss: peak,
			incrementalRss: peak - baseline,
			elapsedMs: Math.round(performance.now() - started),
			note: 'One process includes HTTP fixture and adapter; 2ms sampling, not an allocator ceiling.',
		}),
	);
} finally {
	clearInterval(interval);
	await server.stop(true);
	await rm(directory, { recursive: true, force: true });
}
