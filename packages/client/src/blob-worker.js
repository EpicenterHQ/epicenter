/** Private presentation transport. Serve at the origin root and register with scope '/'. */
const protocol = 'epicenter-blob-presentation-v1';
const prefix = '/_epicenter/blob-presentation/';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
	event.waitUntil(self.clients.claim()),
);
self.addEventListener('message', (event) => {
	if (event.data === protocol) event.ports[0]?.postMessage(protocol);
});
self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix))
		return;
	event.respondWith(
		(async () => {
			const gone = () =>
				new Response(null, {
					status: 410,
					headers: { 'cache-control': 'no-store' },
				});
			// Navigation and other documents cannot redeem a source acquired by this page.
			if (
				!event.clientId ||
				event.request.mode === 'navigate' ||
				url.search ||
				!['GET', 'HEAD'].includes(event.request.method)
			)
				return gone();
			const client = await self.clients.get(event.clientId);
			if (!client) return gone();
			const { port1: port, port2 } = new MessageChannel();
			let finished = false;
			function close() {
				if (finished) return;
				finished = true;
				port.postMessage('cancel');
				port.close();
			}
			function receive() {
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						close();
						reject(new Error('Presentation page unavailable'));
					}, 10000);
					port.onmessage = ({ data }) => {
						clearTimeout(timer);
						resolve(data);
					};
					port.onmessageerror = () => {
						clearTimeout(timer);
						close();
						reject(new Error('Presentation message failed'));
					};
				});
			}
			const ready = receive();
			client.postMessage(
				{
					protocol,
					token: url.pathname.slice(prefix.length),
					method: event.request.method,
					range: event.request.headers.get('range'),
				},
				[port2],
			);
			try {
				const head = await ready;
				if (!head.body) {
					close();
					return new Response(null, head);
				}
				const stream = new ReadableStream({
					async pull(controller) {
						try {
							const next = receive();
							port.postMessage('pull');
							const data = await next;
							if (data.error) throw new Error(data.error);
							if (data.done) {
								controller.close();
								close();
							} else controller.enqueue(data.chunk);
						} catch (cause) {
							controller.error(cause);
							close();
						}
					},
					cancel: close,
				});
				return new Response(stream, head);
			} catch {
				close();
				return gone();
			}
		})(),
	);
});
