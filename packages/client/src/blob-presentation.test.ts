/** Private presentation observes early cancellation and distinguishes failed cleanup from an errored stream. */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { openBlobPresentation } from './blob-presentation.js';

test('cancellation reaches stalled headers and real AbortError cleanup failures remain visible', async () => {
	const worker = {
		postMessage(message: string, ports: MessagePort[]) {
			ports[0]!.postMessage(message);
		},
	};
	const service = Object.assign(new EventTarget(), { controller: worker });
	const navigatorBefore = Object.getOwnPropertyDescriptor(
		globalThis,
		'navigator',
	);
	const locationBefore = Object.getOwnPropertyDescriptor(
		globalThis,
		'location',
	);
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: { serviceWorker: service },
	});
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: { origin: 'https://page.test' },
	});
	function request(url: string) {
		const channel = new MessageChannel();
		const event = new MessageEvent('message', {
			data: {
				protocol: 'epicenter-blob-presentation-v1',
				token: url.split('/').at(-1),
				method: 'GET',
				range: null,
			},
			ports: [channel.port2],
		});
		Object.defineProperty(event, 'source', { value: worker });
		service.dispatchEvent(event);
		return channel.port1;
	}
	const head = () =>
		new Response(null, { headers: { etag: '"v1"', 'content-length': '1' } });
	try {
		const started = Promise.withResolvers<AbortSignal>();
		const fetcher: Account['fetch'] = async (_input, init) => {
			if (init?.method === 'HEAD') return head();
			started.resolve(init!.signal!);
			return new Promise((_resolve, reject) =>
				init!.signal!.addEventListener(
					'abort',
					() => reject(init!.signal!.reason),
					{ once: true },
				),
			);
		};
		const source = await openBlobPresentation(
			fetcher,
			'https://api.test/object',
		);
		const port = request(source.url);
		const signal = await started.promise;
		port.postMessage('cancel');
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(signal.aborted).toBe(true);
		await source[Symbol.asyncDispose]();
		port.close();
		for (const failure of [
			new DOMException('Real cleanup failed', 'AbortError'),
			undefined,
		]) {
			const broken = await openBlobPresentation(
				async (_input, init) =>
					init?.method === 'HEAD'
						? head()
						: new Response(
								new ReadableStream({
									cancel() {
										throw failure;
									},
								}),
								{ headers: { etag: '"v1"', 'content-length': '1' } },
							),
				'https://api.test/object',
			);
			const response = request(broken.url);
			await new Promise<void>((resolve) => {
				response.onmessage = () => resolve();
			});
			await expect(broken[Symbol.asyncDispose]()).rejects.toThrow(
				'Blob presentation cleanup failed',
			);
			response.close();
		}
	} finally {
		if (navigatorBefore)
			Object.defineProperty(globalThis, 'navigator', navigatorBefore);
		else Reflect.deleteProperty(globalThis, 'navigator');
		if (locationBefore)
			Object.defineProperty(globalThis, 'location', locationBefore);
		else Reflect.deleteProperty(globalThis, 'location');
	}
});
