import type { Account } from '@epicenter/auth';

const protocol = 'epicenter-blob-presentation-v1';
const prefix = '/_epicenter/blob-presentation/';
const lifetimeMs = 5 * 60 * 1000;
const presentations = new Map<string, (event: MessageEvent) => void>();
let listening = false;
function route(event: MessageEvent) {
	if (event.data?.protocol !== protocol) return;
	const receive = presentations.get(event.data.token);
	if (receive) receive(event);
	else {
		event.ports[0]?.postMessage({ status: 410, body: false });
		event.ports[0]?.close();
	}
}

/** One page-owned, version-pinned acquisition. The worker never owns authority or bytes. */
export async function openBlobPresentation(
	accountFetch: Account['fetch'],
	objectUrl: string,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const worker = globalThis.navigator?.serviceWorker?.controller;
	if (!worker)
		throw new Error(
			'Private blob presentation requires the Epicenter blob service worker.',
		);
	await new Promise<void>((resolve, reject) => {
		const channel = new MessageChannel();
		const timer = setTimeout(() => {
			channel.port1.close();
			reject(new Error('Blob service worker did not answer'));
		}, 2000);
		channel.port1.onmessage = ({ data }) => {
			clearTimeout(timer);
			channel.port1.close();
			if (data === protocol) resolve();
			else reject(new Error('Incompatible blob service worker'));
		};
		worker.postMessage(protocol, [channel.port2]);
	});
	const head = await accountFetch(objectUrl, {
		method: 'HEAD',
		signal,
		redirect: 'error',
		cache: 'no-store',
	});
	await head.body?.cancel();
	const version = head.headers.get('etag');
	const length = head.headers.get('content-length');
	if (
		head.status !== 200 ||
		!version ||
		version.startsWith('W/') ||
		!/^"[^"\r\n]*"$/.test(version) ||
		length === null ||
		!/^\d+$/.test(length) ||
		!Number.isSafeInteger(Number(length))
	)
		throw new Error(
			'Blob presentation requires a strong version and exact length.',
		);
	signal?.throwIfAborted();
	const token = crypto.randomUUID();
	const lifetime = new AbortController();
	const combined = signal
		? AbortSignal.any([signal, lifetime.signal])
		: lifetime.signal;
	const requests = new Set<Promise<void>>();
	const failures: unknown[] = [];
	const expiredAt = Date.now() + lifetimeMs;
	const timer = setTimeout(dispose, lifetimeMs);
	let disposed = false;
	function dispose() {
		if (disposed) return;
		disposed = true;
		clearTimeout(timer);
		lifetime.abort();
		presentations.delete(token);
		combined.removeEventListener('abort', dispose);
	}
	function receive(event: MessageEvent) {
		const message = event.data;
		if (
			event.source !== worker ||
			message?.protocol !== protocol ||
			message.token !== token
		) {
			event.ports[0]?.postMessage({ status: 410, body: false });
			event.ports[0]?.close();
			return;
		}
		const port = event.ports[0];
		if (!port) return;
		const pending = serve(port, message);
		requests.add(pending);
		void pending.then(
			() => requests.delete(pending),
			(cause) => {
				failures.push(cause);
				requests.delete(pending);
			},
		);
	}
	async function serve(
		port: MessagePort,
		message: { method: string; range: string | null },
	) {
		const cancelled = new AbortController();
		const requestSignal = AbortSignal.any([combined, cancelled.signal]);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let idle: ReturnType<typeof setTimeout> | undefined;
		const complete = Promise.withResolvers<void>();
		const abort = () => complete.resolve();
		requestSignal.addEventListener('abort', abort, { once: true });
		port.onmessage = ({ data }) => {
			if (data === 'cancel') cancelled.abort();
		};
		idle = setTimeout(() => cancelled.abort(), 15000);
		try {
			if (
				disposed ||
				Date.now() >= expiredAt ||
				!['GET', 'HEAD'].includes(message.method)
			)
				throw new Error('Presentation expired');
			requestSignal.throwIfAborted();
			const headers = new Headers({ 'if-match': version! });
			if (message.range !== null) {
				if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(message.range))
					throw new Error('Invalid byte range');
				headers.set('range', message.range);
			}
			// Every later request reuses the original captured Account, never current auth state.
			const response = await accountFetch(objectUrl, {
				method: message.method,
				headers,
				signal: requestSignal,
				redirect: 'error',
				cache: 'no-store',
			});
			reader = response.body?.getReader();
			if (![200, 206, 416].includes(response.status))
				throw new Error('Blob authorization or version changed');
			if (response.ok && response.headers.get('etag') !== version)
				throw new Error('Blob version changed');
			const size = response.headers.get('content-length');
			const range = response.headers.get('content-range');
			let expected = Number(length);
			if (
				response.status === 200 &&
				((size !== null && size !== length) || range !== null)
			)
				throw new Error('Blob length changed');
			if (response.status === 206) {
				const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range ?? '');
				if (
					!match ||
					match[3] !== length ||
					Number(match[2]) < Number(match[1]) ||
					Number(match[2]) >= Number(length) ||
					(size !== null &&
						Number(size) !== Number(match[2]) - Number(match[1]) + 1)
				)
					throw new Error('Inconsistent blob range');
				expected = Number(match[2]) - Number(match[1]) + 1;
			}
			if (response.status === 416 && range !== `bytes */${length}`)
				throw new Error('Inconsistent unsatisfied range');
			const safe = new Headers({
				'cache-control': 'private, no-store',
				'x-content-type-options': 'nosniff',
				'content-disposition': 'attachment',
				'content-security-policy': "sandbox; default-src 'none'",
			});
			for (const name of [
				'content-type',
				'content-length',
				'content-range',
				'accept-ranges',
				'etag',
			]) {
				const value = response.headers.get(name);
				if (value !== null) safe.set(name, value);
			}
			if (response.ok) safe.set('content-length', String(expected));
			const body = !!reader && message.method !== 'HEAD' && response.ok;
			const responseHeaders: Record<string, string> = {};
			safe.forEach((value, name) => {
				responseHeaders[name] = value;
			});
			port.postMessage({
				status: response.status,
				headers: responseHeaders,
				body,
			});
			if (!body) return;
			let pulling = false;
			let received = 0;
			const arm = () => {
				clearTimeout(idle);
				idle = setTimeout(() => cancelled.abort(), 15000);
			};
			port.onmessage = async ({ data }) => {
				if (data === 'cancel') {
					cancelled.abort();
					return;
				}
				if (data !== 'pull' || pulling) return;
				pulling = true;
				arm();
				try {
					requestSignal.throwIfAborted();
					const next = await reader!.read();
					requestSignal.throwIfAborted();
					received += next.value?.byteLength ?? 0;
					if (received > expected || (next.done && received !== expected))
						throw new Error('Blob body length changed');
					port.postMessage({ done: next.done, chunk: next.value });
					if (next.done) complete.resolve();
				} catch {
					port.postMessage({ error: 'Presentation ended' });
					complete.resolve();
				} finally {
					pulling = false;
				}
			};
			arm();
			await complete.promise;
		} catch {
			port.postMessage({ status: 410, body: false });
		} finally {
			clearTimeout(idle);
			requestSignal.removeEventListener('abort', abort);
			try {
				await reader?.cancel();
			} catch (cause) {
				const terminal = await reader!.closed.then(
					() => ({ failed: false as const }),
					(error: unknown) => ({ failed: true as const, error }),
				);
				if (!terminal.failed || cause !== terminal.error) throw cause;
			} finally {
				cancelled.abort();
				reader?.releaseLock();
				port.close();
			}
		}
	}
	if (!listening) {
		listening = true;
		navigator.serviceWorker.addEventListener('message', route);
	}
	presentations.set(token, receive);
	combined.addEventListener('abort', dispose, { once: true });
	return Object.freeze({
		url: new URL(prefix + token, location.origin).href,
		[Symbol.dispose]: dispose,
		async [Symbol.asyncDispose]() {
			dispose();
			await Promise.allSettled(requests);
			if (failures.length)
				throw new AggregateError(failures, 'Blob presentation cleanup failed');
		},
	});
}
